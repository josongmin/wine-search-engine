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
 * v3 breaking change: `goldenEntityIds` removed — substring checks against
 * `entity_id` in observations were brittle (ADR-007 now standardizes public
 * `entity_id` as canonical slugs; source-record ids stay in lineage only).
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

  // ─────────────────────────────────────────────────────────────────────
  // RFC-020: Constraint extraction ground truth
  // ─────────────────────────────────────────────────────────────────────

  /**
   * RFC-020 P1: Semantic Constraint Recall (SCR) ground truth.
   *
   * Hand-curated expected constraints that a correct NL Mapper + ontology
   * expansion + compositional inference pipeline should produce for this query.
   * Used by `scoreSemanticConstraintRecall()` to compute hard/soft/inferred
   * SCR bucket scores.
   *
   * Example for "보르도 2018 레드":
   * ```
   * expectedConstraints: {
   *   hard: [
   *     { attribute: 'region', value: 'Bordeaux', operator: '=' },
   *     { attribute: 'wine_type', value: 'red', operator: '=' },
   *     { attribute: 'vintage_year', value: 2018, operator: '>=' },
   *   ],
   *   soft: [
   *     { attribute: 'country', value: 'France', operator: '=' },  // ontology
   *   ],
   *   inferred: [
   *     { attribute: 'grape_family', value: ['Cabernet', 'Merlot'], operator: 'in' }, // compositional
   *     { attribute: 'tannin', value: 0.55, operator: '>=' },
   *   ],
   * }
   * ```
   *
   * Matching rules:
   * - Attribute + operator + value all must match (value is normalized NFKC lowercase for strings)
   * - Numeric ranges allow overlap (expected [30000, 50000] matches extracted [20000, 50000])
   * - Leave bucket undefined to skip that tier; leave whole field off to skip SCR entirely
   */
  readonly expectedConstraints?: {
    readonly hard?: readonly ExpectedConstraint[];
    readonly soft?: readonly ExpectedConstraint[];
    readonly inferred?: readonly ExpectedConstraint[];
  };

  /**
   * RFC-020 P2: Entity Linking Accuracy (ELA) ground truth.
   *
   * Hand-curated entity mentions expected from the raw query. Measured against
   * EntityResolver (RFC-019 Phase 2) output.
   *
   * Example for "보르도 vs 나파 카베르네":
   * ```
   * expectedEntities: [
   *   { surface: '보르도',   canonical: 'Bordeaux',           type: 'region' },
   *   { surface: '나파',     canonical: 'Napa Valley',        type: 'region' },
   *   { surface: '카베르네', canonical: 'Cabernet Sauvignon', type: 'grape_primary' },
   * ]
   * ```
   */
  readonly expectedEntities?: readonly ExpectedEntity[];
}

/**
 * RFC-020 P1: A single ground-truth constraint.
 *
 * Intentionally looser than domain NormalizedConstraint — `value` accepts any
 * primitive / object, and `operator` uses string literal to decouple scenario
 * file authoring from domain types.
 */
export interface ExpectedConstraint {
  readonly attribute: string;
  readonly operator: '=' | '<=' | '>=' | 'range' | 'in' | 'exclude';
  readonly value: string | number | readonly string[] | readonly number[] | { readonly min?: number; readonly max?: number };
}

/**
 * RFC-020 P2: A single ground-truth entity mention.
 *
 * `surface` = the raw text as it appears in the query (Korean or English).
 * `canonical` = the expected canonical label (e.g., 'Bordeaux', 'Cabernet Sauvignon').
 * `type` = which entity category; matches RFC-019 Phase 2 EntityType.
 */
export interface ExpectedEntity {
  readonly surface: string;
  readonly canonical: string;
  readonly type: 'wine_type' | 'country' | 'region' | 'appellation' | 'grape_primary';
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
   * Replaces the v2 `goldenEntityIds` field which compared against opaque ids
   * in observations instead of user-visible label tokens.
   * When absent, contextRecall is null (excluded from geo-mean).
   */
  readonly goldenKeywords?: readonly string[];
  /** Severity tag for triage / dashboard weighting. */
  readonly severity?: Severity;
  /** Skip this scenario (e.g., requires Phase 2 features). */
  readonly skip?: string;
}
