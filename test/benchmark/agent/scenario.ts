/**
 * Agent benchmark scenario definition (SOTA++ scoring contract v3).
 *
 * Each scenario defines:
 *   - A user query
 *   - Expected tool call sequence (with optional argument matchers + ordering)
 *   - Expected answer keywords + LLM-judge rubric + regex contracts
 *   - Constraints on step count, latency, and token cost
 *   - Adversarial expectations (must NOT call tools, expected block)
 *   - Grounding / fact-check / register / hallucination guards
 *   - Per-scenario dimension weight overrides
 *
 * v3 breaking change: `goldenEntityIds` removed — the field used slug-style IDs
 * (e.g. "opus-one-2018") but the real Vespa corpus stores vivino-hash IDs
 * (e.g. "vivino-36f895cf2938f29b"), making substring matching permanently 0%.
 * Replaced by `goldenKeywords`: canonical-label fragments that DO appear verbatim
 * in observation strings (e.g. "opus one", "château margaux").
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
  | 'adversarial'
  | 'wine_name_lookup'
  | 'taste_descriptor'
  | 'rating_score'
  | 'wine_type_basic'
  | 'negation_complex'
  | 'arithmetic_query'
  | 'bilingual_mixed'
  | 'cellar_aging';

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
  readonly faithfulness?: number;
  readonly contextRelevance?: number;
  readonly contextRecall?: number;
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
  /**
   * Regex patterns that MUST NOT match the answer.
   * Each hit applies a multiplicative penalty (PENALTY_MUST_NOT_MATCH = 0.20)
   * to answerQuality. NOT a critical-fail — judge scoring still runs and can
   * partially offset the penalty.
   *
   * Pattern authoring rules (SOTA++ v3):
   *  1. Anchor refusal patterns to sentence endings: `죄송합니다[.！\s]*$`
   *     NOT bare substrings like `죄송합니다` (matches polite preambles).
   *  2. Use specific verb forms, not bare nouns: `도와드리기\s*어렵`
   *     NOT `어렵` (too broad).
   *  3. Prefer `answerExcludes` for exact literal strings that must never appear.
   *  4. Do NOT use `\b` — it is ASCII-only and breaks on Korean/accented text.
   */
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

  // ─── Judge dependency ───
  /**
   * When true, this scenario's core constraint can ONLY be verified by the
   * LLM judge — the rule-based scorer cannot distinguish a correct from
   * incorrect answer. In --no-judge mode, these scenarios are scored but
   * their `overall` is marked unreliable in diagnostics.
   *
   * Set this on scenarios where `rubric` encodes the primary pass/fail
   * criterion (e.g. negation: "recommended wine must not be Cabernet").
   */
  readonly judgeRequired?: boolean;
}

export interface AgentBenchmarkScenario {
  readonly id: number;
  readonly tier: ScenarioTier;
  readonly query: string;
  readonly description: string;
  readonly expectation: ScenarioExpectation;
  /**
   * Canonical-label keywords that MUST appear in agent observations for the
   * scenario to be considered correctly retrieved. Used to compute RAGAS
   * contextRecall: |matched_keywords ∩ observations| / |goldenKeywords|.
   *
   * These are lowercase canonical-label fragments that appear verbatim in the
   * observation strings produced by summarizeSearchResults() — e.g. "opus one",
   * "château margaux". Case-insensitive, NFKC-normalized matching.
   *
   * Replaces the v2 `goldenEntityIds` field which used slug-style IDs that
   * never appeared in the actual Vespa corpus (corpus uses vivino-hash IDs).
   * When absent, contextRecall is null (excluded from geo-mean).
   */
  readonly goldenKeywords?: readonly string[];
  /** Severity tag for triage / dashboard weighting. */
  readonly severity?: Severity;
  /** Skip this scenario (e.g., requires Phase 2 features). */
  readonly skip?: string;
}
