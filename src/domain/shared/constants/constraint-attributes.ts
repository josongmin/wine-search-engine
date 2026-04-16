/**
 * Attributes treated as soft constraints: ranking penalty only, NOT a Vespa WHERE clause filter.
 * SSoT — import from here, do not redefine.
 * Consumers: constraint-compiler.ts, planner.ts, result-grouper.ts
 *
 * A soft constraint attribute means: when the user specifies one of these,
 * apply a ranking penalty for mismatch rather than filtering results out.
 * Hard filtering on these attributes causes 0-result responses for queries
 * like "fruity", "dry", "for a dinner party" — they are preference signals,
 * not identity constraints.
 */
export const SOFT_CONSTRAINT_ATTRIBUTES: ReadonlySet<string> = new Set([
  'body',
  'sweetness',
  'acidity',
  'tannin',
  'style',
  'price_band',
  'occasion',
  'critic_score',
  // IMPORTANT: fruit_intensity has no backing field in HybridCandidate or Vespa schema.
  // It MUST remain in SOFT (not hard) — if removed, rule-based-constraint-extractor
  // constraints on this attribute become hard filters and produce 0 results.
  // annotateCandidateConstraintEvidence treats soft constraints with no backing field
  // as "not evaluable" (adds to matchedConstraints) so the ranker does not penalise
  // all results by accumulating totalWeight without weightedSum contribution.
  // TODO: wire Vespa `fruit_intensity` field projection → HybridCandidate.fruitIntensity
  // to make this soft signal actually do constraint matching.
  'fruit_intensity',
  // LLM_ALLOWED_ATTRIBUTES에도 있는 속성들: hard 필터가 아닌 soft 신호로 처리해야 함.
  // 누락 시 "과일향" / "드링킹 윈도우" 등 쿼리가 하드 필터로 오분류되어 0 결과 반환.
  'producer_prestige',
  // NOTE: 'finish' (bare) was removed — only 'finish_length' exists in HybridCandidate
  // and LLM_ALLOWED_ATTRIBUTES. Adding 'finish' back would silently break soft ranking.
  'finish_length',
  'drinking_window',
  'flavor_profile',
  'certification',
  // ETL Track C suitability scores — soft ranking 신호, hard 필터 아님.
  // 0-result 방지: "선물하기 좋은", "입문자용" 등의 쿼리가 hard 필터로 오분류되지 않도록 함.
  'gift_suitability',
  'beginner_suitability',
]);

/**
 * Style-oriented subset of SOFT_CONSTRAINT_ATTRIBUTES: sensory attributes that
 * describe a wine's tasting profile. Used to detect "style-only" queries in
 * planner.ts and to identify style signals in result-grouper.ts.
 *
 * SSoT — import from here; do not inline `['body', 'sweetness', 'acidity', 'tannin', 'style']`
 * at call sites (planner.ts and result-grouper.ts previously duplicated this list).
 */
export const STYLE_SENSORY_ATTRIBUTES: ReadonlySet<string> = new Set([
  'body',
  'sweetness',
  'acidity',
  'tannin',
  'style',
]);

/**
 * Geography attributes that use Vespa `contains` (substring) semantics at
 * retrieval time. Annotation-layer comparisons must mirror this so that a
 * candidate whose region field reads "Bordeaux AOC" is not falsely marked as
 * unmet when the constraint value is "Bordeaux".
 *
 * SSoT — import from here. Do NOT redefine in:
 *   - candidate-constraint-evidence.ts
 *   - constraint-to-sparse-filter-tokens.ts
 *   - any other consumer
 *
 * Rule 30: domain constants used in 2+ files belong in a shared module.
 */
export const GEOGRAPHY_ATTRIBUTES: ReadonlySet<string> = new Set([
  'country',
  'region',
  'appellation',
]);
