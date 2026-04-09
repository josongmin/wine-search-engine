/**
 * LTR feature extraction (Epic-10 SOTA++ Real LTR foundation).
 *
 * Produces a fixed-shape feature vector from a retrieved candidate plus
 * its query context. The vector is consumed by:
 *   - LightGBM LambdaMART training pipeline (offline)
 *   - Vespa second-phase rerank (when serve parity is verified)
 *   - Online observability / drift monitoring
 *
 * Features are deterministic, side-effect-free, and computed without LLM
 * calls. Raw values are NOT clamped here — clamping is the LTR caller's
 * responsibility (some models prefer raw signals; others want [0, 1]).
 */

import type { HybridCandidate } from '../../retrieval/model/hybrid-candidate.js';
import { containsHangul } from '../../shared/utils/hangul.js';
import type { NormalizedConstraint } from '../../shared/types/index.js';

/** Default neutral confidence when a signal cannot be measured. */
const DEFAULT_NEUTRAL_CONFIDENCE = 0.5;
/** Score for partial label match: query contains canonical label as substring. */
const PARTIAL_LABEL_MATCH_SCORE = 0.5;
/** Hangul Syllables block — used to detect Korean queries. */
// Hangul detection delegates to @shared/utils/hangul (SSoT).
/**
 * Returns the current calendar year. Recomputed per call to avoid a
 * year-rollover bug for long-lived processes: a module-scope constant
 * initialized at load time would go stale on Dec 31 → Jan 1 and mis-classify
 * drinking-window ranges for an entire year until the process restarts.
 * `new Date().getFullYear()` is cheap enough to call N times per query.
 */
function ltrCurrentYear(): number {
  return new Date().getFullYear();
}

export interface LTRFeatureVector {
  // Retrieval signals (5)
  readonly bm25_score: number;
  readonly dense_score: number;
  readonly anchor_score: number;
  readonly fusion_score: number;
  readonly cross_channel_overlap: number;

  // Constraint match signals (5)
  readonly hard_constraint_match_ratio: number;
  readonly soft_constraint_match_ratio: number;
  readonly inferred_constraint_match_ratio: number;
  readonly constraint_violation_count: number;
  readonly constraint_satisfaction_confidence: number;

  // Entity signals (4)
  readonly entity_link_confidence: number;
  readonly canonical_label_match: number;
  readonly producer_match: number;
  readonly region_match: number;

  // Quality signals (4)
  readonly critic_score_normalized: number;
  readonly producer_prestige: number;
  readonly popularity_score: number;
  readonly drinking_window_in_range: number;

  // Query-doc cross signals (4)
  readonly query_length_tokens: number;
  readonly query_has_korean: number;
  readonly doc_label_korean_alias_match: number;
  readonly query_doc_script_compat: number;

  // Degradation signals (4)
  readonly is_dense_degraded: number;
  readonly is_sparse_degraded: number;
  readonly is_anchor_degraded: number;
  readonly degraded_channel_count: number;
}

export interface LTRFeatureExtractionInput {
  readonly query: string;
  readonly normalizedQuery: string;
  readonly candidate: HybridCandidate;
  readonly hardConstraints: readonly NormalizedConstraint[];
  readonly softConstraints: readonly NormalizedConstraint[];
  readonly inferredConstraints?: readonly NormalizedConstraint[];
  readonly degradationFlags: {
    readonly dense: boolean;
    readonly sparse: boolean;
    readonly anchor: boolean;
  };
  readonly entityLinkConfidence?: number;
}

function safeNumber(value: unknown, fallback = 0): number {
  if (typeof value !== 'number') return fallback;
  return Number.isFinite(value) ? value : fallback;
}

function countSatisfiedConstraints(
  matchedSet: ReadonlySet<string>,
  constraints: readonly NormalizedConstraint[],
): { satisfied: number; total: number } {
  if (constraints.length === 0) return { satisfied: 0, total: 0 };
  let satisfied = 0;
  for (const c of constraints) {
    if (matchedSet.has(c.attribute)) satisfied++;
  }
  return { satisfied, total: constraints.length };
}

function ratio(satisfied: number, total: number): number {
  return total > 0 ? satisfied / total : 0;
}

/**
 * Extract a fixed-shape LTR feature vector from a retrieved candidate.
 * Pure function — no I/O, no clamping, deterministic for the same input.
 */
