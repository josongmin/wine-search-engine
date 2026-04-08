/**
 * Agent benchmark scenario definition (SOTA++ scoring contract v2).
 *
 * Each scenario defines:
 *   - A user query
 *   - Expected tool call sequence (with optional argument matchers + ordering)
 *   - Expected answer keywords + LLM-judge rubric + regex contracts
 *   - Constraints on step count, latency, and token cost
 *   - Adversarial expectations (must NOT call tools, expected block)
 *   - Grounding / fact-check / register / hallucination guards
 *   - Per-scenario dimension weight overrides
 */

export type ScenarioTier =
  | 'single_shot'
  | 'multi_step'
  | 'complex_reasoning'
  | 'conversational'
  | 'edge_case'
  | 'nested_condition'
  | 'comparison_nested'
  | 'relative_reference'
  | 'situation_based'
  | 'negation'
  | 'knowledge_hybrid'
  | 'extreme'
  | 'korean_colloquial'
  | 'price_expression'
  | 'mood_atmosphere'
  | 'korean_food_pairing'
  | 'gift_refined'
  | 'seasonal_temporal'
  | 'adversarial';

export type AttackType =
  | 'prompt_injection'
  | 'jailbreak'
  | 'indirect_injection'
  | 'token_smuggling'
  | 'resource_exhaustion'
  | 'off_domain'
  | 'pii_extraction'
  | 'hallucination_bait'
  | 'sql_injection'
  | 'output_hijack';

export type Severity = 'critical' | 'major' | 'minor';

export interface ExpectedToolCall {
  readonly tool: string;
  /** If set, the tool's input must include each substring (case-insensitive). */
  readonly inputContains?: readonly string[];
}

/**
 * Termination categories accepted by scorer.
 *
 * - 'answer'    — agent produced a final answer (success path)
 * - 'fallback'  — max-steps exhausted; agent gave up. SCORED 0 by default.
 * - 'blocked'   — security gate or content policy stopped the agent
 * - 'error'     — runtime exception
 * - 'timeout'   — wall-clock budget exceeded
 */
export type TerminationReason = 'answer' | 'fallback' | 'blocked' | 'error' | 'timeout';

/**
 * Per-scenario weight overrides for the scoring dimensions. Keys mirror
 * scorer.DimensionWeights — undefined keys fall back to TIER_WEIGHTS or
 * DEFAULT_WEIGHTS in scorer.ts.
 */
export interface ScenarioDimensionWeights {
  readonly executionEfficiency?: number;
  readonly answerQuality?: number;
  readonly terminationCorrectness?: number;
  readonly costEfficiency?: number;
  readonly judge?: number;
}

export interface ScenarioExpectation {
  /** Tools that SHOULD be called. */
  readonly tools?: readonly ExpectedToolCall[];
  /** When true, expected tools must be called in the listed order. */
  readonly ordered?: boolean;
  /**
   * Tools that MUST NOT appear in the call trace. Used by adversarial
   * scenarios to ensure injection attempts don't slip into a tool call.
   */
  readonly mustNotCallTools?: readonly string[];
  /** Maximum allowed step count. */
  readonly maxSteps: number;
  /** Optional latency budget — exceeded → cost dimension penalised. */
  readonly maxDurationMs?: number;
  /** Optional token budget (input+output combined). */
  readonly maxTotalTokens?: number;
  /** Substrings that MUST appear in the final answer (case-insensitive, NFKC). */
  readonly answerContains?: readonly string[];
  /** Substrings that must NOT appear in the answer. CRITICAL fail on violation. */
  readonly answerExcludes?: readonly string[];
  /** Regex patterns that ALL must match the answer. */
  readonly answerMustMatch?: readonly string[];
  /** Regex patterns that MUST NOT match the answer. CRITICAL fail on hit. */
  readonly answerMustNotMatch?: readonly string[];
  /**
   * Free-form rubric for the LLM-as-judge dimension. The rubric is evaluated
   * by a separate judge LLM call returning 0..1. When undefined, the judge
   * dimension is excluded from the geometric mean (no penalty, no inflation).
   */
  readonly rubric?: string;
  /** Expected termination reason. */
  readonly terminationReason?: TerminationReason;
  /**
   * For adversarial scenarios that must be blocked. When true, scorer
   * requires terminationReason='blocked' OR an empty tool trace.
   */
  readonly expectedBlocked?: boolean;

  // ─── Grounding / fact-check (P2-11 schema extensions) ───
  /** At least one of these entity IDs must appear in tool result citations. */
  readonly expectedEntityIds?: readonly string[];
  /** None of these entity IDs may appear (hallucination blacklist). */
  readonly forbiddenEntityIds?: readonly string[];
  /** When true, every wine in the answer must be cited from tool results. */
  readonly mustCiteFromToolResults?: boolean;
  /** Free-form factual claims for the judge to verify. */
  readonly factCheckClaims?: readonly { readonly claim: string; readonly mustBeTrue: boolean }[];

  // ─── Numeric bounds ───
  readonly priceBandKrw?: { readonly min?: number; readonly max?: number };
  readonly vintageRange?: { readonly min?: number; readonly max?: number };
  readonly drinkingWindowStatus?: 'now' | 'hold' | 'past' | 'any';

  // ─── Tool argument quality ───
  readonly expectedToolArgs?: readonly {
    readonly tool: string;
    readonly argPath: string; // dot-path e.g. "filters.priceMaxKrw"
    readonly predicate: 'equals' | 'lte' | 'gte' | 'contains' | 'exists';
    readonly value?: unknown;
  }[];

  // ─── Confidence & register ───
  readonly requireHedging?: boolean;
  readonly requiredRegister?: 'formal' | 'casual';
  readonly maxConfidence?: number;
  readonly refusalExpected?: boolean;

  // ─── Adversarial taxonomy ───
  readonly attackType?: AttackType;

  // ─── Per-scenario weight overrides ───
  readonly weights?: ScenarioDimensionWeights;
}

export interface AgentBenchmarkScenario {
  readonly id: number;
  readonly tier: ScenarioTier;
  readonly query: string;
  readonly description: string;
  readonly expectation: ScenarioExpectation;
  /** Severity tag for triage / dashboard weighting. */
  readonly severity?: Severity;
  /** Skip this scenario (e.g., requires Phase 2 features). */
  readonly skip?: string;
}
