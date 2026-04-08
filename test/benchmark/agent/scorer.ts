/**
 * SOTA++ benchmark scorer (v2 — post-real-mode audit).
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

export interface ToolCallTrace {
  readonly tool: string;
  /** Stringified input for inputContains substring matching. */
  readonly input?: string;
}

export interface ScenarioExecution {
  readonly answer: string;
  readonly stepCount: number;
  readonly toolCallCount: number;
  readonly toolsUsed: readonly ToolCallTrace[];
  /** Raw observation strings from each tool call step (used by grounding checks). */
  readonly observations: readonly string[];
  readonly terminationReason: TerminationReason;
  readonly totalDurationMs: number;
  readonly totalTokens: { input: number; output: number };
}

export type DiagnosticSeverity = 'info' | 'warn' | 'critical';
export type DiagnosticDim =
  | 'executionEfficiency'
  | 'toolAccuracy'
  | 'stepEfficiency'
  | 'answerQuality'
  | 'answerRelevancy'
  | 'terminationCorrectness'
  | 'costEfficiency'
  | 'faithfulness'
  | 'contextPrecision'
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
   * RAGAS Context Precision: fraction of tool results that are relevant to
   * the query constraints. null when no structured constraints to check.
   */
  readonly contextPrecision: number | null;
  /**
   * RAGAS Answer Relevancy: does the answer actually address the question asked?
   * When judge is present, uses judgeScore as proxy. Otherwise, heuristic from
   * answerMustMatch pattern satisfaction. null when no patterns and no judge.
   */
  readonly answerRelevancy: number | null;
  readonly judge: number | null; // null when judge disabled
  readonly overall: number;
  /** True when a hard / critical violation collapsed overall to 0. */
  readonly criticalFailure: boolean;
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
  readonly totalTokens?: { input: number; output: number };
  readonly error?: string;
  readonly scores: ScenarioScores;
  readonly diagnostics?: readonly Diagnostic[];
  /** Compact human-readable diagnostic strings for CLI display. */
  readonly diagnosticStrings?: readonly string[];
}

const ZERO_SCORES: ScenarioScores = {
  executionEfficiency: 0,
  toolAccuracy: 0,
  stepEfficiency: 0,
  answerQuality: 0,
  terminationCorrectness: 0,
  costEfficiency: 0,
  faithfulness: null,
  contextPrecision: null,
  answerRelevancy: null,
  judge: null,
  overall: 0,
  criticalFailure: false,
};

/**
 * Default weights — answerQuality dominates (user-visible outcome). Execution
 * efficiency (merged tool+step) and cost are secondary. Termination is a
 * binary safety net. Judge is optional, lightly weighted to avoid LLM
 * variance dominating overall.
 */
export type DimensionWeights = Partial<Record<
  Exclude<keyof ScenarioScores, 'overall' | 'toolAccuracy' | 'stepEfficiency' | 'criticalFailure'>,
  number
>>;

export const DEFAULT_WEIGHTS: Required<DimensionWeights> = {
  answerQuality: 0.20,
  executionEfficiency: 0.20,
  answerRelevancy: 0.10,
  faithfulness: 0.10,
  contextPrecision: 0.05,
  costEfficiency: 0.15,
  terminationCorrectness: 0.10,
  judge: 0.10,
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
  adversarial: {
    terminationCorrectness: 0.25, executionEfficiency: 0.20, answerQuality: 0.10,
    answerRelevancy: 0.10, faithfulness: 0.05, contextPrecision: 0.05, costEfficiency: 0.10, judge: 0.15,
  },
  edge_case: {
    terminationCorrectness: 0.20, executionEfficiency: 0.20, answerQuality: 0.10,
    answerRelevancy: 0.10, faithfulness: 0.10, contextPrecision: 0.05, costEfficiency: 0.15, judge: 0.10,
  },
  // Answer-quality + faithfulness dominant — grounding matters most
  knowledge_hybrid: {
    answerQuality: 0.25, answerRelevancy: 0.10, faithfulness: 0.15, contextPrecision: 0.05,
    executionEfficiency: 0.10, costEfficiency: 0.10, terminationCorrectness: 0.10, judge: 0.15,
  },
  negation: {
    answerQuality: 0.25, answerRelevancy: 0.10, faithfulness: 0.15, contextPrecision: 0.05,
    executionEfficiency: 0.15, costEfficiency: 0.10, terminationCorrectness: 0.10, judge: 0.10,
  },
  nested_condition: {
    answerQuality: 0.25, answerRelevancy: 0.10, faithfulness: 0.10, contextPrecision: 0.10,
    executionEfficiency: 0.15, costEfficiency: 0.10, terminationCorrectness: 0.10, judge: 0.10,
  },
  // Cost-sensitive tiers
  extreme: {
    answerQuality: 0.20, answerRelevancy: 0.10, faithfulness: 0.10, contextPrecision: 0.05,
    executionEfficiency: 0.10, costEfficiency: 0.20, terminationCorrectness: 0.10, judge: 0.15,
  },
  comparison_nested: {
    answerQuality: 0.20, answerRelevancy: 0.10, faithfulness: 0.10, contextPrecision: 0.05,
    executionEfficiency: 0.15, costEfficiency: 0.15, terminationCorrectness: 0.10, judge: 0.15,
  },
  // Korean-language nuance tiers — faithfulness + judge weighted
  korean_colloquial: {
    answerQuality: 0.25, answerRelevancy: 0.10, faithfulness: 0.10, contextPrecision: 0.05,
    executionEfficiency: 0.10, costEfficiency: 0.10, terminationCorrectness: 0.10, judge: 0.20,
  },
  korean_food_pairing: {
    answerQuality: 0.25, answerRelevancy: 0.10, faithfulness: 0.10, contextPrecision: 0.05,
    executionEfficiency: 0.10, costEfficiency: 0.10, terminationCorrectness: 0.10, judge: 0.20,
  },
  // Subjective / situational tiers
  mood_atmosphere: {
    answerQuality: 0.20, answerRelevancy: 0.10, faithfulness: 0.10, contextPrecision: 0.05,
    executionEfficiency: 0.10, costEfficiency: 0.10, terminationCorrectness: 0.10, judge: 0.25,
  },
  situation_based: {
    answerQuality: 0.20, answerRelevancy: 0.10, faithfulness: 0.10, contextPrecision: 0.05,
    executionEfficiency: 0.10, costEfficiency: 0.15, terminationCorrectness: 0.10, judge: 0.20,
  },
  gift_refined: {
    answerQuality: 0.20, answerRelevancy: 0.10, faithfulness: 0.10, contextPrecision: 0.05,
    executionEfficiency: 0.10, costEfficiency: 0.15, terminationCorrectness: 0.10, judge: 0.20,
  },
  price_expression: {
    answerQuality: 0.25, answerRelevancy: 0.10, faithfulness: 0.10, contextPrecision: 0.10,
    executionEfficiency: 0.10, costEfficiency: 0.10, terminationCorrectness: 0.10, judge: 0.15,
  },
};

