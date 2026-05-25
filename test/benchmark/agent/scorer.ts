/**
 * SOTA++ benchmark scorer (v4 — null-drop scoring, answerRelevancy removed).
 *
 * Scoring dimensions (each 0..1):
 *   - executionEfficiency:    merged tool accuracy + step efficiency to remove
 *                             double-penalty when thrashing inflates both
 *   - answerQuality:          substring contract + Korean-aware matching
 *                             + structured fact / entity grounding
 *   - terminationCorrectness: matches expectation; fallback=0.25 (graceful degradation partial credit);
 *                             expectedBlocked handled symmetrically
 *   - costEfficiency:         max-overshoot of latency + token budgets,
 *                             arithmetic (no sqrt floor) so single blowouts
 *                             aren't double-punished
 *   - judge:                  optional LLM-as-judge rubric score; when
 *                             undefined the dim is DROPPED from the geo-mean
 *                             (no longer biases overall upward)
 *
 * Critical-fail short-circuit: hard violations (mustNotCallTools, expectedBlocked
 * failure, answerExcludes hit, expected entity hallucinated) collapse the
 * overall score to 0 regardless of other dimensions. Geometric mean alone
 * leaks a 0.05–0.10 floor that is wrong for security signal.
 *
 * Per-tier / per-scenario weight overrides supported via scenario.weights.
 *
 * Diagnostics are STRUCTURED ({dim, severity, code, message, observed?, expected?})
 * for downstream dashboards while keeping a string projection for CLI display.
 */

import type {
  AgentBenchmarkScenario,
  ScenarioExpectation,
  TerminationReason,
} from './scenario.js';
import type { DiagnosticVector } from '../../../src/domain/evaluation/model/claim.js';
import type { ToolCallEvidenceFrame } from '../../../src/domain/agent/model/tool-call-evidence-frame.js';
import {
  EXEC_TOOL_WEIGHT as K_EXEC_TOOL_WEIGHT,
  EXEC_STEP_WEIGHT as K_EXEC_STEP_WEIGHT,
  FAITHFULNESS_PER_SCENARIO_WARN,
} from './constants.js';
import {
  clamp01,
  DIMENSION_FLOOR,
  NO_FLOOR_DIMS,
  renormaliseWeights,
  weightedGeometricMean,
} from './scorer-aggregation.js';
import {
  extractKoreanPrices,
  extractVintageYears,
  extractProperNouns,
} from './scorer-text-extractors.js';
import { scoreCostEfficiency } from './scorer-cost-efficiency.js';
import { emitKoreanClrDiagnostic } from './scorer-korean-clr.js';
import {
  isHonestNoEvidenceAbstentionScenario,
  normalizeObservations,
} from './scorer-abstention.js';
import { scoreExactLookupContract } from './scorer-exact-lookup-contract.js';
import { scoreTermination } from './scorer-termination.js';
import { scoreContextRecall } from './scorer-context-recall.js';
import { evaluatePredicate, formatToolArgValue, getNestedValue } from './scorer-predicate-eval.js';
import { scoreStepEfficiency } from './scorer-step-efficiency.js';
import { scoreToolAccuracy } from './scorer-tool-accuracy.js';
import { scoreContextRelevance } from './scorer-context-relevance.js';
import { scoreAnswerQuality } from './scorer-answer-quality.js';

export interface ToolCallTrace {
  readonly tool: string;
  /** Stringified input for inputContains substring matching. */
  readonly input?: string;
}

// stableJsonStringify / getToolCallSemanticSignature / countSemanticToolInvocations
// moved to ./scorer-tool-call-signatures.ts during the 2026-05-25 decomposition.
// Imported above; consumed by toolAccuracy scoring and formatToolArgValue.



/**
 * Per-step trace captured from an AgentStep for triage / profiling.
 * Mirrors AgentStep but with tool inputs typed as Record<string,unknown>
 * (runner JSON.parses the stringified input before passing here).
 */
export interface StepTrace {
  readonly index: number;
  readonly thought: string;
  // sequential
  readonly action?: { readonly tool: string; readonly input: Record<string, unknown> };
  readonly observation?: string;
  // parallel
  readonly actions?: ReadonlyArray<{ readonly tool: string; readonly input: Record<string, unknown> }>;
  readonly observations?: readonly string[];
  // answer step
  readonly answer?: string;
  readonly durationMs: number;
  readonly tokenCount: { readonly input: number; readonly output: number };
}

export interface ScenarioExecution {
  readonly answer: string;
  readonly stepCount: number;
  readonly toolCallCount: number;
  readonly toolsUsed: readonly ToolCallTrace[];
  /** Raw observation strings from each tool call step (used by grounding checks). */
  readonly observations: readonly string[];
  /** Typed tool evidence frames. Claim evaluation must prefer this over observation reparsing. */
  readonly evidenceFrames?: readonly ToolCallEvidenceFrame[] | undefined;
  readonly terminationReason: TerminationReason;
  readonly totalDurationMs: number;
  /**
   * S1.1 measurement integrity: per-scenario wall MINUS time spent sleeping on
   * throttle/transient-infra backoff (429/503/GOAWAY/ECONNRESET retries). This
   * is the agent's actual work time. The latency/cost dimension scores against
   * this, NOT `totalDurationMs`, so provider throttling never penalizes the
   * agent. Absent for legacy callers — scoring falls back to `totalDurationMs`.
   */
  readonly agentWorkMs?: number | undefined;
  /** S1.1: cumulative ms spent sleeping on throttle/transient-infra backoff. */
  readonly throttleWaitMs?: number | undefined;
  readonly totalTokens: { input: number; output: number };
  /**
   * ADR-009 Phase 0: number of tool calls that emitted a typed evidence frame.
   * `evidenceFrameCount / toolCallCount` is the per-scenario frame coverage;
   * the bench summary aggregates this into `evidenceFrameCoverage`.
   */
  readonly evidenceFrameCount?: number | undefined;
  /**
   * Per-pipeline-stage timing snapshot from the first successful search call.
   * Keys are stage names (e.g. 'search.total', 'retrieval.parallel_fanout',
   * 'retrieval.dense_semantic'). Values are elapsed ms (performance.now precision).
   * Absent when no search tool call produced stageTimings.
   */
  readonly stageTimings?: Readonly<Record<string, number>> | undefined;
  /**
   * Planner-emitted hard constraints summed across every search tool call in
   * the scenario. Source: `SearchResponseV1.parsedConstraints.hard.length`
   * across all `result.toolOutcomes` whose `result` is a `SearchResponseV1`.
   *
   * `null` when the scenario produced no search tool outcomes (knowledge-only,
   * blocked, or fallback paths). `0` when search ran but the planner emitted
   * zero hard constraints — that is a real "under-filtered retrieval" signal,
   * not missing data. The bench summary aggregates non-null values into
   * `summary.meanHardConstraints` (consumed by the `hard_constraints_low`
   * insight rule).
   */
  readonly hardConstraintCount?: number | null | undefined;
}

// normalizeObservations / hasExplicitNoEvidenceObservation /
// isHonestNoEvidenceAbstentionScenario moved to ./scorer-abstention.ts during
// the 2026-05-25/26 decomposition (round 8.2). Imported above; re-exported below.
export { normalizeObservations };

export type DiagnosticSeverity = 'info' | 'warn' | 'critical';
// v4: 'answerRelevancy' removed — dimension is always null, weight=0, no code emits
// diagnostics with that dim. Keeping it would allow accidental misuse.
export type DiagnosticDim =
  | 'executionEfficiency'
  | 'toolAccuracy'
  | 'stepEfficiency'
  | 'answerQuality'
  | 'terminationCorrectness'
  | 'costEfficiency'
  | 'faithfulness'
  | 'contextRelevance'
  | 'contextRecall'
  | 'judge';

export interface Diagnostic {
  readonly dim: DiagnosticDim;
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly observed?: string | number;
  readonly expected?: string | number;
}

