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
import type { AgentBenchmarkScenario, TerminationReason } from './scenario.js';
import type { DiagnosticVector } from '../../../src/domain/evaluation/model/claim.js';
import type { ToolCallEvidenceFrame } from '../../../src/domain/agent/model/tool-call-evidence-frame.js';
export interface ToolCallTrace {
    readonly tool: string;
    /** Stringified input for inputContains substring matching. */
    readonly input?: string;
}
/**
 * Per-step trace captured from an AgentStep for triage / profiling.
 * Mirrors AgentStep but with tool inputs typed as Record<string,unknown>
 * (runner JSON.parses the stringified input before passing here).
 */
export interface StepTrace {
    readonly index: number;
    readonly thought: string;
    readonly action?: {
        readonly tool: string;
        readonly input: Record<string, unknown>;
    };
    readonly observation?: string;
    readonly actions?: ReadonlyArray<{
        readonly tool: string;
        readonly input: Record<string, unknown>;
    }>;
    readonly observations?: readonly string[];
    readonly answer?: string;
    readonly durationMs: number;
    readonly tokenCount: {
        readonly input: number;
        readonly output: number;
    };
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
    readonly totalTokens: {
        input: number;
        output: number;
    };
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
}
/**
 * Single source of truth for joining observations into a searchable text block.
 *
 * Rules:
 *  - Separator is '\n' to preserve observation boundaries (a price at the end of
 *    obs N must not merge with text at the start of obs N+1).
 *  - NFKC normalization for consistent Korean/Unicode matching.
 *  - toLowerCase() for case-insensitive substring searches.
 *
 * ALL scorer functions that search observation text MUST call this helper instead
 * of rolling their own join logic.
 */
export declare function normalizeObservations(observations: readonly string[]): string;
export type DiagnosticSeverity = 'info' | 'warn' | 'critical';
export type DiagnosticDim = 'executionEfficiency' | 'toolAccuracy' | 'stepEfficiency' | 'answerQuality' | 'terminationCorrectness' | 'costEfficiency' | 'faithfulness' | 'contextRelevance' | 'contextRecall' | 'judge';
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
    readonly toolAccuracy: number;
    readonly stepEfficiency: number;
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
    readonly judge: number | null;
    readonly overall: number;
    /** True when a hard / critical violation collapsed overall to 0. */
    readonly criticalFailure: boolean;
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
    readonly totalTokens?: {
        input: number;
        output: number;
    };
    /**
     * ADR-009 Phase 0: count of tool calls that emitted a typed evidence frame.
     * The top-level summary divides sum(evidenceFrameCount) by sum(toolCallCount)
     * to compute the cutover-gate `evidenceFrameCoverage`.
     */
    readonly evidenceFrameCount?: number;
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
}
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
export type DimensionWeights = Partial<Record<Exclude<keyof ScenarioScores, 'overall' | 'toolAccuracy' | 'stepEfficiency' | 'criticalFailure' | 'exactLookupHit' | 'failClosedAccuracy'>, number>>;
export declare const DEFAULT_WEIGHTS: Required<DimensionWeights>;
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
export declare const TIER_WEIGHTS: Readonly<Record<string, Required<DimensionWeights>>>;
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
}
export declare function scoreScenario(scenario: AgentBenchmarkScenario, execution: ScenarioExecution | null, judgeScore: number | undefined, faithfulnessScore?: number, error?: string, steps?: readonly StepTrace[], judgeReasoning?: string, 
/** RFC-020 claim-level diagnostic. When provided, attached to ScenarioResult
 *  for downstream reporting. v5+: faithfulness dim derives from
 *  DiagnosticVector.faithfulnessScore (more granular than judgeFaithfulness). */
claimDiagnostics?: DiagnosticVector, 
/** RFC-020: pre-computed constraint extraction metrics. null-safe — each
 *  field is nullable and only populated for scenarios with ground truth. */
constraintMetrics?: ConstraintExtractionMetricsInput): ScenarioResult;
/** Extract Korean-style prices: "5만원", "100,000원", "50000원", "$50"
 * @internal exported for direct unit testing of the extractor. */
export declare function extractKoreanPrices(text: string): number[];
/** Extract 4-digit years that look like wine vintages (1600-2099).
 *  Range extended from 1800 to 1600 to cover rare historic bottles
 *  (pre-phylloxera Bordeaux, Madeira, Tokaji) found in collector queries.
 *  Uses Unicode-safe boundaries instead of \b (CLAUDE.md rule 8).
 *
 *  v4: filters drinking-window years. A year whose left-context (30 chars) matches
 *  DRINK_WINDOW_CONTEXT_RE is likely a drinking window endpoint, not a vintage.
 *  Also filters the second year of a YYYY-YYYY or YYYY–YYYY dash pair when
 *  the gap is 5-30 years (plausible drinking window span). */
/** @internal exported for direct unit testing of the extractor. */
export declare function extractVintageYears(text: string): number[];
/**
 * Extract wine-name-like sequences from text. Handles ONLY Latin proper nouns
 * (capitalized multi-word). Korean transliterations of wine names are NOT
 * extracted because:
 *
 * 1. Wine database entries are Latin (Opus One, Château Margaux), and observations
 *    emit them in Latin. Korean transliterations in the agent answer ('오푸스 원')
 *    would need a transliteration map to match — neither side can do this
 *    reliably with a regex.
 * 2. The Korean Hangul-block extraction (`[\uAC00-\uD7A3]{2,}`) was producing
 *    massive false positives ('좋은와인입니다', '맛있습니다', '추천드립니다'),
 *    which required progressively more stopwords and predicate-suffix filters —
 *    the textbook regex-tightening trap.
 * 3. For mustCiteFromToolResults the Latin path catches the canonical wine names
 *    (e.g., the agent writes "Opus One"); for citation grounding of Korean-named
 *    wines, an LLM judge with the rubric "Every wine mentioned must have appeared
 *    in tool results" handles cross-script matching semantically.
 *
 * v4 STRUCTURAL FIX: removed Korean Hangul extraction + KOREAN_PROPER_NOUN_STOPWORDS
 * + KOREAN_PREDICATE_SUFFIX_RE filter. The function is now Latin-only and
 * deterministic. Korean wine name grounding is delegated to the judge's
 * mustCiteFromToolResults rubric criterion.
 */
/** @internal exported for direct unit testing of the extractor. */
export declare function extractProperNouns(text: string): string[];
/** Evaluate a predicate against a value
 * @internal exported for direct unit testing of predicate branches. */
export declare function evaluatePredicate(actual: unknown, predicate: 'equals' | 'equals_any' | 'lte' | 'gte' | 'contains' | 'contains_any' | 'exists', expected?: unknown): boolean;
//# sourceMappingURL=scorer.d.ts.map