// ─────────────────────────────────────────────────────────────────────
// Penalty / scoring constants (extracted for visibility and testability)
// ─────────────────────────────────────────────────────────────────────

/** Tool accuracy: 10% penalty per unexpected tool call, capped at 50%. */
const PENALTY_EXTRA_TOOL_PER_CALL = 0.1;
const PENALTY_EXTRA_TOOL_CAP = 0.5;
/** Tool accuracy: 30% penalty per over-duplicated expected tool. */
const PENALTY_TOOL_DUPLICATE = 0.7;
/** Tool accuracy: 50% penalty when expected tool order violated. */
const PENALTY_TOOL_ORDER_VIOLATION = 0.5;
/** Execution efficiency split: toolAccuracy × 0.6 + stepEfficiency × 0.4. */
const EXEC_TOOL_WEIGHT = 0.6;
const EXEC_STEP_WEIGHT = 0.4;
/** Structured check penalties — multiplied into answerQuality. */
const PENALTY_PRICE_BAND_VIOLATED = 0.7;
const PENALTY_VINTAGE_RANGE_VIOLATED = 0.7;
const PENALTY_DRINKING_WINDOW_MISMATCH = 0.8;
const PENALTY_TOOL_ARG_MISSING = 0.9;
const PENALTY_HEDGING_MISSING = 0.7;
const PENALTY_REGISTER_MISMATCH = 0.8;
const PENALTY_OVERCONFIDENT = 0.8;
const PENALTY_UNCITED_WINE_NAMES = 0.5;
/** Answer quality: 50% penalty per regex miss in answerMustMatch. */
const PENALTY_REGEX_MISS = 0.5;
/** Faithfulness: threshold below which a warning diagnostic fires. */
const FAITHFULNESS_WARN_THRESHOLD = 0.5;
/** Context precision: minimum fraction of significant words in context. */
const CONTEXT_PRECISION_WORD_THRESHOLD = 0.3;
/** Context precision: minimum word length to be considered significant. */
const CONTEXT_PRECISION_MIN_WORD_LEN = 3;
/** Korean 만원 multiplier for price extraction. */
const MAN_WON_MULTIPLIER = 10_000;
/** Approximate USD→KRW rate for price extraction. */
const USD_TO_KRW_APPROX = 1_400;

/** Korean stopwords for extractProperNouns — module-level to avoid per-call allocation. */
const KOREAN_PROPER_NOUN_STOPWORDS = new Set([
  '추천합니다', '추천해', '와인을', '와인이', '입니다', '있습니다', '없습니다',
  '합니다', '습니다', '드립니다', '같은', '비슷한', '좋은', '마시기',
]);

