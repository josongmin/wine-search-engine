/**
 * Claim-level evaluation type system (RFC-020).
 *
 * Defines the taxonomy, verdicts, match types, and provenance model
 * for schema-aware claim extraction and verification in the wine domain.
 *
 * Design principles:
 *   - Faithfulness (grounded in retrieved context) is separated from
 *     accuracy (factually correct in the real world).
 *   - Structured claims (wine name, vintage, price) are verified deterministically.
 *   - Semantic claims (tasting notes, pairing) use LLM NLI verification.
 *   - Verdicts are 4-valued: entailed / partially_entailed / not_entailed / contradicted.
 *   - Provenance is field-level (wine_id + field path), not line-number based.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Claim taxonomy
// ─────────────────────────────────────────────────────────────────────────────

/** Claim categories — ordered by verification strategy determinism. */
export type ClaimCategory =
  | 'identity_claim'           // wine name, producer, label, entity_id
  | 'core_structured_claim'    // vintage, price, region, grape, country, wine_type
  | 'derived_structured_claim' // body, tannin, acidity, sweetness, rating, finish_length, style
  | 'semantic_claim'           // tasting note, pairing rationale, style description
  | 'comparative_claim';       // "A is bolder than B", "more expensive than C"

// ─────────────────────────────────────────────────────────────────────────────
// Wine field schema (derived from Vespa wine_entity.sd)
// ─────────────────────────────────────────────────────────────────────────────

/** Fields with deterministic verification via exact/range/hierarchy matching. */
export type WineStructuredField =
  | 'canonical_label' | 'producer' | 'region' | 'country' | 'appellation'
  | 'grape_primary' | 'grapes' | 'wine_type' | 'vintage_year'
  | 'price_usd' | 'price_band' | 'price_band_numeric'
  | 'body' | 'sweetness' | 'acidity' | 'tannin' | 'finish_length'
  | 'critic_score_normalized' | 'producer_prestige'
  | 'style' | 'alcohol_pct'
  | 'popularity_score'
  | 'pairing_tags' | 'profile_evidence' | 'claimable_attributes'
  | 'certifications' | 'classification' | 'oak_treatment'
  | 'grape_family' | 'region_hierarchy'
  | 'drinking_window_start' | 'drinking_window_end'
  | 'comparison_concept';

/** Fields requiring LLM semantic verification (NLI). */
export type WineSemanticField =
  | 'tasting_notes' | 'style_description' | 'pairing_rationale'
  | 'serving_suggestion' | 'aging_potential' | 'general_opinion'
  | 'flavor_profiles' | 'occasion';

/** Union of all wine fields — covers the full domain schema. */
export type WineField = WineStructuredField | WineSemanticField;

// ─────────────────────────────────────────────────────────────────────────────
// Provenance anchoring (field-level, not line-number)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Source of evidence for a claim.
 *
 * Discriminated union — each variant identifies where the evidence came from
 * in the retrieval/generation pipeline.
 */
export type ProvenanceSource =
  | { readonly type: 'retrieval'; readonly entityId: string; readonly channel: string }
  | { readonly type: 'tool_observation'; readonly stepIndex: number; readonly toolName: string }
  | { readonly type: 'knowledge_base'; readonly reference: string }
  | { readonly type: 'unanchored' };

/**
 * Field-level provenance anchor.
 *
 * Stable across re-renders (unlike line numbers). Ties a claim to a specific
 * field in a specific wine entity from a specific evidence source.
 */