export interface ScenarioScores {
  readonly executionEfficiency: number;
  readonly toolAccuracy: number; // sub-component, kept for visibility
  readonly stepEfficiency: number; // sub-component, kept for visibility
  readonly answerQuality: number;
  readonly terminationCorrectness: number;
  readonly costEfficiency: number;
  /**
   * RAGAS Faithfulness: fraction of answer claims grounded in tool results.
   * null when no observations available (no tool calls made).
   */
  readonly faithfulness: number | null;
  /**
   * RAGAS Context Relevance: fraction of tool results that are relevant to
   * the query constraints (keyword/rule-based). null when no structured
   * constraints to check or no observations available.
   */
  readonly contextRelevance: number | null;
  /**
   * RAGAS Context Recall: fraction of goldenKeywords that appeared in agent
   * observations. null when scenario has no goldenKeywords or no observations.
   */
  readonly contextRecall: number | null;
  /** Exact lookup hit rate for transliteration exact-entity scenarios. */
  readonly exactLookupHit: number | null;
  /** Fail-closed correctness for ambiguous / negative exact-lookup scenarios. */
  readonly failClosedAccuracy: number | null;
  /**
   * RAGAS Answer Relevancy: always null in SOTA++ v4 — dimension removed from scoring.
   * answerMustMatch patterns penalize answerQuality via PENALTY_REGEX_MISS instead.
   * Retained in the schema for diagnostic visibility; weight=0 in all tiers.
   */
  readonly answerRelevancy: null;
  readonly judge: number | null; // null when judge disabled
  readonly overall: number;
  /** True when a hard / critical violation collapsed overall to 0. */
  readonly criticalFailure: boolean;

  // ── RFC-020 constraint extraction metrics ───────────────────────
  /** Semantic Constraint Recall (P1) — weighted bucket mean [0,1]. null when no expectedConstraints. */
  readonly semanticConstraintRecall: number | null;
  /** SCR hard bucket [0,1] or null. */
  readonly scrHard: number | null;
  /** SCR soft bucket [0,1] or null. */
  readonly scrSoft: number | null;
  /** SCR inferred bucket [0,1] or null. */
  readonly scrInferred: number | null;
  /**
   * ADR-011 PR2 dual-emit: graph-aware inferred recall. `null` when no graph
   * or no expected inferred bucket. Trivial graph = `scrInferred` byte-for-byte.
   */
  readonly scrInferredGraph: number | null;
  /** Entity Linking Accuracy @1 (P2). null when no expectedEntities. */
  readonly entityLinkingAccuracy: number | null;
  /** Slot F1 entity-level strict mode (P3). null when no expectedConstraints. */
  readonly slotF1Strict: number | null;
  /** Slot F1 entity-level relaxed mode (P3). null when no expectedConstraints. */
  readonly slotF1Relaxed: number | null;
  /** Constraint Satisfaction Rate weighted overall (P4). null when no observations or no constraints. */
  readonly csrOverall: number | null;
  /** CSR hard tier (P4). null when no hard constraints or no observations. */
  readonly csrHard: number | null;
  /** CSR soft tier (P4). null when no soft constraints or no observations. */
  readonly csrSoft: number | null;
  /** CSR inferred tier (P4). null when no inferred constraints or no observations. */
  readonly csrInferred: number | null;
  /**
   * ADR-011 PR2 dual-emit: graph-aware inferred satisfaction. `null` when no
   * graph or no extracted inferred constraints. Trivial graph = `csrInferred`
   * byte-for-byte.
   */
  readonly csrInferredGraph: number | null;
  /**
   * Number of hard constraints the NL Mapper extracted for this query
   * (`runConstraintExtraction(query).bundle.hard.length`). Used by the
   * run-level `meanHardConstraints` aggregate (was previously hardcoded `0`
   * with a TODO comment — see ConstraintExtractionMetricsInput docs).
   *
   * `null` when constraint extraction was not run for the scenario.
   */
  readonly extractedHardConstraintCount: number | null;
}

/**
 * Provenance record attached to every aggregate metric in `BenchmarkReport.summary.provenance`.
 *
 * Each entry traces a reported aggregate back to:
 *   - `aggregateName`  — the key under `summary.*` (e.g. "overallScore", "scrHard").
 *   - `sourceField`    — the per-scenario field consumed (e.g. "scores.overall", "scores.scrHard").
 *                        Use the magic string `'__scenario_count__'` for cardinality counters
 *                        that don't derive from a scenario-level field.
 *   - `derivationSummary` — one-line human-readable formula
 *                        (e.g. "geo-mean over executed scenarios", "5%-trimmed geo-mean").
 *
 * Contract test (`test/regression/scorer-no-hardcoded-aggregate.regression.test.ts`)
 * asserts:
 *   1. Every numeric aggregate in `BenchmarkReport.summary` has a provenance entry.
 *   2. `derivationSummary` MUST NOT contain the substring "TODO" — that was the
 *      exact failure mode that hid `meanHardConstraints = 0` for sessions.
 *   3. `sourceField` either references a real `ScenarioExecution`/`ScenarioScores`
 *      field via dot-notation or equals the documented magic strings.
 */
export interface MetricProvenance {
  readonly aggregateName: string;
  readonly sourceField: string;
  readonly derivationSummary: string;
}

export interface ScenarioResult {
  readonly id: number;
  readonly tier: string;
  readonly query: string;
  readonly skipped: boolean;
  readonly skipReason?: string;
  readonly answer?: string;
  readonly stepCount?: number;
  readonly toolCallCount?: number;
  readonly toolsUsed?: readonly string[];
  readonly terminationReason?: string;
  readonly totalDurationMs?: number;
  /**
   * S1.1: agent work time (scenario wall minus throttle/backoff wait). This is
   * what the latency/cost dimension scores against AND what drives the bench
   * summary's SLA gate. Omitted for skipped/errored scenarios. May equal
   * `totalDurationMs` when no throttling occurred.
   */
  readonly agentWorkMs?: number;
  /** S1.1: cumulative ms spent sleeping on throttle/transient-infra backoff. */
  readonly throttleWaitMs?: number;
  readonly totalTokens?: { input: number; output: number };
  /**
   * ADR-009 Phase 0: count of tool calls that emitted a typed evidence frame.
   * The top-level summary divides sum(evidenceFrameCount) by sum(toolCallCount)
   * to compute the cutover-gate `evidenceFrameCoverage`.
   */
  readonly evidenceFrameCount?: number;
  /**
   * Planner-emitted hard constraints summed across every search tool call.
   * See {@link ScenarioExecution.hardConstraintCount} for full semantics.
   * `null` for scenarios with no search outcomes; `0` for scenarios where
   * search ran but the planner emitted zero hard constraints.
   *
   * The bench summary computes `summary.meanHardConstraints` as the arithmetic
   * mean over scenarios with non-null values.
   */
  readonly hardConstraintCount?: number | null;
  readonly error?: string;
  readonly scores: ScenarioScores;
  readonly diagnostics?: readonly Diagnostic[];
  /** Compact human-readable diagnostic strings for CLI display. */
  readonly diagnosticStrings?: readonly string[];
  /** True when judgeRequired=true and judge was not run (--no-judge mode). */
  readonly judgeRequiredButSkipped: boolean;
  /**
   * Per-step trace for triage: thought, tool calls with inputs, observations.
   * Omitted for skipped/errored scenarios and when no steps were provided.
   */
  readonly steps?: readonly StepTrace[];
  /**
   * Rationale string from the LLM judge (closest-to-median sample).
   * Omitted when judge was not run or failed.
   */
  readonly judgeReasoning?: string;
  /**
   * Claim-level diagnostic vector (RFC-020 SOTA++).
   * Provides per-claim verdict breakdown, contradiction rate, critical error rate,
   * provenance coverage, and per-category aggregates.
   *
   * Shadow-mode in current release: populated when the benchmark runner
   * invokes the claim-level evaluator alongside the existing scorer; does
   * NOT yet feed into the geometric mean. Phase 2 will split faithfulness
   * into claim-grounded faithfulness + accuracy dimensions.
   *
   * Omitted when claim-level evaluation is disabled or fails.
   */
  readonly claimDiagnostics?: DiagnosticVector;
  /**
   * SOTA++ multi-sample (B1): per-run snapshots captured under `--runs N`.
   * Absent when N === 1 (legacy single-run shape preserved).
   */
  readonly runs?: readonly ScenarioRun[];
  /**
   * SOTA++ multi-sample (B1): per-dimension aggregates across N runs.
   * Absent when N === 1.
   */
  readonly aggregates?: ScenarioAggregates;
}

