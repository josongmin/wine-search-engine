/**
 * Korean wine typo/slang → canonical form mapping.
 *
 * Used by the Planner to correct common Korean misspellings and
 * abbreviations before anchor extraction and search.
 *
 * Format: [typo/slang, canonical form]
 */
export const KOREAN_WINE_ALIAS_CORRECTIONS: ReadonlyMap<string, string> = new Map([
  // Typos (common misspellings)
  ['오퍼스원', '오푸스원'],
  ['오퍼스 원', '오푸스원'],
  ['샤또마고', '샤토 마고'],
  ['샤또 마고', '샤토 마고'],
  ['돔페리뇽', '돔 페리뇽'],
  ['돔페리용', '돔 페리뇽'],
  ['그래인지', '그레인지'],
  ['사시까이아', '사시카이아'],
  ['쌔시까이아', '사시카이아'],

  // Abbreviations (slang)
  ['까쇼', '카베르네 소비뇽'],
  ['까소', '카베르네 소비뇽'],
  ['쇼비', '소비뇽 블랑'],
  ['피누', '피노 누아르'],
  ['리즐링', '리슬링'],
  ['샴페인', '샴페인'],
  ['보누', '보졸레 누보'],
  ['보졸레누보', '보졸레 누보'],
]);

/**
 * Applies Korean wine alias corrections to a query string.
 * Replaces known typos/abbreviations with canonical forms.
 */
export function correctKoreanWineTypos(query: string): string {
  let corrected = query;
  for (const [typo, canonical] of KOREAN_WINE_ALIAS_CORRECTIONS) {
    if (corrected.includes(typo)) {
      corrected = corrected.replaceAll(typo, canonical);
    }
  }
  return corrected;
}
