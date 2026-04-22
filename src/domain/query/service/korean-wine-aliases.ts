/**
 * Korean wine surface typo / entity-slang → canonical form mapping.
 *
 * Used by the Planner to correct common Korean misspellings and
 * abbreviations before anchor extraction and search.
 *
 * Format: [typo/slang, canonical form]
 *
 * This table is intentionally limited to lexical entity surfaces. Do not add
 * semantic chat slang such as "ㄱㅊ": those are preference meanings and must
 * flow through planner/LLM semantic interpretation as typed constraints, not
 * query-string mutation.
 */
const KOREAN_WINE_ALIAS_CORRECTIONS: ReadonlyMap<string, string> = new Map([
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

  // Entity / variety abbreviations
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
 *
 * The input is NFC-normalized before matching so that decomposed Hangul
 * (e.g. client sending 'ㅇ+ㅗ+ㅍ+ㅓ+ㅅ+ㅡ+ㅇ+ㅝ+ㄴ') still hits the typo table.
 * Without NFC normalization the bare `includes()` check silently misses.
 */
export function correctKoreanWineTypos(query: string): string {
  let corrected = query.normalize('NFC');
  for (const [typo, canonical] of KOREAN_WINE_ALIAS_CORRECTIONS) {
    if (corrected.includes(typo)) {
      corrected = corrected.replaceAll(typo, canonical);
    }
  }
  return corrected;
}