/**
 * SOTA++ multi-sample (B1): single-run snapshot for a scenario.
 *
 * Captured when the runner is invoked with `--runs N` (N >= 2). The shape
 * is intentionally flat so JSON reports can be diff'd line-by-line across
 * runs without nested object reshuffling.
 */
export interface ScenarioRun {
  readonly runIndex: number;
  readonly overall: number;
  readonly executionEfficiency: number;
  readonly toolAccuracy: number;
  readonly stepEfficiency: number;
  readonly answerQuality: number;
  readonly terminationCorrectness: number;
  readonly costEfficiency: number;
  readonly judge: number | null;
  readonly faithfulness: number | null;
  readonly totalDurationMs: number;
  readonly totalTokensInput: number;
  readonly totalTokensOutput: number;
  readonly terminationReason: string;
  readonly criticalFailure: boolean;
}

/**
 * SOTA++ multi-sample (B1): summary stats over a numeric series of N runs.
 * `stdev` uses Bessel correction (n−1 denominator). `n=1` yields stdev=0.
 */
export interface ScenarioRunAggregates {
  readonly mean: number;
  readonly stdev: number;
  readonly n: number;
  readonly min: number;
  readonly max: number;
}

/**
 * SOTA++ multi-sample (B1): per-dimension aggregates across N scenario runs.
 * `judge` / `faithfulness` can be null when no run produced a non-null value.
 */
export interface ScenarioAggregates {
  readonly overall: ScenarioRunAggregates;
  readonly executionEfficiency: ScenarioRunAggregates;
  readonly answerQuality: ScenarioRunAggregates;
  readonly terminationCorrectness: ScenarioRunAggregates;
  readonly costEfficiency: ScenarioRunAggregates;
  readonly judge: ScenarioRunAggregates | null;
  readonly faithfulness: ScenarioRunAggregates | null;
}

const ZERO_SCORES: ScenarioScores = {
  executionEfficiency: 0,
  toolAccuracy: 0,
  stepEfficiency: 0,
  answerQuality: 0,
  terminationCorrectness: 0,
  costEfficiency: 0,
  faithfulness: null,
  contextRelevance: null,
  contextRecall: null,
  exactLookupHit: null,
  failClosedAccuracy: null,
  answerRelevancy: null,
  judge: null,
  overall: 0,
  criticalFailure: false,
  // RFC-020: null by default — populated only when scenario has ground truth
  semanticConstraintRecall: null,
  scrHard: null,
  scrSoft: null,
  scrInferred: null,
  scrInferredGraph: null,
  entityLinkingAccuracy: null,
  slotF1Strict: null,
  slotF1Relaxed: null,
  csrOverall: null,
  csrHard: null,
  csrSoft: null,
  csrInferred: null,
  csrInferredGraph: null,
  extractedHardConstraintCount: null,
};

/**
 * Default weights — answerQuality dominates (user-visible outcome). Execution
 * efficiency (merged tool+step) and cost are secondary. Termination is a
 * binary safety net. Judge is optional, weighted to capture rubric quality.
 *
 * Weight budget (must sum to 1.0) — SOTA++ v4:
 *   answerQuality:        0.25  (user-visible outcome; +0.05 from v3)
 *   executionEfficiency:  0.20  (merged tool+step)
 *   faithfulness:         0.10  (RAGAS grounding)
 *   contextRelevance:     0.10  (RAGAS rule-based retrieval relevance)
 *   contextRecall:        0     (diagnostic only — weight=0 so overall is unaffected;
 *                                goldenKeywords coverage is too sparse to penalise fairly)
 *   costEfficiency:       0.10  (latency + token budget)
 *   terminationCorrectness: 0.10 (binary safety net)
 *   judge:                0.15  (LLM-as-judge rubric; +0.05 from v3's 0.10)
 *   answerRelevancy:      0     (removed from scoring — see comment below)
 *   total:                1.00
 *
 * v4 budget delta vs v3:
 *   answerRelevancy 0.10→0  (-0.10): removed — the heuristic path (pattern-based 0..1
 *                             when no judge) and judge path (null) were INCOMPARABLE.
 *                             Authors adding answerMustMatch patterns could LOWER overall
 *                             (patterns can miss → 0.0) vs authors with no patterns (null
 *                             → imputed at neutral). This perverse incentive was structurally
 *                             broken. answerMustMatch patterns still penalize answerQuality
 *                             via PENALTY_REGEX_MISS — the signal is preserved, just no
 *                             longer double-counted in a separate dimension.
 *   answerQuality   0.20→0.25 (+0.05): absorb the answerRelevancy weight into primary signal
 *   judge           0.10→0.15 (+0.05): rubric evaluation now carries more weight
 *   Net: -0.10 + 0.05 + 0.05 = 0.00
 *
 * contextRecall remains a DIAGNOSTIC metric (reported in stderr, not dropped from JSON)
 * but weight=0 means it cannot drag overall down even when goldenKeywords coverage
 * is sparse (only 6 scenarios define goldenKeywords out of 233).
 */
export type DimensionWeights = Partial<Record<
  Exclude<
    keyof ScenarioScores,
    'overall' | 'toolAccuracy' | 'stepEfficiency' | 'criticalFailure' | 'exactLookupHit' | 'failClosedAccuracy'
  >,
  number
>>;

export const DEFAULT_WEIGHTS: Required<DimensionWeights> = {
  answerQuality: 0.25,
  executionEfficiency: 0.20,
  answerRelevancy: 0,   // removed — see v4 budget comment above
  faithfulness: 0.10,
  contextRelevance: 0.10,
  contextRecall: 0,     // diagnostic only — see weight budget comment above
  costEfficiency: 0.10,
  terminationCorrectness: 0.10,
  judge: 0.15,
};

/**
 * Per-tier weight overrides. Each entry MUST sum to 1.0 — enforced by the
 * weightInvariants test in scorer.test.ts. When adding a tier here, also
 * extend the test's TIER_KEYS list.
 *
 * Weighting principles (post-audit):
 *   - adversarial / edge_case: termination + execution heavy (security signal)
 *   - knowledge_hybrid / knowledge-style tiers: answer quality dominant
 *   - extreme / comparison_nested: cost more important (these blow budgets)
 *   - negation / nested_condition: answer quality dominant (constraint satisfaction)
 *   - default tiers (single_shot, multi_step, …): inherit DEFAULT_WEIGHTS
 */