export function extractLTRFeatures(input: LTRFeatureExtractionInput): LTRFeatureVector {
  const c = input.candidate;
  const q = input.normalizedQuery;
  const qTokens = q.length === 0 ? 0 : q.split(/\s+/u).filter((s) => s.length > 0).length;
  const hasKorean = containsHangul(input.query) ? 1 : 0;

  // Retrieval signals
  const bm25 = safeNumber((c as { sparseRawScore?: number }).sparseRawScore, 0);
  const dense = safeNumber((c as { denseRawScore?: number }).denseRawScore, 0);
  const anchor = safeNumber((c as { anchorRawScore?: number }).anchorRawScore, 0);
  // fusionRrfTotal is the canonical RRF total, set only by FusionService.
  // Browse/Compare candidates bypass fusion → fusionRrfTotal absent → 0.
  // 0 is correct: absence of fusion data means "no multi-channel agreement"
  // which the LTR model can learn to weight accordingly.
  const fusion = safeNumber(
    (c as { fusionRrfTotal?: number }).fusionRrfTotal,
    0,
  );
  let crossChannel = 0;
  if ((c as { sparseRank?: number }).sparseRank !== undefined) crossChannel++;
  if ((c as { denseRank?: number }).denseRank !== undefined) crossChannel++;
  if ((c as { anchorRank?: number }).anchorRank !== undefined) crossChannel++;
  if ((c as { learnedSparseRank?: number }).learnedSparseRank !== undefined) crossChannel++;

  // Constraint match signals — precompute matched set once (Rule 16: avoid
  // per-function Set allocation when the same data is reused across calls).
  const matchedSet = new Set(c.matchedConstraints);
  const hardMatch = countSatisfiedConstraints(matchedSet, input.hardConstraints);
  const softMatch = countSatisfiedConstraints(matchedSet, input.softConstraints);
  const inferredMatch = countSatisfiedConstraints(matchedSet, input.inferredConstraints ?? []);
  const violationList = (c as { unmetHardConstraints?: readonly unknown[] }).unmetHardConstraints ?? [];

  // Entity signals — lowercase query once, reuse across all comparisons
  // (avoids N string allocations per candidate for each .toLowerCase() call)
  const qLower = q.toLowerCase();
  const labelLower = c.canonicalLabel?.toLowerCase();
  const labelMatch = labelLower !== undefined && labelLower.includes(qLower) ? 1 :
    labelLower !== undefined && qLower.includes(labelLower) ? PARTIAL_LABEL_MATCH_SCORE : 0;
  const producerLower = c.producer?.toLowerCase();
  const producerMatch = producerLower !== undefined && qLower.includes(producerLower) ? 1 : 0;
  const regionLower = c.region?.toLowerCase();
  const regionMatch = regionLower !== undefined && qLower.includes(regionLower) ? 1 : 0;

  // Quality signals
  const critic = safeNumber((c as { criticScoreNormalized?: number }).criticScoreNormalized, 0);
  const prestige = safeNumber((c as { producerPrestige?: number }).producerPrestige, 0);
  const popularity = safeNumber((c as { popularityScore?: number }).popularityScore, 0);
  const dwStart = safeNumber(c.drinkingWindowStart, 0);
  const dwEnd = safeNumber(c.drinkingWindowEnd, 0);
  const currentYear = ltrCurrentYear();
  const dwInRange = dwStart > 0 && dwEnd > 0 && currentYear >= dwStart && currentYear <= dwEnd ? 1 : 0;

  // Korean alias match
  const docHasKoreanAlias = c.searchTextKo !== undefined && c.searchTextKo.length > 0;
  const koreanAliasMatch = hasKorean === 1 && docHasKoreanAlias ? 1 : 0;
  const scriptCompat = hasKorean === 1
    ? (docHasKoreanAlias ? 1 : 0)
    : 1;

  // Degradation signals
  const dDense = input.degradationFlags.dense ? 1 : 0;
  const dSparse = input.degradationFlags.sparse ? 1 : 0;
  const dAnchor = input.degradationFlags.anchor ? 1 : 0;

  return {
    bm25_score: bm25,
    dense_score: dense,
    anchor_score: anchor,
    fusion_score: fusion,
    cross_channel_overlap: crossChannel,

    hard_constraint_match_ratio: ratio(hardMatch.satisfied, hardMatch.total),
    soft_constraint_match_ratio: ratio(softMatch.satisfied, softMatch.total),
    inferred_constraint_match_ratio: ratio(inferredMatch.satisfied, inferredMatch.total),
    constraint_violation_count: violationList.length,
    // When zero hard constraints exist, satisfaction is trivially perfect (1.0):
    // there are no constraints to violate. DEFAULT_NEUTRAL_CONFIDENCE (0.5)
    // was incorrect here — it penalized unconstrained queries as if they were
    // 50% unsatisfied. Identified in Phase B audit round 3.
    constraint_satisfaction_confidence: hardMatch.total > 0
      ? hardMatch.satisfied / hardMatch.total
      : 1.0,

    entity_link_confidence: safeNumber(input.entityLinkConfidence, DEFAULT_NEUTRAL_CONFIDENCE),
    canonical_label_match: labelMatch,
    producer_match: producerMatch,
    region_match: regionMatch,

    critic_score_normalized: critic,
    producer_prestige: prestige,
    popularity_score: popularity,
    drinking_window_in_range: dwInRange,

    query_length_tokens: qTokens,
    query_has_korean: hasKorean,
    doc_label_korean_alias_match: koreanAliasMatch,
    query_doc_script_compat: scriptCompat,

    is_dense_degraded: dDense,
    is_sparse_degraded: dSparse,
    is_anchor_degraded: dAnchor,
    degraded_channel_count: dDense + dSparse + dAnchor,
  };
}

/** Stable list of LTR feature names — used for parity hashing. */
export const LTR_FEATURE_NAMES: readonly (keyof LTRFeatureVector)[] = [
  'bm25_score',
  'dense_score',
  'anchor_score',
  'fusion_score',
  'cross_channel_overlap',
  'hard_constraint_match_ratio',
  'soft_constraint_match_ratio',
  'inferred_constraint_match_ratio',
  'constraint_violation_count',
  'constraint_satisfaction_confidence',
  'entity_link_confidence',
  'canonical_label_match',
  'producer_match',
  'region_match',
  'critic_score_normalized',
  'producer_prestige',
  'popularity_score',
  'drinking_window_in_range',
  'query_length_tokens',
  'query_has_korean',
  'doc_label_korean_alias_match',
  'query_doc_script_compat',
  'is_dense_degraded',
  'is_sparse_degraded',
  'is_anchor_degraded',
  'degraded_channel_count',
] as const;