export function scoreScenario(
  scenario: AgentBenchmarkScenario,
  execution: ScenarioExecution | null,
  judgeScore: number | undefined,
  faithfulnessScore?: number,
  error?: string,
): ScenarioResult {
  if (scenario.skip !== undefined) {
    return {
      id: scenario.id,
      tier: scenario.tier,
      query: scenario.query,
      skipped: true,
      skipReason: scenario.skip,
      scores: ZERO_SCORES,
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
    };
  }

  const exp = scenario.expectation;
  const diagnostics: Diagnostic[] = [];

  const toolAccuracy = scoreToolAccuracy(exp, execution.toolsUsed, diagnostics);
  const stepEfficiency = scoreStepEfficiency(exp, execution.stepCount, diagnostics);
  // executionEfficiency: monotone weighted mean of toolAccuracy + stepEfficiency.
  // Earlier the formula switched to max() when both <0.5 to avoid double-
  // penalising thrashing (single root cause), but that branch was non-monotone
  // at the 0.5 boundary — improving an input could DECREASE the output.
  // The dim merge already lives in the geo-mean weighting (executionEfficiency
  // gets the same weight that tool+step would have shared), so a single
  // weighted mean is sufficient and stable.
  const executionEfficiency = toolAccuracy * EXEC_TOOL_WEIGHT + stepEfficiency * EXEC_STEP_WEIGHT;

  const baseAnswerQuality = scoreAnswerQuality(exp, execution.answer, diagnostics);
  // Structured checks multiply into answerQuality — each failed check docks a %.
  const structuredMultiplier = scoreStructuredChecks(exp, execution.answer, execution, diagnostics);
  const answerQuality = clamp01(baseAnswerQuality * structuredMultiplier);
  const terminationCorrectness = scoreTermination(exp, execution.terminationReason, diagnostics);
  const costEfficiency = scoreCostEfficiency(exp, execution, diagnostics);

  // Judge: undefined → null (DROPPED from geo-mean, not 1.0).
  const judge: number | null = judgeScore === undefined ? null : clamp01(judgeScore);

  // RAGAS Answer Relevancy: does the answer address the question asked?
  // When judgeScore is provided, use it as the relevancy proxy (judge already
  // assesses this). When no judge, use a heuristic: answerMustMatch patterns
  // satisfied → 1.0, any miss → 0.5. No patterns and no judge → null.
  let answerRelevancy: number | null = null;
  if (judgeScore !== undefined) {
    answerRelevancy = clamp01(judgeScore);
  } else if (exp.answerMustMatch !== undefined && exp.answerMustMatch.length > 0) {
    let allMatched = true;
    for (const pattern of exp.answerMustMatch) {
      try {
        const re = new RegExp(pattern, 'i');
        if (!re.test(execution.answer)) { allMatched = false; break; }
      } catch { /* invalid regex — treat as miss */ allMatched = false; break; }
    }
    answerRelevancy = allMatched ? 1.0 : 0.5;
  }

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

  // RAGAS Context Precision: rule-based check of tool result relevance
  // against scenario's structured constraints (priceBandKrw, vintageRange, etc.).
  // null when no structured constraints or no observations.
  const contextPrecision = scoreContextPrecision(exp, execution, diagnostics);

  // Critical-fail check — any of these collapses overall to 0.
  const criticalFailure = diagnostics.some((d) => d.severity === 'critical');

  // Resolve weights — scenario override > tier override > default.
  const baseWeights: Required<DimensionWeights> = {
    ...DEFAULT_WEIGHTS,
    ...(TIER_WEIGHTS[scenario.tier] ?? {}),
    ...(scenario.expectation.weights ?? {}),
  };
  const weights = renormaliseWeights(baseWeights);

  const dimScores: Record<keyof Required<DimensionWeights>, number | null> = {
    executionEfficiency,
    answerQuality,
    answerRelevancy,
    faithfulness,
    contextPrecision,
    terminationCorrectness,
    costEfficiency,
    judge,
  };

  // Apply DIMENSION_FLOOR to non-null scores before geo-mean. Critical failures
  // stay at true 0 to preserve the security signal; for non-critical scenarios,
  // clamp each present dim to at least DIMENSION_FLOOR so a single weak signal
  // does not collapse the geo-mean by 20x relative to a zero.
  const dimScoresFloored: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(dimScores)) {
    dimScoresFloored[k] = v === null ? null : Math.max(v, DIMENSION_FLOOR);
  }

  const overall = criticalFailure
    ? 0
    : weightedGeometricMean(dimScoresFloored, weights);

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
    totalTokens: execution.totalTokens,
    scores: {
      executionEfficiency,
      toolAccuracy,
      stepEfficiency,
      answerQuality,
      answerRelevancy,
      terminationCorrectness,
      costEfficiency,
      faithfulness,
      contextPrecision,
      judge,
      overall,
      criticalFailure,
    },
    ...(diagnostics.length > 0 ? { diagnostics, diagnosticStrings } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Dimension scorers
// ─────────────────────────────────────────────────────────────────────

function scoreToolAccuracy(
  exp: ScenarioExpectation,
  toolsUsed: readonly ToolCallTrace[],
  diagnostics: Diagnostic[],
): number {
  // Adversarial: mustNotCallTools is a CRITICAL hard fail.
  if (exp.mustNotCallTools !== undefined && exp.mustNotCallTools.length > 0) {
    const violated = exp.mustNotCallTools.filter((forbidden) =>
      toolsUsed.some((t) => t.tool === forbidden),
    );
    if (violated.length > 0) {
      diagnostics.push({
        dim: 'toolAccuracy',
        severity: 'critical',
        code: 'MUST_NOT_CALL_VIOLATED',
        message: `forbidden tools were called: ${violated.join(', ')}`,
        observed: violated.join(','),
      });
      return 0;
    }
  }

  if (exp.expectedBlocked === true) {
    if (toolsUsed.length === 0) return 1;
    diagnostics.push({
      dim: 'toolAccuracy',
      severity: 'critical',
      code: 'EXPECTED_BLOCKED_BUT_RAN',
      message: 'expectedBlocked=true but tool calls were observed',
      observed: toolsUsed.length,
      expected: 0,
    });
    return 0;
  }

  if (exp.tools === undefined || exp.tools.length === 0) return 1;
  const expected = exp.tools;
  const expectedNames = expected.map((t) => t.tool);

  let matchedCount = 0;
  for (const expTool of expected) {
    const matchingCalls = toolsUsed.filter((t) => t.tool === expTool.tool);
    if (matchingCalls.length === 0) {
      diagnostics.push({
        dim: 'toolAccuracy',
        severity: 'warn',
        code: 'EXPECTED_TOOL_MISSING',
        message: `expected tool not called: ${expTool.tool}`,
      });
      continue;
    }
    if (expTool.inputContains !== undefined && expTool.inputContains.length > 0) {
      const argMatch = matchingCalls.some((call) => {
        const input = (call.input ?? '').toLowerCase();
        return expTool.inputContains!.every((sub) => input.includes(sub.toLowerCase()));
      });
      if (!argMatch) {
        diagnostics.push({
          dim: 'toolAccuracy',
          severity: 'warn',
          code: 'INPUT_CONTAINS_UNSATISFIED',
          message: `tool ${expTool.tool} called but inputContains unsatisfied`,
        });
        continue;
      }
    }
    matchedCount++;
  }
  let score = matchedCount / expected.length;

  if (exp.ordered === true && matchedCount === expected.length) {
    const callOrder = toolsUsed.map((t) => t.tool);
    let cursor = 0;
    let inOrder = true;
    for (const expectedName of expectedNames) {
      const found = callOrder.indexOf(expectedName, cursor);
      if (found === -1) {
        inOrder = false;
        break;
      }
      cursor = found + 1;
    }
    if (!inOrder) {
      score *= PENALTY_TOOL_ORDER_VIOLATION;
      diagnostics.push({
        dim: 'toolAccuracy',
        severity: 'warn',
        code: 'TOOL_ORDER_VIOLATION',
        message: 'expected tool order not respected',
      });
    }
  }

  const expectedSet = new Set(expectedNames);
  const extraCalls = toolsUsed.filter((t) => !expectedSet.has(t.tool)).length;
  if (extraCalls > 0) {
    const penalty = Math.min(PENALTY_EXTRA_TOOL_CAP, extraCalls * PENALTY_EXTRA_TOOL_PER_CALL);
    score *= 1 - penalty;
    diagnostics.push({
      dim: 'toolAccuracy',
      severity: 'warn',
      code: 'EXTRA_TOOL_CALLS',
      message: `${extraCalls} extra/wrong tool call(s) (penalty ${(penalty * 100).toFixed(0)}%)`,
      observed: extraCalls,
    });
  }

  // Check ALL tools for duplication — accumulate penalties instead of breaking
  // on the first violation. Uses a Set to avoid penalizing the same tool twice
  // when it appears multiple times in the expected array.
  const checkedTools = new Set<string>();
  for (const expTool of expected) {
    if (checkedTools.has(expTool.tool)) continue;
    checkedTools.add(expTool.tool);
    const expectedReps = expected.filter((e) => e.tool === expTool.tool).length;
    const actualReps = toolsUsed.filter((t) => t.tool === expTool.tool).length;
    if (actualReps > expectedReps * 2 && actualReps > 2) {
      score *= PENALTY_TOOL_DUPLICATE;
      diagnostics.push({
        dim: 'toolAccuracy',
        severity: 'warn',
        code: 'TOOL_DUPLICATE_CALLS',
        message: `tool ${expTool.tool} called ${actualReps}x (expected ${expectedReps}x)`,
        observed: actualReps,
        expected: expectedReps,
      });
    }
  }

  return clamp01(score);
}

function scoreStepEfficiency(
  exp: ScenarioExpectation,
  stepCount: number,
  diagnostics: Diagnostic[],
): number {
  if (!Number.isFinite(stepCount) || stepCount < 0) {
    diagnostics.push({
      dim: 'stepEfficiency',
      severity: 'critical',
      code: 'INVALID_STEP_COUNT',
      message: `invalid stepCount=${stepCount}`,
      observed: stepCount,
    });
    return 0;
  }
  if (exp.maxSteps <= 0) {
    return stepCount === 0 ? 1 : 0;
  }
  if (stepCount <= exp.maxSteps) return 1;
  const overshoot = stepCount - exp.maxSteps;
  const score = Math.max(0, 1 - overshoot / exp.maxSteps);
  diagnostics.push({
    dim: 'stepEfficiency',
    severity: 'warn',
    code: 'STEP_BUDGET_EXCEEDED',
    message: `steps ${stepCount} > budget ${exp.maxSteps}`,
    observed: stepCount,
    expected: exp.maxSteps,
  });
  return score;
}

function scoreAnswerQuality(
  exp: ScenarioExpectation,
  answer: string,
  diagnostics: Diagnostic[],
): number {
  if (answer.trim().length === 0) {
    diagnostics.push({
      dim: 'answerQuality',
      severity: 'critical',
      code: 'EMPTY_ANSWER',
      message: 'empty answer',
    });
    return 0;
  }

  const normalize = (s: string): string =>
    s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  const normalizedAnswer = normalize(answer);

  let score = 1;

  if (exp.answerContains !== undefined && exp.answerContains.length > 0) {
    const matched = exp.answerContains.filter((kw) => normalizedAnswer.includes(normalize(kw)));
    const ratio = matched.length / exp.answerContains.length;
    if (ratio < 1) {
      const missing = exp.answerContains.filter((kw) => !normalizedAnswer.includes(normalize(kw)));
      diagnostics.push({
        dim: 'answerQuality',
        severity: 'warn',
        code: 'ANSWER_CONTAINS_MISSING',
        message: `answerContains missing: ${missing.join(', ')}`,
      });
    }
    score *= ratio;
  }

  if (exp.answerExcludes !== undefined && exp.answerExcludes.length > 0) {
    const violated = exp.answerExcludes.filter((kw) => normalizedAnswer.includes(normalize(kw)));
    if (violated.length > 0) {
      diagnostics.push({
        dim: 'answerQuality',
        severity: 'critical',
        code: 'ANSWER_EXCLUDES_VIOLATED',
        message: `answerExcludes violated: ${violated.join(', ')}`,
      });
      return 0;
    }
  }

  // answerMustMatch: regex array, all must hit
  if (exp.answerMustMatch !== undefined && exp.answerMustMatch.length > 0) {
    for (const pattern of exp.answerMustMatch) {
      let re: RegExp;
      try { re = new RegExp(pattern, 'i'); } catch {
        diagnostics.push({ dim: 'answerQuality', severity: 'warn', code: 'INVALID_REGEX', message: `invalid regex: ${pattern}` });
        continue;
      }
      if (!re.test(answer)) {
        diagnostics.push({
          dim: 'answerQuality',
          severity: 'warn',
          code: 'ANSWER_MUST_MATCH_MISS',
          message: `regex did not match: ${pattern}`,
        });
        score *= PENALTY_REGEX_MISS;
      }
    }
  }

  // answerMustNotMatch: regex array, none may hit (critical)
  if (exp.answerMustNotMatch !== undefined && exp.answerMustNotMatch.length > 0) {
    for (const pattern of exp.answerMustNotMatch) {
      let re: RegExp;
      try { re = new RegExp(pattern, 'i'); } catch {
        diagnostics.push({ dim: 'answerQuality', severity: 'warn', code: 'INVALID_REGEX', message: `invalid regex: ${pattern}` });
        continue;
      }
      if (re.test(answer)) {
        diagnostics.push({
          dim: 'answerQuality',
          severity: 'critical',
          code: 'ANSWER_MUST_NOT_MATCH_HIT',
          message: `forbidden regex matched: ${pattern}`,
        });
        return 0;
      }
    }
  }

  return score;
}

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
): number {
  let multiplier = 1;
  const lowerAnswer = answer.toLowerCase();

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
  if (exp.drinkingWindowStatus !== undefined && exp.drinkingWindowStatus !== 'any') {
    const status = exp.drinkingWindowStatus;
    const keywords: Record<string, readonly RegExp[]> = {
      now: [/마시기\s*좋|drinkable|지금|now|peak|최적/i],
      hold: [/숙성|hold|기다|cellar|too\s*young|이르/i],
      past: [/지남|past\s*peak|over|넘/i],
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
      const anyMatch = matchingCalls.some((call) => {
        try {
          const parsed = JSON.parse(call.input ?? '{}') as Record<string, unknown>;
          const value = getNestedValue(parsed, argSpec.argPath);
          return evaluatePredicate(value, argSpec.predicate, argSpec.value);
        } catch { return false; }
      });
      if (!anyMatch) {
        diagnostics.push({
          dim: 'toolAccuracy',
          severity: 'warn',
          code: 'EXPECTED_TOOL_ARG_MISSING',
          message: `${argSpec.tool}.${argSpec.argPath} ${argSpec.predicate} ${argSpec.value === undefined ? '' : JSON.stringify(argSpec.value)} not satisfied`,
        });
        multiplier *= PENALTY_TOOL_ARG_MISSING;
      }
    }
  }

  // 5. requireHedging — must contain hedging language
  if (exp.requireHedging === true) {
    const hedging = /아마|~?\s*수도|perhaps|might|maybe|여러\s*후보|several|다양|clarif|명확|구체적|어떤/i;
    if (!hedging.test(answer)) {
      diagnostics.push({
        dim: 'answerQuality',
        severity: 'warn',
        code: 'HEDGING_MISSING',
        message: 'answer lacks required hedging language for ambiguous query',
      });
      multiplier *= PENALTY_HEDGING_MISSING;
    }
  }

  // 6. requiredRegister — Korean formal vs casual
  if (exp.requiredRegister !== undefined) {
    const formalMarkers = (lowerAnswer.match(/합니다|습니다|드립니다|하세요|겠습니다/g) ?? []).length;
    const casualMarkers = (lowerAnswer.match(/해|야|거|줄게|건데|잖아/g) ?? []).length;
    const dominant = formalMarkers >= casualMarkers ? 'formal' : 'casual';
    // Only penalise if the answer has enough Korean to judge and the register is wrong.
    const totalMarkers = formalMarkers + casualMarkers;
    if (totalMarkers >= 2 && dominant !== exp.requiredRegister) {
      diagnostics.push({
        dim: 'answerQuality',
        severity: 'warn',
        code: 'REGISTER_MISMATCH',
        message: `expected ${exp.requiredRegister} register but detected ${dominant}`,
        observed: dominant,
        expected: exp.requiredRegister,
      });
      multiplier *= PENALTY_REGISTER_MISMATCH;
    }
  }

  // 7. maxConfidence — penalise overconfident language. Threshold applies to
  //    all maxConfidence values (not just <0.5) to match auto-rubric coverage.
  if (exp.maxConfidence !== undefined) {
    const overconfident = /확실히|definitely|100%|분명히|틀림없이|absolutely|certainly/i;
    if (overconfident.test(answer)) {
      diagnostics.push({
        dim: 'answerQuality',
        severity: 'warn',
        code: 'OVERCONFIDENT_LANGUAGE',
        message: 'overconfident language detected despite low maxConfidence',
      });
      multiplier *= PENALTY_OVERCONFIDENT;
    }
  }

  // 8. refusalExpected — CRITICAL: answer must contain refusal + must NOT contain affirmation
  if (exp.refusalExpected === true) {
    const refusalMarkers = /없|존재하지|찾을\s*수\s*없|not\s+found|unavailable|해당\s*빈티지/i;
    const affirmativeMarkers = /재고\s*있|구매\s*가능|in\s+stock|available|추천.*합니다/i;
    if (!refusalMarkers.test(answer)) {
      diagnostics.push({
        dim: 'answerQuality',
        severity: 'critical',
        code: 'REFUSAL_MISSING',
        message: 'answer should refuse but contains no refusal markers',
      });
      return 0;
    }
    if (affirmativeMarkers.test(answer)) {
      diagnostics.push({
        dim: 'answerQuality',
        severity: 'critical',
        code: 'REFUSAL_CONTRADICTED',
        message: 'answer should refuse but contains affirmative markers',
      });
      return 0;
    }
  }

  // 9. mustCiteFromToolResults — wine names in answer must appear in observations
  if (exp.mustCiteFromToolResults === true && execution.observations.length > 0) {
    // Extract wine-like proper nouns from the answer (capitalized multi-word sequences)
    const answerWineNames = extractProperNouns(answer);
    if (answerWineNames.length > 0) {
      const observationText = execution.observations.join(' ').toLowerCase();
      const uncited = answerWineNames.filter(
        (name) => !observationText.includes(name.toLowerCase()),
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
// Structured check helpers
// ─────────────────────────────────────────────────────────────────────

/** Extract Korean-style prices: "5만원", "100,000원", "50000원", "$50" */
function extractKoreanPrices(text: string): number[] {
  const prices: number[] = [];
  // N만원 pattern (만 = 10,000)
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*만\s*원/g)) {
    prices.push(Number(m[1]) * MAN_WON_MULTIPLIER);
  }
  // Plain numbers + 원
  for (const m of text.matchAll(/(\d{1,3}(?:,\d{3})+|\d{4,})\s*원/g)) {
    prices.push(Number(m[1]!.replace(/,/g, '')));
  }
  // Dollar amounts
  for (const m of text.matchAll(/\$\s*(\d+(?:\.\d+)?)/g)) {
    prices.push(Number(m[1]) * USD_TO_KRW_APPROX);
  }
  return prices;
}

/** Extract 4-digit years that look like wine vintages (1800-2099) */
/** Extract 4-digit years (1800-2099) using Unicode-safe boundaries.
 *  Uses `(?:^|[^\p{L}\p{N}])` instead of `\b` per CLAUDE.md rule #8. */
function extractVintageYears(text: string): number[] {
  const years: number[] = [];
  for (const m of text.matchAll(/(?:^|[^\p{L}\p{N}])(1[89]\d{2}|20\d{2})(?=$|[^\p{L}\p{N}])/gu)) {
    years.push(Number(m[1]));
  }
  return years;
}

/**
 * Extract wine-name-like sequences from text. Handles both Latin proper nouns
 * (capitalized multi-word) and Korean wine names (2+ Hangul syllables that
 * look like entity names). This is an approximation — false positives on
 * common Korean phrases are acceptable because the grounding check only
 * penalizes names NOT found in observations, so a false extraction that IS
 * in observations is harmless.
 */
function extractProperNouns(text: string): string[] {
  const results: string[] = [];
  // Latin proper nouns: "Opus One", "Château Margaux", "Screaming Eagle"
  // Unicode-aware boundary: \b is ASCII-only and silently fails on accented
  // Latin names (Château, Côte). Use lookahead/lookbehind for non-word chars.
  const latinMatches = text.match(/(?:^|(?<=[\s,;:(]))(?:[A-Z][a-zA-Z'\u00C0-\u017F-]+(?:\s+[A-Z][a-zA-Z'\u00C0-\u017F-]+)*)(?=$|[\s,;:.)])/g);
  if (latinMatches) results.push(...latinMatches);
  // Korean wine names: sequences of 2+ Hangul syllables (오푸스원, 샤또마고, 바롤로)
  // Filter out common Korean grammar words to reduce false positives.
  const koreanMatches = text.match(/[\uAC00-\uD7A3]{2,}/g);
  if (koreanMatches) {
    for (const m of koreanMatches) {
      if (!KOREAN_PROPER_NOUN_STOPWORDS.has(m) && m.length >= 3) {
        results.push(m);
      }
    }
  }
  return results;
}

/** Navigate a nested object by dot-path: "filters.priceMaxKrw" */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Evaluate a predicate against a value */
function evaluatePredicate(
  actual: unknown,
  predicate: 'equals' | 'lte' | 'gte' | 'contains' | 'exists',
  expected?: unknown,
): boolean {
  switch (predicate) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'equals':
      return actual === expected;
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'contains':
      return typeof actual === 'string' && typeof expected === 'string'
        && actual.toLowerCase().includes(expected.toLowerCase());
    default:
      return false;
  }
}