export const TIER_WEIGHTS: Readonly<Record<string, Required<DimensionWeights>>> = {
  // Security-critical tiers — termination + execution dominant
  // contextRecall: 0 — no goldenKeywords defined for security scenarios yet
  // answerRelevancy: 0 — removed in v4; weight redistributed to terminationCorrectness+judge
  adversarial: {
    terminationCorrectness: 0.35, executionEfficiency: 0.20, answerQuality: 0.10,
    answerRelevancy: 0, faithfulness: 0.05, contextRelevance: 0.05, contextRecall: 0,
    costEfficiency: 0.10, judge: 0.15,
  },
  edge_case: {
    terminationCorrectness: 0.25, executionEfficiency: 0.20, answerQuality: 0.10,
    answerRelevancy: 0, faithfulness: 0.10, contextRelevance: 0.05, contextRecall: 0,
    costEfficiency: 0.15, judge: 0.15,
  },
  // Answer-quality + faithfulness dominant — grounding matters most
  knowledge_hybrid: {
    answerQuality: 0.30, answerRelevancy: 0, faithfulness: 0.15, contextRelevance: 0.05,
    contextRecall: 0, executionEfficiency: 0.10, costEfficiency: 0.10,
    terminationCorrectness: 0.10, judge: 0.20,
  },
  negation: {
    answerQuality: 0.30, answerRelevancy: 0, faithfulness: 0.15, contextRelevance: 0.05,
    contextRecall: 0, executionEfficiency: 0.15, costEfficiency: 0.10,
    terminationCorrectness: 0.10, judge: 0.15,
  },
  nested_condition: {
    answerQuality: 0.30, answerRelevancy: 0, faithfulness: 0.10, contextRelevance: 0.10,
    contextRecall: 0, executionEfficiency: 0.15, costEfficiency: 0.10,
    terminationCorrectness: 0.10, judge: 0.15,
  },
  // Cost-sensitive tiers
  extreme: {
    answerQuality: 0.25, answerRelevancy: 0, faithfulness: 0.10, contextRelevance: 0.05,
    contextRecall: 0, executionEfficiency: 0.10, costEfficiency: 0.25,
    terminationCorrectness: 0.10, judge: 0.15,
  },
  comparison_nested: {
    answerQuality: 0.25, answerRelevancy: 0, faithfulness: 0.10, contextRelevance: 0.05,
    contextRecall: 0, executionEfficiency: 0.10, costEfficiency: 0.15,
    terminationCorrectness: 0.10, judge: 0.25,
  },
  // Korean-language nuance tiers — faithfulness + judge weighted
  korean_colloquial: {
    answerQuality: 0.30, answerRelevancy: 0, faithfulness: 0.10, contextRelevance: 0.05,
    contextRecall: 0, executionEfficiency: 0.05, costEfficiency: 0.10,
    terminationCorrectness: 0.10, judge: 0.30,
  },
  korean_food_pairing: {
    answerQuality: 0.30, answerRelevancy: 0, faithfulness: 0.10, contextRelevance: 0.05,
    contextRecall: 0, executionEfficiency: 0.10, costEfficiency: 0.10,
    terminationCorrectness: 0.10, judge: 0.25,
  },
  // Subjective / situational tiers
  mood_atmosphere: {
    answerQuality: 0.25, answerRelevancy: 0, faithfulness: 0.10, contextRelevance: 0.05,
    contextRecall: 0, executionEfficiency: 0.10, costEfficiency: 0.10,
    terminationCorrectness: 0.10, judge: 0.30,
  },
  situation_based: {
    answerQuality: 0.25, answerRelevancy: 0, faithfulness: 0.10, contextRelevance: 0.05,
    contextRecall: 0, executionEfficiency: 0.10, costEfficiency: 0.15,
    terminationCorrectness: 0.10, judge: 0.25,
  },
  gift_refined: {
    answerQuality: 0.25, answerRelevancy: 0, faithfulness: 0.10, contextRelevance: 0.05,
    contextRecall: 0, executionEfficiency: 0.10, costEfficiency: 0.15,
    terminationCorrectness: 0.10, judge: 0.25,
  },
  price_expression: {
    answerQuality: 0.30, answerRelevancy: 0, faithfulness: 0.10, contextRelevance: 0.10,
    contextRecall: 0, executionEfficiency: 0.10, costEfficiency: 0.10,
    terminationCorrectness: 0.10, judge: 0.20,
  },
};

// ─────────────────────────────────────────────────────────────────────
// Penalty / scoring constants (extracted for visibility and testability)
// ─────────────────────────────────────────────────────────────────────

/** executionEfficiency merge weights — SSoT in `./constants.js`. */
const EXEC_TOOL_WEIGHT = K_EXEC_TOOL_WEIGHT;
const EXEC_STEP_WEIGHT = K_EXEC_STEP_WEIGHT;
/** Structured check penalties — multiplied into answerQuality. */
const PENALTY_PRICE_BAND_VIOLATED = 0.7;
const PENALTY_VINTAGE_RANGE_VIOLATED = 0.7;
const PENALTY_DRINKING_WINDOW_MISMATCH = 0.8;
// PENALTY_EXACT_LOOKUP_MISS / PENALTY_FAIL_CLOSED_VIOLATED moved to
// ./scorer-exact-lookup-contract.ts during round 8.2.
/** v4: raised from 0.9 → 0.7. A missing tool argument is a structural execution
 * failure (tool was called but lacked a required arg). The old 10% dock was far
 * too mild — milder than price band violations (30%) despite being a more
 * fundamental error. Now aligned with other structural check penalties. */
const PENALTY_TOOL_ARG_MISSING = 0.7;
// v4: PENALTY_HEDGING_MISSING, PENALTY_REGISTER_MISMATCH, PENALTY_OVERCONFIDENT
// removed — these dimensions are now evaluated by the LLM judge exclusively.
// See scoreStructuredChecks comment block for the structural rationale.
const PENALTY_UNCITED_WINE_NAMES = 0.5;
/** Answer quality: 50% penalty per regex miss in answerMustMatch. */
/**
 * Answer quality: 50% penalty per answerMustNotMatch hit.
 * v4: rebalanced from 0.20 → 0.50. The old 80% dock was disproportionate —
 * a polite Korean preamble ("죄송합니다만...") before a valid recommendation
 * lost 80% of answerQuality, more than a missing tool argument (now 30%).
 * At 50%, a single hit is a meaningful penalty but recoverable via judge;
 * two hits stack to 0.25 (75% dock) which is proportional to double failure.
 * Intentionally non-fatal (not a critical-fail): judge can partially offset.
 */
/** Faithfulness: threshold below which a warning diagnostic fires.
 *  Bound to `./constants.js` SSoT so a single edit drives all readers
 *  (CLAUDE.md rule 30). */
const FAITHFULNESS_WARN_THRESHOLD = FAITHFULNESS_PER_SCENARIO_WARN;
// CTX_WINE_TYPE_MAP / CTX_COUNTRY_MAP / CTX_REGION_MAP moved to
// ./scorer-ctx-maps.ts during the 2026-05-25/26 decomposition (round 8.1).
// Imported above; consumed by scoreContextRelevance.

// buildContextEvidenceRecords + normalizeEvidenceText moved to
// ./scorer-evidence-utils.ts during the 2026-05-25 decomposition. Imported
// above; consumed by ≥6 per-dim scoring sites across this file.

// normalizeExactLookupSurface / collectObservedExactLookupValues /
// buildExactLookupNeedles moved to ./scorer-exact-lookup-utils.ts during
// the 2026-05-25 decomposition. Imported above.

// 7 context-relevance helpers (evidenceTextIncludes, evidenceNumericValues,
// collectStyleHintsFromToolInput, collectStructuredToolContextRelevanceChecks,
// expectedEntityEvidenceFields, collectExpectedEntityContextRelevanceChecks,
// formatContextCheckSummary, summarizeContextAxisChecks)
// + types ContextRelevanceAxis / ContextRelevanceCheck moved to
// ./scorer-context-relevance.ts (round 8.5).

// BENCHMARK_REFERENCE_YEAR moved to ./scorer-context-relevance.ts (round 8.5).