export interface FieldAnchor {
  /** Entity ID of the wine this evidence is about. */
  readonly wineId: string;
  /** Schema field the evidence covers. */
  readonly field: WineField;
  /** The value from the evidence source. */
  readonly value: string;
  /** Where this evidence originated in the pipeline. */
  readonly source: ProvenanceSource;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extracted claims
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single atomic claim extracted from the agent's answer.
 *
 * Each claim is typed by category and anchored to a schema field,
 * enabling automatic routing to the appropriate verifier.
 */
export interface ExtractedClaim {
  /** Stable identifier — deterministic hash of (category, field, value, wineId). */
  readonly id: string;
  /** Claim category — determines verification strategy. */
  readonly category: ClaimCategory;
  /** Schema field this claim is about. */
  readonly field: WineField;
  /** Raw claim value as stated in the answer. */
  readonly value: string;
  /** Canonical form after domain-specific normalization (NFKC, alias resolution). */
  readonly normalizedValue: string;
  /** The text span from the answer that contains this claim. */
  readonly sourceText: string;
  /** Entity ID of the wine this claim refers to (if identifiable). */
  readonly wineId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdicts (4-valued)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Four-valued verdict for claim verification.
 *
 * - entailed:            claim directly supported by evidence
 * - partially_entailed:  partially supported (e.g. region correct but sub-region wrong)
 * - not_entailed:        no evidence for or against (neutral)
 * - contradicted:        claim directly contradicts evidence
 */
export type ClaimVerdict =
  | 'entailed'
  | 'partially_entailed'
  | 'not_entailed'
  | 'contradicted';

/** Verdict → numeric score for aggregation. */
export const VERDICT_SCORES: Readonly<Record<ClaimVerdict, number>> = {
  entailed: 1.0,
  partially_entailed: 0.5,
  not_entailed: 0.0,
  contradicted: 0.0,
};

// ─────────────────────────────────────────────────────────────────────────────
// Match types (graduated, not binary)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How the match between claim and evidence was determined.
 *
 * Ordered from strongest to weakest:
 *   exact > normalized > hierarchy > range > semantic > no_match
 */
export type MatchType =
  | 'exact_match'       // string identity after NFKC normalization
  | 'normalized_match'  // canonical form equivalence ("Cab Sauv" = "Cabernet Sauvignon")
  | 'hierarchy_match'   // ontological subsumption ("Pauillac" ⊂ "Bordeaux")
  | 'range_match'       // numeric within tolerance (price ±15%, body ±0.15)
  | 'semantic_match'    // LLM-assessed meaning equivalence
  | 'no_match';         // failed all match strategies

/** Result of a single match attempt. */
export interface MatchResult {
  /** Which match strategy succeeded (or no_match). */
  readonly type: MatchType;
  /** Confidence in the match [0, 1]. */
  readonly score: number;
  /** Human-readable explanation (e.g. "hierarchy: Pauillac ⊂ Bordeaux"). */
  readonly details: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Verifier types
// ─────────────────────────────────────────────────────────────────────────────

/** Which verification engine handled the claim. */
export type VerifierType = 'deterministic' | 'llm_semantic' | 'hybrid';

/** Status of the verification call — distinguishes legitimate verdicts from failures. */
export type VerifierStatus = 'ok' | 'skipped_no_llm' | 'llm_failed' | 'parse_failed' | 'missing_in_response';

/**
 * Full verification result for a single claim.
 *
 * Produced by the verifier after checking a claim against evidence.
 */
export interface ClaimVerification {
  /** ID of the claim that was verified. */
  readonly claimId: string;
  /** 4-valued verdict. */
  readonly verdict: ClaimVerdict;
  /** How the match was determined. */
  readonly matchType: MatchType;
  /** Which verifier handled this claim. */
  readonly verifierUsed: VerifierType;
  /** Whether the verification call itself succeeded. 'ok' means the verdict is meaningful. */
  readonly status: VerifierStatus;
  /** What evidence was used for verification. */
  readonly evidenceAnchor?: FieldAnchor;
  /** Verifier confidence [0, 1]. */
  readonly confidence: number;
  /** Human-readable explanation (LLM verifier fills this). */
  readonly explanation?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Verifier routing
// ─────────────────────────────────────────────────────────────────────────────

/** Claim category → verifier type routing table. */
export const VERIFIER_ROUTING: Readonly<Record<ClaimCategory, VerifierType>> = {
  identity_claim: 'deterministic',
  core_structured_claim: 'deterministic',
  derived_structured_claim: 'hybrid',
  semantic_claim: 'llm_semantic',
  comparative_claim: 'llm_semantic',
};

// ─────────────────────────────────────────────────────────────────────────────
// Claim criticality
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Weight multiplier for each claim category in aggregation.
 *
 * Identity claims (wine name wrong = catastrophic) are weighted higher
 * than semantic claims (pairing suggestion slightly off = minor).
 */
export const CLAIM_CATEGORY_WEIGHTS: Readonly<Record<ClaimCategory, number>> = {
  identity_claim: 3.0,
  core_structured_claim: 2.0,
  derived_structured_claim: 1.5,
  semantic_claim: 1.0,
  comparative_claim: 1.0,
};

/**
 * Whether a contradiction on this category triggers a critical failure
 * (answer-level score collapse to 0) — depends on task type.
 */
export type TaskType =
  | 'single_recommendation' // one wine, exact match matters
  | 'multi_recommendation'  // multiple candidates, candidate-level fail
  | 'general_query'         // price range, region info — softer matching
  | 'comparison_query';     // comparing wines — both must be correct

/**
 * Hard-fail policy per task type × claim category.
 *
 * true = contradiction on this category for this task type triggers critical failure.
 * false = penalty only, no hard fail.
 */
export const HARD_FAIL_POLICY: Readonly<Record<TaskType, Readonly<Record<ClaimCategory, boolean>>>> = {
  single_recommendation: {
    identity_claim: true,
    core_structured_claim: true,
    derived_structured_claim: false,
    semantic_claim: false,
    comparative_claim: false,
  },
  multi_recommendation: {
    identity_claim: true, // hallucinated wine name fails the answer regardless of count
    core_structured_claim: false,
    derived_structured_claim: false,
    semantic_claim: false,
    comparative_claim: false,
  },
  general_query: {
    identity_claim: false, // educational/info queries — knowledge slips penalize via score, not hard-fail
    core_structured_claim: false,
    derived_structured_claim: false,
    semantic_claim: false,
    comparative_claim: false,
  },
  comparison_query: {
    identity_claim: true,
    core_structured_claim: true,
    derived_structured_claim: false,
    semantic_claim: false,
    comparative_claim: true,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostic vector
// ─────────────────────────────────────────────────────────────────────────────

/** Per-category breakdown in the diagnostic vector. */
export interface CategoryDiagnostic {
  readonly claimCount: number;
  readonly entailedCount: number;
  readonly partiallyEntailedCount: number;
  readonly notEntailedCount: number;
  readonly contradictedCount: number;
  readonly avgConfidence: number;
  readonly weightedScore: number;
}

/**
 * Full diagnostic vector — replaces single faithfulness float.
 *
 * Provides claim-level error profile for debugging, not just a number.
 * Each rate is in [0, 1].
 */
export interface DiagnosticVector {
  // ── Primary metric ──────────────────────────────────────────────────
  /** Weighted mean of claim verdict scores (status='ok' subset only).
   *  See ADR-016 §2.8 for dual-reporting rationale. */
  readonly faithfulnessScore: number;
  /** ADR-016 §2.8 — weighted mean across ALL verifications (no
   *  `status === 'ok'` filter; skipped claims count as `not_entailed`).
   *  Surfaced so operators can't cherry-pick the favourable number —
   *  the effective gate is `min(faithfulnessScore, faithfulnessScoreAll)`. */
  readonly faithfulnessScoreAll: number;

  // ── Error rates ─────────────────────────────────────────────────────
  /** contradicted / (entailed + partially_entailed + contradicted). Excludes not_entailed. */
  readonly contradictionRate: number;
  /** Contradictions on identity + core_structured claims / total such claims. */
  readonly criticalErrorRate: number;
  /** not_entailed semantic claims / total semantic claims. */
  readonly unsupportedSoftClaimRate: number;

  // ── Coverage ────────────────────────────────────────────────────────
  /** Claims with a FieldAnchor / total claims. */
  readonly provenanceCoverage: number;
  /** Claims verified deterministically / total claims. */
  readonly deterministicCoverage: number;

  // ── Cost ────────────────────────────────────────────────────────────
  /** Number of LLM verifier calls used. */
  readonly llmCallCount: number;
  /** Number of deterministic checks performed. */
  readonly deterministicCheckCount: number;
  /** Number of claims with status='ok' (used in faithfulness denominators). */
  readonly verifiedClaimCount: number;
  /** Number of claims with status!='ok' (skipped due to LLM unavailability or failure). */
  readonly skippedClaimCount: number;

  // ── Per-category breakdown ──────────────────────────────────────────
  readonly perCategory: Readonly<Record<ClaimCategory, CategoryDiagnostic>>;

  // ── Raw data ────────────────────────────────────────────────────────
  /** All extracted claims. */
  readonly claims: readonly ExtractedClaim[];
  /** All verification results. */
  readonly verifications: readonly ClaimVerification[];

  // ── Hard-fail signal ────────────────────────────────────────────────
  /** Whether any critical error triggered a hard fail. */
  readonly hardFail: boolean;
  /** Reason for hard fail, if any. */
  readonly hardFailReason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Range match tolerances (domain-justified)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-field range tolerance for numeric matching.
 *
 * Each tolerance is a fraction or absolute value:
 *   - fraction: relative tolerance (e.g. 0.15 = ±15%)
 *   - absolute: absolute tolerance (e.g. 1 = ±1 year)
 */
export interface RangeTolerance {
  readonly mode: 'fraction' | 'absolute';
  readonly value: number;
}

/** Domain-justified range tolerances per structured field. */
export const RANGE_TOLERANCES: Readonly<Partial<Record<WineStructuredField, RangeTolerance>>> = {
  vintage_year: { mode: 'absolute', value: 0 },          // exact match only
  price_usd: { mode: 'fraction', value: 0.15 },          // ±15%
  price_band_numeric: { mode: 'absolute', value: 0 },    // exact match
  body: { mode: 'absolute', value: 0.15 },               // ±0.15 on [0,1]
  sweetness: { mode: 'absolute', value: 0.15 },
  acidity: { mode: 'absolute', value: 0.15 },
  tannin: { mode: 'absolute', value: 0.15 },
  finish_length: { mode: 'absolute', value: 0.15 },
  alcohol_pct: { mode: 'absolute', value: 1.0 },         // ±1% ABV
  critic_score_normalized: { mode: 'absolute', value: 0.02 }, // ±2 points on [0,1]
  producer_prestige: { mode: 'absolute', value: 0.1 },
  popularity_score: { mode: 'absolute', value: 0.1 },
  drinking_window_start: { mode: 'absolute', value: 2 }, // ±2 years
  drinking_window_end: { mode: 'absolute', value: 3 },   // ±3 years
};