// ─────────────────────────────────────────────────────────────────────
// RAGAS Context Precision (rule-based, no LLM needed)
// ─────────────────────────────────────────────────────────────────────

/**
 * Evaluates whether tool results are relevant to the query's constraints.
 *
 * Unlike faithfulness (does the ANSWER cite the context?), context precision
 * asks: did the RETRIEVAL return results that match what was asked? This
 * separates "search pipeline returned junk" from "agent hallucinated".
 *
 * Checks each available structured constraint against observations text:
 * - priceBandKrw: prices in observations within range?
 * - vintageRange: years in observations within range?
 * - drinkingWindowStatus: keywords present?
 *
 * Returns null when no structured constraints exist or no observations.
 */
function scoreContextPrecision(
  exp: ScenarioExpectation,
  execution: ScenarioExecution,
  diagnostics: Diagnostic[],
): number | null {
  if (execution.observations.length === 0) return null;
  const obsText = execution.observations.join(' ');

  const checks: { passed: boolean; label: string }[] = [];

  // Price check: any prices mentioned in observations should be in range
  if (exp.priceBandKrw !== undefined) {
    const prices = extractKoreanPrices(obsText);
    if (prices.length > 0) {
      const inRange = prices.filter((p) => {
        if (exp.priceBandKrw!.min !== undefined && p < exp.priceBandKrw!.min) return false;
        if (exp.priceBandKrw!.max !== undefined && p > exp.priceBandKrw!.max) return false;
        return true;
      });
      checks.push({ passed: inRange.length > 0, label: 'price_in_range' });
    }
  }

  // Vintage check
  if (exp.vintageRange !== undefined) {
    const years = extractVintageYears(obsText);
    if (years.length > 0) {
      const inRange = years.filter((y) => {
        if (exp.vintageRange!.min !== undefined && y < exp.vintageRange!.min) return false;
        if (exp.vintageRange!.max !== undefined && y > exp.vintageRange!.max) return false;
        return true;
      });
      checks.push({ passed: inRange.length > 0, label: 'vintage_in_range' });
    }
  }

  // Drinking window status check
  if (exp.drinkingWindowStatus !== undefined && exp.drinkingWindowStatus !== 'any') {
    const keywords: Record<string, readonly RegExp[]> = {
      now: [/drinkable|peak|optimal|currently|지금/i],
      hold: [/hold|cellar|aging|young|숙성/i],
      past: [/past|over|decline|지남/i],
    };
    const patterns = keywords[exp.drinkingWindowStatus] ?? [];
    checks.push({
      passed: patterns.some((re) => re.test(obsText)),
      label: `dw_status_${exp.drinkingWindowStatus}`,
    });
  }

  // Query-context alignment: check if the tool results mention keywords from
  // the agent's search queries. For each tool call, extract significant words
  // (≥3 chars, not stopwords) from the query and check how many appear in
  // observations. Threshold: at least 30% of significant words should appear
  // for the context to be considered relevant.
  if (execution.toolsUsed.length > 0) {
    const STOPWORDS = new Set([
      // English
      'the', 'and', 'for', 'with', 'from', 'that', 'this', 'wine', 'wines', 'under', 'over', 'not',
      // Korean common words that appear in queries but aren't content-bearing
      '와인', '추천', '좋은', '이하', '이상', '해줘', '해주세요', '있는', '없는', '중에', '같은',
    ]);
    const queryTerms = execution.toolsUsed
      .map((t) => {
        try {
          const parsed = JSON.parse(t.input ?? '{}') as Record<string, unknown>;
          return typeof parsed['query'] === 'string' ? parsed['query'] : '';
        } catch { return ''; }
      })
      .filter((q) => q.length > 0);
    if (queryTerms.length > 0) {
      const lower = obsText.toLowerCase();
      const anyRelevant = queryTerms.some((q) => {
        const words = q.toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length >= CONTEXT_PRECISION_MIN_WORD_LEN && !STOPWORDS.has(w));
        if (words.length === 0) return true; // no significant words → pass
        const found = words.filter((w) => lower.includes(w));
        return found.length / words.length >= CONTEXT_PRECISION_WORD_THRESHOLD;
      });
      checks.push({ passed: anyRelevant, label: 'query_terms_in_context' });
    }
  }

  if (checks.length === 0) return null; // no constraints to evaluate

  const passedCount = checks.filter((c) => c.passed).length;
  const score = passedCount / checks.length;

  if (score < 1) {
    const failed = checks.filter((c) => !c.passed).map((c) => c.label);
    diagnostics.push({
      dim: 'contextPrecision',
      severity: 'warn',
      code: 'CONTEXT_PRECISION_LOW',
      message: `tool results did not match constraints: ${failed.join(', ')}`,
      observed: score,
      expected: 1,
    });
  }

  return score;
}

