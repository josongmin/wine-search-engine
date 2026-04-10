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
  'fruit_intensity',
  'finish',
  // LLM_ALLOWED_ATTRIBUTES에도 있는 속성들: hard 필터가 아닌 soft 신호로 처리해야 함.
  // 누락 시 "과일향" / "드링킹 윈도우" 등 쿼리가 하드 필터로 오분류되어 0 결과 반환.
  'producer_prestige',
  'finish_length',
  'drinking_window',
  'flavor_profile',
  'certification',
]);