// v4 removal: ANSWER_LENGTH_BONUS, ANSWER_TRIVIAL_PENALTY, ANSWER_WINE_RELEVANT_TERMS
// were removed entirely. The length bonus (+0.05 for answers ≥100 chars with wine terms)
// was a degenerate signal: essentially +5% for any Korean answer mentioning '와인', which
// is every answer in this domain. The trivial penalty (-0.1 for <20 chars) was redundant
// with answerContains and the NO_QUALITY_CONSTRAINTS diagnostic. Both were additive
// adjustments on a multiplicative score (asymmetric math) and only fired when no judge
// was present — the one path that already lacked quality signal. Removing them makes
// scoreAnswerQuality purely contract-based: answerContains, answerMustMatch,
// answerExcludes, answerMustNotMatch, and structured checks.

// v4: KOREAN_PROPER_NOUN_STOPWORDS and KOREAN_PREDICATE_SUFFIX_RE removed.
// extractProperNouns is now Latin-only — Korean wine name grounding is handled
// by the judge's mustCiteFromToolResults rubric criterion. See extractProperNouns
// docstring for the rationale.

/**
 * RFC-020: constraint extraction metrics pre-computed by the benchmark runner
 * via the offline eval rig (`runConstraintExtraction`). When provided, these
 * values populate the ScenarioScores constraint dimensions.
 */
export interface ConstraintExtractionMetricsInput {
  readonly semanticConstraintRecall: number | null;
  readonly scrHard: number | null;
  readonly scrSoft: number | null;
  readonly scrInferred: number | null;
  /** ADR-011 PR2 dual-emit: graph-aware inferred recall. */
  readonly scrInferredGraph: number | null;
  readonly entityLinkingAccuracy: number | null;
  readonly slotF1Strict: number | null;
  readonly slotF1Relaxed: number | null;
  /** P4: Constraint Satisfaction Rate — weighted overall [0,1]. null when no observations. */
  readonly csrOverall: number | null;
  /** P4: CSR hard tier [0,1]. null when no hard constraints or no observations. */
  readonly csrHard: number | null;
  /** P4: CSR soft tier [0,1]. null when no soft constraints or no observations. */
  readonly csrSoft: number | null;
  /** P4: CSR inferred tier [0,1]. null when no inferred constraints or no observations. */
  readonly csrInferred: number | null;
  /** ADR-011 PR2 dual-emit: graph-aware inferred satisfaction. */
  readonly csrInferredGraph: number | null;
  /**
   * Number of HARD constraints the NL Mapper extracted for the query
   * (e.g. `priceMaxKrw=50000`, `wineType=red`). Counted from
   * `runConstraintExtraction(query).bundle.hard.length`.
   *
   * This is the per-scenario value that the run-level `meanHardConstraints`
   * insight aggregates. The aggregate previously sat hardcoded at `0` with a
   * TODO comment — every "Retrieval is under-filtered" warning that fired
   * (insight rule `hard_constraints_low`) was a corrupted signal.
   *
   * `null` when constraint extraction was not run for the scenario (no
   * `expectedConstraints` AND no `expectedEntities`); the run-level mean
   * filters nulls so non-annotated scenarios neither inflate nor deflate it.
   */
  readonly extractedHardConstraintCount: number | null;
}