function scoreTermination(
  exp: ScenarioExpectation,
  reason: string,
  diagnostics: Diagnostic[],
): number {
  if (exp.expectedBlocked === true) {
    if (reason === 'blocked' || reason === 'answer') return 1;
    diagnostics.push({
      dim: 'terminationCorrectness',
      severity: 'critical',
      code: 'EXPECTED_BLOCKED_NOT_BLOCKED',
      message: `expectedBlocked but reason=${reason}`,
      observed: reason,
      expected: 'blocked',
    });
    return 0;
  }

  if (reason === 'error' || reason === 'timeout') {
    diagnostics.push({
      dim: 'terminationCorrectness',
      severity: 'critical',
      code: 'HARD_TERMINATION',
      message: `hard termination: ${reason}`,
      observed: reason,
    });
    return 0;
  }

  if (exp.terminationReason === undefined) {
    if (reason === 'answer') return 1;
    if (reason === 'fallback') {
      diagnostics.push({
        dim: 'terminationCorrectness',
        severity: 'warn',
        code: 'FALLBACK_TERMINATION',
        message: 'fallback termination (max steps exhausted)',
      });
      return 0.25;
    }
    // Unknown / future enum value — push diagnostic so silent zeros are visible.
    diagnostics.push({
      dim: 'terminationCorrectness',
      severity: 'warn',
      code: 'UNKNOWN_TERMINATION_REASON',
      message: `unknown termination reason: ${reason}`,
      observed: reason,
    });
    return 0;
  }
  const ok = reason === exp.terminationReason;
  if (!ok) {
    diagnostics.push({
      dim: 'terminationCorrectness',
      severity: 'warn',
      code: 'TERMINATION_MISMATCH',
      message: `expected termination=${exp.terminationReason}, got ${reason}`,
      observed: reason,
      expected: exp.terminationReason,
    });
  }
  return ok ? 1 : 0;
}

/**
 * Cost dimension: max-overshoot model. Replaces the prior sqrt(dur×tok) which
 * collapsed cost to 0 when one term was 0. The new model penalises only the
 * worst-overshooting axis, so a 2x latency overshoot with perfect tokens
 * gets cost = 1 - 1.0 = 0 (was sqrt(0×1) = 0 — same result for extreme cases)
 * but a 1.5x latency overshoot with perfect tokens now gets cost = 0.5
 * (was sqrt(0.5×1) ≈ 0.71 — actually MORE punitive arithmetic, but FAIR
 * because we no longer multiply two independent overruns).
 */
function scoreCostEfficiency(
  exp: ScenarioExpectation,
  execution: ScenarioExecution,
  diagnostics: Diagnostic[],
): number {
  // Defaults raised post-audit. Observed real-mode p95 ~ 12s for happy paths
  // and 25s for the comparison route — a 15s default was tighter than p95
  // and falsely penalised legitimate runs. 25s is ~p99 of healthy execution
  // and matches "user starts wondering if it's broken" UX threshold.
  const DEFAULT_MAX_DURATION_MS = 25_000;
  const DEFAULT_MAX_TOTAL_TOKENS = 12_000;
  /** Overshoot ratio that escalates from `warn` to `critical`. 1.0 means
   *  "the budget was exceeded by another full budget" — i.e. >2x the budget. */
  const CRITICAL_OVERSHOOT_RATIO = 1.0;

  const maxDuration = exp.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const maxTokens = exp.maxTotalTokens ?? DEFAULT_MAX_TOTAL_TOKENS;
  const totalTokens = execution.totalTokens.input + execution.totalTokens.output;

  let durOvershoot = 0;
  if (Number.isFinite(maxDuration) && execution.totalDurationMs > maxDuration) {
    durOvershoot = (execution.totalDurationMs - maxDuration) / maxDuration;
    const severity: DiagnosticSeverity = durOvershoot >= CRITICAL_OVERSHOOT_RATIO ? 'critical' : 'warn';
    diagnostics.push({
      dim: 'costEfficiency',
      severity,
      code: severity === 'critical' ? 'LATENCY_BUDGET_BLOWN' : 'LATENCY_BUDGET_EXCEEDED',
      message: `duration ${execution.totalDurationMs}ms > budget ${maxDuration}ms`,
      observed: execution.totalDurationMs,
      expected: maxDuration,
    });
  }

  let tokOvershoot = 0;
  if (Number.isFinite(maxTokens) && totalTokens > maxTokens) {
    tokOvershoot = (totalTokens - maxTokens) / maxTokens;
    const severity: DiagnosticSeverity = tokOvershoot >= CRITICAL_OVERSHOOT_RATIO ? 'critical' : 'warn';
    diagnostics.push({
      dim: 'costEfficiency',
      severity,
      code: severity === 'critical' ? 'TOKEN_BUDGET_BLOWN' : 'TOKEN_BUDGET_EXCEEDED',
      message: `tokens ${totalTokens} > budget ${maxTokens}`,
      observed: totalTokens,
      expected: maxTokens,
    });
  }

  // max-overshoot model: penalty proportional to the worse-overshooting axis,
  // not the geometric product of independent overshoots.
  const worstOvershoot = Math.max(durOvershoot, tokOvershoot);
  return Math.max(0, 1 - worstOvershoot);
}