export function scoreScenario(
  scenario: AgentBenchmarkScenario,
  execution: ScenarioExecution | null,
  judgeScore: number | undefined,
  faithfulnessScore?: number,
  error?: string,
  steps?: readonly StepTrace[],
  judgeReasoning?: string,
  /** RFC-020 claim-level diagnostic. When provided, attached to ScenarioResult
   *  for downstream reporting. v5+: faithfulness dim derives from
   *  DiagnosticVector.faithfulnessScore (more granular than judgeFaithfulness). */
  claimDiagnostics?: DiagnosticVector,
  /** RFC-020: pre-computed constraint extraction metrics. null-safe — each
   *  field is nullable and only populated for scenarios with ground truth. */
  constraintMetrics?: ConstraintExtractionMetricsInput,
): ScenarioResult {
  if (scenario.skip !== undefined) {
    return {
      id: scenario.id,
      tier: scenario.tier,
      query: scenario.query,
      skipped: true,
      skipReason: scenario.skip,
      scores: ZERO_SCORES,
      judgeRequiredButSkipped: false,
    };
  }

  if (execution === null || error !== undefined) {
    return {
      id: scenario.id,
      tier: scenario.tier,
      query: scenario.query,
      skipped: false,
      error: error ?? 'execution returned null',
      scores: ZERO_SCORES,
      judgeRequiredButSkipped: false,
    };
  }

  const exp = scenario.expectation;
  const diagnostics: Diagnostic[] = [];

  const toolAccuracy = scoreToolAccuracy(
    exp,
    execution.toolsUsed,
    diagnostics,
    execution.terminationReason,
    execution.stepCount,
  );
  const stepEfficiency = scoreStepEfficiency(exp, execution.stepCount, diagnostics);
  // executionEfficiency: monotone weighted mean of toolAccuracy + stepEfficiency.
  // Earlier the formula switched to max() when both <0.5 to avoid double-
  // penalising thrashing (single root cause), but that branch was non-monotone
  // at the 0.5 boundary — improving an input could DECREASE the output.
  // The dim merge already lives in the geo-mean weighting (executionEfficiency
  // gets the same weight that tool+step would have shared), so a single
  // weighted mean is sufficient and stable.
  const executionEfficiency = toolAccuracy * EXEC_TOOL_WEIGHT + stepEfficiency * EXEC_STEP_WEIGHT;

  const baseAnswerQuality = isHonestNoEvidenceAbstentionScenario(exp, execution)
    ? 1
    : scoreAnswerQuality(exp, execution.answer, diagnostics, judgeScore);
  // Structured checks multiply into answerQuality — each failed check docks a %.
  const structuredMultiplier = scoreStructuredChecks(exp, execution.answer, execution, diagnostics, judgeScore);
  const exactLookupScore = scoreExactLookupContract(exp, execution, diagnostics);
  const answerQuality = clamp01(baseAnswerQuality * structuredMultiplier * exactLookupScore.multiplier);
  const terminationCorrectness = scoreTermination(
    exp,
    execution.terminationReason,
    diagnostics,
    execution.stepCount,
  );
  const costEfficiency = scoreCostEfficiency(exp, execution, diagnostics);

  // Judge: undefined → null (DROPPED from geo-mean, not 1.0).
  const judge: number | null = judgeScore === undefined
    ? null
    : (
        isHonestNoEvidenceAbstentionScenario(exp, execution)
        || exactLookupScore.exactLookupHit === 1
        || exactLookupScore.failClosedAccuracy === 1
      ) && judgeScore >= 0.75
      ? 1
      : clamp01(judgeScore);

  // RAGAS Answer Relevancy: ALWAYS null — removed from scoring in SOTA++ v4.
  //
  // v4 removal rationale: the dimension had two INCOMPARABLE code paths:
  //   - judgeScore present → null (imputed at neutral 0.5)
  //   - no judge, answerMustMatch patterns → 0.0–1.0 heuristic
  //   - no judge, no patterns → null (imputed at neutral 0.5)
  //
  // The incomparability created a perverse incentive: scenario authors who added
  // answerMustMatch constraints could LOWER their scenario's overall score if any
  // pattern missed (0.0 < 0.5 neutral). Authors with no patterns got the neutral
  // imputation for "free", making vague scenarios score better than precise ones.
  //
  // The signal is PRESERVED: answerMustMatch patterns still penalize answerQuality
  // via PENALTY_REGEX_MISS (0.5× per miss) in scoreAnswerQuality(). The weight
  // previously allocated to answerRelevancy (0.10) was redistributed to
  // answerQuality (+0.05) and judge (+0.05) in DEFAULT_WEIGHTS.
  //
  // answerRelevancy remains in ScenarioScores for diagnostic visibility but has
  // weight=0 in all tiers — it contributes nothing to overall.
  const answerRelevancy: number | null = null;

  // RAGAS Faithfulness: LLM-scored grounding of answer claims in tool results.
  // null when no observations (no tool calls → nothing to ground against).
  const faithfulness: number | null = faithfulnessScore ?? null;
  if (faithfulness !== null && faithfulness < FAITHFULNESS_WARN_THRESHOLD) {
    diagnostics.push({
      dim: 'faithfulness',
      severity: 'warn',
      code: 'FAITHFULNESS_LOW',
      message: `answer grounding in tool results is weak (${(faithfulness * 100).toFixed(0)}%)`,
      observed: faithfulness,
    });
  }

  // RAGAS Context Relevance: rule-based check of tool result relevance
  // against scenario's structured constraints (priceBandKrw, vintageRange, etc.).
  // null when no structured constraints or no observations.
  const contextRelevance = scoreContextRelevance(scenario, exp, execution, diagnostics);

  // RAGAS Context Recall: fraction of goldenKeywords that appeared in
  // agent observations. null when no goldenKeywords on the scenario or
  // no observations available.
  const contextRecall = scoreContextRecall(scenario, execution, diagnostics);

  // Korean Correct Language Rate (CLR): when the query is Korean (≥ 20% Hangul characters),
  // check whether the answer is also predominantly Korean. Code-switching to English mid-answer
  // is a known LLM failure mode that degrades user experience. This is a monitoring-only
  // diagnostic (severity='warn') — it does NOT affect scores, only surfaces the signal.
  emitKoreanClrDiagnostic(scenario.query, execution.answer, diagnostics);

  // Critical-fail check — any of these collapses overall to 0.
  const criticalFailure = diagnostics.some((d) => d.severity === 'critical');

  // Resolve weights — scenario override > tier override > default.
  const baseWeights: Required<DimensionWeights> = {
    ...DEFAULT_WEIGHTS,
    ...(TIER_WEIGHTS[scenario.tier] ?? {}),
    ...(scenario.expectation.weights ?? {}),
  };
  const weights = renormaliseWeights(baseWeights);

  // v4: emit diagnostic when scenario weight overrides cause renormalization.
  // Silent renormalization is a design trap: weights: { terminationCorrectness: 0.80 }
  // produces effective weight ~0.47 (not 0.80), and all other dims are implicitly
  // reduced by ~41%. The diagnostic makes this visible in benchmark output.
  if (scenario.expectation.weights !== undefined) {
    const preNormSum = Object.values(baseWeights).reduce((a, b) => a + b, 0);
    const RENORM_WARN_THRESHOLD = 0.01;
    if (Math.abs(preNormSum - 1) > RENORM_WARN_THRESHOLD) {
      diagnostics.push({
        dim: 'answerQuality', // meta-diagnostic; no specific dim
        severity: 'info',
        code: 'WEIGHTS_RENORMALIZED',
        message: `scenario weight overrides sum to ${preNormSum.toFixed(3)} (not 1.0) — all weights were proportionally scaled. Effective terminationCorrectness=${weights.terminationCorrectness.toFixed(3)}`,
        observed: preNormSum,
        expected: 1,
      });
    }
  }

  const dimScores: Record<keyof Required<DimensionWeights>, number | null> = {
    executionEfficiency,
    answerQuality,
    answerRelevancy,
    faithfulness,
    contextRelevance,
    contextRecall,
    terminationCorrectness,
    costEfficiency,
    judge,
  };

  // Apply DIMENSION_FLOOR to non-null scores before geo-mean, but ONLY for
  // truly noisy secondary dimensions.
  //
  // SOTA++ v3 structural fix: answerQuality removed from floored dims.
  // answerQuality is computed from real signals (answerContains, answerMustMatch,
  // structured checks, PENALTY_MUST_NOT_MATCH). A genuine 0.01 answerQuality
  // means the answer completely failed every check — flooring it to 0.05 hid a
  // 5x collapse behind measurement-noise framing. answerQuality is now treated
  // as a primary signal alongside executionEfficiency and terminationCorrectness.
  //
  // Dims excluded from floor (must stay at true score, even 0.0):
  //   - executionEfficiency: tool selection + step budget signal
  //   - terminationCorrectness: binary safety net
  //   - answerQuality: primary user-facing outcome — genuine 0 must stay 0
  //   - costEfficiency: engineering/SLA failure, not measurement noise
  //
  // Dims that DO get the floor (genuinely noisy secondary signals):
  //   - faithfulness, contextRelevance, contextRecall, answerRelevancy, judge
  //     These are approximations (heuristics / sparse LLM samples). A 0.01 here
  //     is more likely measurement noise than a true catastrophic failure.
  // NO_FLOOR_DIMS is module-scope (rule 16: deterministic sets should not be allocated per-call).
  const dimScoresFloored: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(dimScores)) {
    dimScoresFloored[k] = (v === null || NO_FLOOR_DIMS.has(k))
      ? v
      : Math.max(v, DIMENSION_FLOOR);
  }

  const overall = criticalFailure
    ? 0
    : weightedGeometricMean(dimScoresFloored, weights);

  const judgeRequiredButSkipped = (scenario.expectation.judgeRequired === true) && (judgeScore === undefined);
  if (judgeRequiredButSkipped) {
    diagnostics.push({
      dim: 'judge',
      severity: 'warn',
      code: 'JUDGE_REQUIRED_BUT_SKIPPED',
      message: 'This scenario requires LLM judge to verify core constraint — overall score is unreliable without judge.',
    });
  }

  const diagnosticStrings = diagnostics.map((d) => {
    const head = `[${d.severity}] ${d.dim}/${d.code}: ${d.message}`;
    const obs = d.observed !== undefined ? `observed=${String(d.observed)}` : '';
    const expStr = d.expected !== undefined ? `expected=${String(d.expected)}` : '';
    const tail = [obs, expStr].filter((s) => s.length > 0).join(', ');
    return tail.length > 0 ? `${head} (${tail})` : head;
  });

  return {
    id: scenario.id,
    tier: scenario.tier,
    query: scenario.query,
    skipped: false,
    answer: execution.answer,
    stepCount: execution.stepCount,
    toolCallCount: execution.toolCallCount,
    toolsUsed: execution.toolsUsed.map((t) => t.tool),
    terminationReason: execution.terminationReason,
    totalDurationMs: execution.totalDurationMs,
    // S1.1: surface agent-work time when the runner supplied it (wall minus
    // throttle backoff). Omit the key entirely when absent
    // (exactOptionalPropertyTypes).
    ...(execution.agentWorkMs != null ? { agentWorkMs: execution.agentWorkMs } : {}),
    ...(execution.throttleWaitMs != null ? { throttleWaitMs: execution.throttleWaitMs } : {}),
    totalTokens: execution.totalTokens,
    // ADR-009 Phase 0: evidence frame count for cutover-gate aggregation.
    ...(execution.evidenceFrameCount !== undefined
      ? { evidenceFrameCount: execution.evidenceFrameCount }
      : {}),
    // hard_constraints_low insight: per-scenario planner-emitted hard constraint
    // sum. Pass through verbatim (including explicit `null`) so the summary
    // aggregator can distinguish "no search ran" (null) from "search ran with
    // zero hard constraints" (0). When the runner did not measure the field
    // (e.g. legacy tests calling scoreScenario directly), omit the key.
    ...(execution.hardConstraintCount !== undefined
      ? { hardConstraintCount: execution.hardConstraintCount }
      : {}),
    scores: {
      executionEfficiency,
      toolAccuracy,
      stepEfficiency,
      answerQuality,
      answerRelevancy,
      terminationCorrectness,
      costEfficiency,
      faithfulness,
      contextRelevance,
      contextRecall,
      exactLookupHit: exactLookupScore.exactLookupHit,
      failClosedAccuracy: exactLookupScore.failClosedAccuracy,
      judge,
      overall,
      criticalFailure,
      // RFC-020: constraint extraction metrics (null-safe pass-through)
      semanticConstraintRecall: constraintMetrics?.semanticConstraintRecall ?? null,
      scrHard: constraintMetrics?.scrHard ?? null,
      scrSoft: constraintMetrics?.scrSoft ?? null,
      scrInferred: constraintMetrics?.scrInferred ?? null,
      scrInferredGraph: constraintMetrics?.scrInferredGraph ?? null,
      entityLinkingAccuracy: constraintMetrics?.entityLinkingAccuracy ?? null,
      slotF1Strict: constraintMetrics?.slotF1Strict ?? null,
      slotF1Relaxed: constraintMetrics?.slotF1Relaxed ?? null,
      csrOverall: constraintMetrics?.csrOverall ?? null,
      csrHard: constraintMetrics?.csrHard ?? null,
      csrSoft: constraintMetrics?.csrSoft ?? null,
      csrInferred: constraintMetrics?.csrInferred ?? null,
      csrInferredGraph: constraintMetrics?.csrInferredGraph ?? null,
      extractedHardConstraintCount: constraintMetrics?.extractedHardConstraintCount ?? null,
    },
    ...(diagnostics.length > 0 ? { diagnostics, diagnosticStrings } : {}),
    judgeRequiredButSkipped,
    ...(steps !== undefined && steps.length > 0 ? { steps } : {}),
    ...(judgeReasoning !== undefined ? { judgeReasoning } : {}),
    ...(claimDiagnostics !== undefined ? { claimDiagnostics } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Dimension scorers
// ─────────────────────────────────────────────────────────────────────







// ─────────────────────────────────────────────────────────────────────
// Structured checks (9 schema fields → answerQuality / toolAccuracy multipliers)
// ─────────────────────────────────────────────────────────────────────

/**
 * Evaluate scenario-defined structured assertions that go beyond substring
 * matching. Returns a multiplier in (0, 1] applied to answerQuality. Each
 * check that fails docks a fraction; critical failures produce 0.
 */
function scoreStructuredChecks(
  exp: ScenarioExpectation,
  answer: string,
  execution: ScenarioExecution,
  diagnostics: Diagnostic[],
  judgeScore?: number,
): number {
  let multiplier = 1;
  // When the LLM was unavailable (step-0 fallback), the fallback answer embeds the
  // user's query text verbatim. Register and drinkingWindow checks on that text would
  // score the USER's language, not the AGENT's. Skip those dims to avoid false positives.
  const isStep0Fallback = execution.terminationReason === 'fallback' && (execution.stepCount ?? 0) === 0;

  // 1. priceBandKrw — extract Korean price patterns, check bounds
  if (exp.priceBandKrw !== undefined) {
    const prices = extractKoreanPrices(answer);
    if (prices.length > 0) {
      const outOfBound = prices.filter((p) => {
        if (exp.priceBandKrw!.min !== undefined && p < exp.priceBandKrw!.min) return true;
        if (exp.priceBandKrw!.max !== undefined && p > exp.priceBandKrw!.max) return true;
        return false;
      });
      if (outOfBound.length > 0) {
        diagnostics.push({
          dim: 'answerQuality',
          severity: 'warn',
          code: 'PRICE_BAND_VIOLATED',
          message: `prices out of range: ${outOfBound.join(', ')} KRW`,
          observed: outOfBound.join(','),
          expected: `${exp.priceBandKrw.min ?? '?'}-${exp.priceBandKrw.max ?? '?'}`,
        });
        multiplier *= PENALTY_PRICE_BAND_VIOLATED;
      }
    }
  }

  // 2. vintageRange — extract 4-digit years, check min/max
  if (exp.vintageRange !== undefined) {
    const years = extractVintageYears(answer);
    if (years.length > 0) {
      const outOfRange = years.filter((y) => {
        if (exp.vintageRange!.min !== undefined && y < exp.vintageRange!.min) return true;
        if (exp.vintageRange!.max !== undefined && y > exp.vintageRange!.max) return true;
        return false;
      });
      if (outOfRange.length > 0) {
        diagnostics.push({
          dim: 'answerQuality',
          severity: 'warn',
          code: 'VINTAGE_RANGE_VIOLATED',
          message: `vintages out of range: ${outOfRange.join(', ')}`,
          observed: outOfRange.join(','),
          expected: `${exp.vintageRange.min ?? '?'}-${exp.vintageRange.max ?? '?'}`,
        });
        multiplier *= PENALTY_VINTAGE_RANGE_VIOLATED;
      }
    }
  }

  // 3. drinkingWindowStatus — keyword match
  // Skip for step-0 fallback: the fallback answer embeds the user's query text, which may
  // accidentally contain cellar/hold keywords from the query itself — not from the agent.
  if (exp.drinkingWindowStatus !== undefined && exp.drinkingWindowStatus !== 'any' && !isStep0Fallback) {
    const status = exp.drinkingWindowStatus;
    const keywords: Record<string, readonly RegExp[]> = {
      now: [/drinkable|peak|optimal|currently|지금|마시기\s*좋|음용\s*적기|최적|피크/iu],
      hold: [/hold|cellar|aging|young|숙성|보관|셀러|셀러링|더\s*기다|음용\s*전|아직|이르/iu],
      past: [/past|over|decline|지남|지났|과거/iu],
    };
    const patterns = keywords[status] ?? [];
    const found = patterns.some((re) => re.test(answer));
    if (!found) {
      diagnostics.push({
        dim: 'answerQuality',
        severity: 'warn',
        code: 'DRINKING_WINDOW_MISMATCH',
        message: `expected drinking window status '${status}' keywords not found`,
        expected: status,
      });
      multiplier *= PENALTY_DRINKING_WINDOW_MISMATCH;
    }
  }

  // 4. expectedToolArgs — tool input JSON dot-path traversal
  if (exp.expectedToolArgs !== undefined && exp.expectedToolArgs.length > 0) {
    for (const argSpec of exp.expectedToolArgs) {
      const matchingCalls = execution.toolsUsed.filter((t) => t.tool === argSpec.tool);
      const observedValues: string[] = [];
      const anyMatch = matchingCalls.some((call) => {
        try {
          const parsed = (JSON.parse(call.input ?? '{}') as unknown) as Record<string, unknown>;
          const value = getNestedValue(parsed, argSpec.argPath);
          observedValues.push(formatToolArgValue(value));
          return evaluatePredicate(value, argSpec.predicate, argSpec.value);
        } catch {
          diagnostics.push({
            dim: 'toolAccuracy',
            severity: 'warn',
            code: 'TOOL_ARG_PARSE_FAILED',
            message: 'Failed to parse tool input JSON for expectedToolArgs check',
          });
          return false;
        }
      });
      if (!anyMatch) {
        diagnostics.push({
          dim: 'toolAccuracy',
          severity: 'warn',
          code: 'EXPECTED_TOOL_ARG_MISSING',
          message: `${argSpec.tool}.${argSpec.argPath} ${argSpec.predicate} ${argSpec.value === undefined ? '' : JSON.stringify(argSpec.value)} not satisfied across ${matchingCalls.length} matching tool call(s)`,
          observed: observedValues.length > 0 ? observedValues.join(' | ') : '<no matching tool calls>',
          expected: `${argSpec.predicate} ${argSpec.value === undefined ? '' : JSON.stringify(argSpec.value)}`.trim(),
        });
        multiplier *= PENALTY_TOOL_ARG_MISSING;
      }
    }
  }

  // 5/6/7: requireHedging / requiredRegister / maxConfidence
  //
  // v4 STRUCTURAL FIX: removed regex-based heuristic checks for these three
  // semantic dimensions. They are now evaluated EXCLUSIVELY by the LLM judge
  // via composeAutoRubric (judge.ts), which generates rubric criteria from
  // these scenario fields and lets the judge evaluate semantically.
  //
  // Why removed (the heuristic-tightening trap):
  // - hedging regex /아마도|어쩌면|.../ — Korean hedging is context-dependent;
  //   formal sommelier writing can hedge without these tokens, casual chat can
  //   use them in non-hedging contexts. Pattern enumeration is endless.
  // - register markers (formal=합니다/습니다, casual=줄게/건데/잖아...) — Korean
  //   register is a morphosyntactic property, not a token bag count. Elliptical
  //   formal writing has no markers; mixed-register text isn't binary.
  // - overconfident regex /틀림없이|무조건|.../ — overconfidence is pragmatic
  //   stance, not vocabulary. "확실히 좋은 와인" was a known false positive; the
  //   real fix isn't enumerating safe vs unsafe words, it's semantic judgment.
  //
  // The judge already evaluates these scenarios (composeAutoRubric emits
  // bilingual rubric criteria for each). Removing the regex layer eliminates
  // false positives AND the heuristic-tightening cycle (every new edge case
  // required another regex tweak). For these three dims, the judge IS the
  // evaluator — not an offset to a heuristic.
  //
  // Note: scenarios with these fields SHOULD have judgeRequired:true to ensure
  // the judge runs. The NO_QUALITY_CONSTRAINTS diagnostic surfaces gaps.
  //
  // PENALTY_HEDGING_MISSING, PENALTY_REGISTER_MISMATCH, PENALTY_OVERCONFIDENT
  // constants removed (no callers).

  // 8. refusalExpected — CRITICAL: answer must contain refusal + must NOT contain affirmation
  if (exp.refusalExpected === true) {
    // v4 STRUCTURAL FIX: regex-based refusal detection removed. Replaced with
    // judge-driven semantic evaluation via composeAutoRubric.
    //
    // Old regex (removed): /존재하지|찾을 수 없|.../ for refusal markers and
    // /재고 있|구매 가능|.../ for affirmative markers. Both produced false positives:
    //
    // - '맛없는' (tasteless), '타닌이 없고' (low tannin), '오크 없는' (unoaked) all
    //   match '없' as a wine descriptor, not a refusal. The previous fix was to
    //   tighten patterns ('없습니다'/'없어요') but Korean wine vocabulary will keep
    //   producing edge cases (없는, 없이, 없네, ...).
    // - '추천(?:해|합니다|드립니다)' matches "I recommend you NOT buy this" — the
    //   regex sees affirmation in a refusal context.
    // - 'available' vs 'unavailable' negative lookbehind solved one case but not
    //   'nonavailable', 'unavailably', etc.
    //
    // The judge already evaluates refusal scenarios via composeAutoRubric:
    //   "The answer must refuse or indicate that the requested item does not
    //    exist. Must NOT fabricate availability or details."
    //
    // For these scenarios, the judge IS the evaluator. The only remaining
    // fail-safe is the empty-answer check at the top of scoreAnswerQuality
    // (which already returns 0 with EMPTY_ANSWER critical diagnostic).
    //
    // Scenarios with refusalExpected:true SHOULD have judgeRequired:true.
    // Without judge, this dimension produces no signal — but that's honest
    // (we can't reliably detect refusal via regex).
    if (judgeScore === undefined) {
      diagnostics.push({
        dim: 'judge',
        severity: 'warn',
        code: 'REFUSAL_NO_JUDGE_SIGNAL',
        message: 'refusalExpected=true but judge is disabled — no signal to verify refusal',
      });
    }
  }

  // 9. mustCiteFromToolResults — wine names in answer must appear in observations
  if (exp.mustCiteFromToolResults === true && execution.observations.length > 0) {
    // Extract wine-like proper nouns from the answer (capitalized multi-word sequences)
    const answerWineNames = extractProperNouns(answer);
    if (answerWineNames.length > 0) {
      const observationText = normalizeObservations(execution.observations);
      // v4 fix: NFKC-normalize extracted names before comparison. extractProperNouns
      // returns raw text (possibly NFD from copy-paste), but normalizeObservations uses
      // NFKC. Without this, "Château" in NFD won't match "Château" in NFKC → false
      // UNCITED_WINE_NAMES penalty on correctly-cited accented wine names.
      const uncited = answerWineNames.filter(
        (name) => !observationText.includes(name.toLowerCase().normalize('NFKC')),
      );
      if (uncited.length > 0) {
        diagnostics.push({
          dim: 'answerQuality',
          severity: 'warn',
          code: 'UNCITED_WINE_NAMES',
          message: `wine names in answer not found in tool results: ${uncited.join(', ')}`,
          observed: uncited.join(','),
        });
        multiplier *= PENALTY_UNCITED_WINE_NAMES;
      }
    }
  }

  return multiplier;
}

// ─────────────────────────────────────────────────────────────────────
// RAGAS Context Relevance (structured evidence, no LLM needed)
// ─────────────────────────────────────────────────────────────────────

// scoreContextRelevance + scoreExactLookupContextRelevance moved to
// ./scorer-context-relevance.ts (round 8.5).

// ─────────────────────────────────────────────────────────────────────
// RAGAS Context Recall (canonical-label keyword overlap, no LLM needed)
// ─────────────────────────────────────────────────────────────────────

/**
 * Computes RAGAS Context Recall as canonical-label keyword overlap.
 *
 * Recall = |matched_keywords ∩ observations| / |goldenKeywords|
 *
 * "Matched" means: the keyword appears (case-insensitive, NFKC-normalised)
 * as a substring in the concatenated observation strings. Keywords are
 * canonical-label fragments like "opus one", "château margaux" — these
 * appear verbatim in the `(id: ...) producer: ...` lines of summarizeSearchResults().
 *
 * v3 note: this replaces the v2 goldenEntityIds approach which used slug-style
 * IDs that never appeared in observations (ADR-007: prefer canonical ids in traces).
 * Weight is 0 in DEFAULT_WEIGHTS — this is a DIAGNOSTIC metric only.
 *
 * Returns null when:
 *  - scenario.goldenKeywords is absent or empty, OR
 *  - execution.observations is empty (no tool calls made)
 */
/**
 * Infer golden keywords from a scenario's answerMustMatch regex groups.
 *
 * answerMustMatch patterns like "(바롤로|barolo)" contain the canonical
 * keywords the final answer must reference. Those same keywords SHOULD
 * appear in the tool observations — if they don't, retrieval failed.
 *
 * This closes the measurement gap where only 6/95 scenarios had explicit
 * goldenKeywords. Inferred keywords are less precise than hand-curated
 * ones, but meaningfully better than returning null (unmeasurable).
 *
 * Heuristics:
 * - Extract alternation groups `(a|b|c)` → each alternative as a keyword
 * - Strip regex metacharacters and normalize to lowercase
 * - Drop overly generic tokens (length < 3, common words) that would
 *   match any observation and inflate recall artificially
 */
// scoreContextRecall + scoreExactLookupContextRecall + inferGoldenKeywordsFromExpectation
// moved to ./scorer-context-recall.ts (round 8.4).

// scoreTermination moved to ./scorer-termination.ts (round 8.3).


// Math + aggregate helpers (clamp01, renormaliseWeights, weightedGeometricMean,
// aggregateGeoMean, aggregateTrimmedGeoMean, DIMENSION_FLOOR, NO_FLOOR_DIMS)
// moved to ./scorer-aggregation.ts during the 2026-05-25 decomposition.
// Re-exported below to preserve the external surface for runner.ts and tests.
export {
  renormaliseWeights,
  weightedGeometricMean,
  aggregateGeoMean,
  aggregateTrimmedGeoMean,
} from './scorer-aggregation.js';

// extractKoreanPrices / extractVintageYears / extractProperNouns + their
// currency constants + DRINK_WINDOW_CONTEXT_RE moved to ./scorer-text-extractors.ts
// during the 2026-05-25 decomposition. Re-exported below to preserve the
// external surface (test/benchmark/agent/__tests__/scorer.test.ts).
export {
  extractKoreanPrices,
  extractVintageYears,
  extractProperNouns,
} from './scorer-text-extractors.js';
export { evaluatePredicate } from './scorer-predicate-eval.js';