// ─────────────────────────────────────────────────────────────────────
// Math helpers
// ─────────────────────────────────────────────────────────────────────

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Renormalise weights so they sum to 1.0. Used after merging partial
 * scenario overrides over tier defaults so users can set "terminationCorrectness: 0.80"
 * as a ratio-style boost without manually balancing the other dims.
 */
function renormaliseWeights(weights: Required<DimensionWeights>): Required<DimensionWeights> {
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  if (sum <= 0 || !Number.isFinite(sum)) return weights;
  if (Math.abs(sum - 1) < 1e-9) return weights;
  const factor = 1 / sum;
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(weights)) {
    result[key] = value * factor;
  }
  return result as Required<DimensionWeights>;
}

/**
 * Weighted geometric mean with NEUTRAL IMPUTATION for missing dimensions.
 *
 * When a dimension's score is null (e.g. judge disabled), the previous
 * implementation skipped it AND renormalised remaining weights — but that
 * silently inflated overall by ~1/(1-w_missing). A `--no-judge` run scored
 * higher than the same run with judge=0.5, breaking comparability.
 *
 * The fix: impute the missing dim with the geo-mean of all PRESENT dims
 * (unbiased prior — "we have no information, so assume average"). The
 * weight stays in the denominator, so disabling a dimension is a true
 * no-op rather than a free uplift.
 */
/** Minimum score floor for non-critical dimensions before geo-mean computation.
 *  Prevents a single weak (but non-critical) dim from collapsing overall by >20x. */
const DIMENSION_FLOOR = 0.05;

function weightedGeometricMean(
  dimScores: Record<string, number | null>,
  weights: Record<string, number>,
): number {
  const EPS = 1e-6;
  // First pass: present-only mean for imputation.
  let presentLogSum = 0;
  let presentWeight = 0;
  for (const key of Object.keys(weights)) {
    const x = dimScores[key];
    if (x === null || x === undefined) continue;
    const w = weights[key]!;
    presentLogSum += w * Math.log(clamp01(x) + EPS);
    presentWeight += w;
  }
  if (presentWeight === 0) return 0;
  // The neutral imputed value (in log-space) is the present-only mean.
  // For a disabled dimension, this contributes weight·(presentMeanLog),
  // making its contribution exactly equal to the running mean — effectively
  // no change to overall.
  const presentMeanLog = presentLogSum / presentWeight;

  // Second pass: full denominator, present dims contribute their own log,
  // absent dims contribute the imputed (mean) log.
  let weightedLogSum = 0;
  let totalWeight = 0;
  for (const key of Object.keys(weights)) {
    const w = weights[key]!;
    const x = dimScores[key];
    const logX = (x === null || x === undefined)
      ? presentMeanLog
      : Math.log(clamp01(x) + EPS);
    weightedLogSum += w * logX;
    totalWeight += w;
  }
  if (totalWeight === 0) return 0;
  const raw = Math.exp(weightedLogSum / totalWeight) - EPS;
  return clamp01(raw);
}
