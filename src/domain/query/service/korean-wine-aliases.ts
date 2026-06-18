import { extractQueryVintageYear } from '../../shared/utils/vintage.js';

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
export const KOREAN_WINE_ALIAS_CORRECTION_ENTRIES = [
  // Typos (common misspellings)
  ['오퍼스원', '오푸스원'],
  ['오퍼스 원', '오푸스원'],
  ['오 퍼 스 원', '오푸스원'],
  ['오 푸 스 원', '오푸스원'],
  ['샤또마고', '샤토 마고'],
  ['샤또 마고', '샤토 마고'],
  ['샤토마고', '샤토 마고'],
  ['샤또 라뚜르', '샤토 라투르'],
  ['샤토 라피트', '샤또 라피트'],
  ['샤토 라피트 로칠드', '샤또 라피트'],
  ['샤토 라피트 로쉴드', '샤또 라피트'],
  ['샤또 라피트 로칠드', '샤또 라피트'],
  ['샤또 라피트 로쉴드', '샤또 라피트'],
  ['샤또 라피뜨 로쉴드', '샤또 라피트'],
  ['라피트 로칠드', '샤또 라피트'],
  ['라피트 로쉴드', '샤또 라피트'],
  ['라피뜨 로쉴드', '샤또 라피트'],
  ['샤토 무통', '샤또 무통'],
  ['샤토 무통 로칠드', '샤또 무통'],
  ['샤토 무통 로쉴드', '샤또 무통'],
  ['샤토 무똥 로칠드', '샤또 무통'],
  ['샤또 무통 로칠드', '샤또 무통'],
  ['샤또 무똥 로쉴드', '샤또 무통'],
  ['무통 로쉴드', '샤또 무통'],
  ['무똥 로칠드', '샤또 무통'],
  ['무똥 로쉴드', '샤또 무통'],
  ['샤토 오브리옹', '샤또 오브리옹'],
  ['샤토 오 브리옹', '샤또 오브리옹'],
  ['샤또 오 브리옹', '샤또 오브리옹'],
  ['샤토 오-브리옹', '샤또 오브리옹'],
  ['샤또 오-브리옹', '샤또 오브리옹'],
  ['오-브리옹', '오브리옹'],
  ['샤토 디켐', '샤또 디켐'],
  ['샤토 디껨', '샤또 디켐'],
  ['샤또 디껨', '샤또 디켐'],
  ['샤또디켐', '샤또 디켐'],
  ['샤토디켐', '샤또 디켐'],
  ['샤또디껨', '샤또 디켐'],
  ['샤토디껨', '샤또 디켐'],
  ['샤토 슈발 블랑', '슈발 블랑'],
  ['샤또 슈발 블랑', '슈발 블랑'],
  ['샤토슈발블랑', '슈발 블랑'],
  ['샤또슈발블랑', '슈발 블랑'],
  ['로마네콩티', '로마네 콩티'],
  ['로마네꽁띠', '로마네 콩티'],
  ['로마네 꽁띠', '로마네 콩티'],
  ['로마네 꽁티', '로마네 콩티'],
  ['로마네 콘티', '로마네 콩티'],
  ['도멘 드 라 로마네 콩티', '로마네 콩티'],
  ['도멘 드 라 로마네 꽁띠', '로마네 콩티'],
  ['도멘 드 라 로마네 콘티', '로마네 콩티'],
  ['돔페리뇽', '돔 페리뇽'],
  ['돔페리용', '돔 페리뇽'],
  ['돔페리농', '돔 페리뇽'],
  ['돔 페리농', '돔 페리뇽'],
  ['그래인지', '그레인지'],
  ['사시까이아', '사시카이아'],
  ['사시까이야', '사시카이아'],
  ['싸시까이아', '사시카이아'],
  ['쌔시까이아', '사시카이아'],
  ['사씨카이아', '사시카이아'],
  ['사씨까이아', '사시카이아'],
  ['띠냐넬로', '티냐넬로'],
  ['티그나넬로', '티냐넬로'],
  ['오넬라이아', '오르넬라이아'],
  ['오르넬라이야', '오르넬라이아'],
  ['오르넬라야', '오르넬라이아'],
  ['페트러스', '페트뤼스'],
  ['페트루스', '페트뤼스'],
  ['크루그', '크뤼그'],
  ['크룩', '크뤼그'],
  ['크루그 그랑 퀴베', '크뤼그'],
  ['크뤼그 그랑 퀴베', '크뤼그'],
  ['크룩 그랑 퀴베', '크뤼그'],
  ['크루그 그랑 뀌베', '크뤼그'],
  ['크뤼그 그랑 뀌베', '크뤼그'],
  ['크룩 그랑 뀌베', '크뤼그'],
  ['코슈 뒤리', '코쉬 뒤리'],
  ['코슈 듀리', '코쉬 뒤리'],
  ['코슈-뒤리', '코쉬 뒤리'],
  ['코슈-듀리', '코쉬 뒤리'],
  ['루이로드레 크리스탈', '루이 로드레 크리스탈'],
  ['베가시실리아', '베가 시실리아'],
  ['베가 시칠리아', '베가 시실리아'],
  ['우니꼬', '우니코'],
  ['도미니오 데 핑구스', '핑구스'],
  ['도미니오 드 핑구스', '핑구스'],
  ['돈멜초', '돈 멜초'],
  ['돈 멜쵸르', '돈 멜초'],
  ['돈 멜초르', '돈 멜초'],
  ['스크리밍이글', '스크리밍 이글'],
  ['할란 에스테이트', '할란 이스테이트'],
  ['그랜지', '그레인지'],
  ['펜폴즈 그랜지', '펜폴즈 그레인지'],
  ['알마 비바', '알마비바'],
  ['도멘 코슈-뒤리', '코쉬 뒤리'],
  ['도멘 코슈 뒤리', '코쉬 뒤리'],
  ['도멘 코쉬-뒤리', '코쉬 뒤리'],
  ['도멘 코쉬 뒤리', '코쉬 뒤리'],
  ['에곤 뮬러', '에곤 뮐러'],
  ['에곤뮐러', '에곤 뮐러'],
  ['에곤뮬러', '에곤 뮐러'],
  ['에곤 뮐러 샤르츠호프베르거', '에곤 뮐러'],
  ['에곤뮐러 샤르츠호프베르거', '에곤 뮐러'],
  ['에곤 뮬러 샤르츠호프베르거', '에곤 뮐러'],
  ['에곤뮬러 샤르츠호프베르거', '에곤 뮐러'],
  ['에곤 뮐러 샤르초프베르거', '에곤 뮐러'],
  ['에곤 뮬러 샤르초프베르거', '에곤 뮐러'],

  // Entity / variety abbreviations
  ['까쇼', '카베르네 소비뇽'],
  ['까소', '카베르네 소비뇽'],
  ['까베르네', '카베르네'],
  ['까베르네 소비뇽', '카베르네 소비뇽'],
  ['쇼비', '소비뇽 블랑'],
  ['피누', '피노 누아르'],
  ['리즐링', '리슬링'],
  ['샴페인', '샴페인'],
  ['보누', '보졸레 누보'],
  ['보졸레누보', '보졸레 누보'],
] as const;

const KOREAN_WINE_ALIAS_VINTAGE_GATED_CORRECTION_ENTRIES = [
  // These bare typo forms are too lossy to auto-promote under strict-entity
  // semantics, but become safe when the user supplies an explicit vintage.
  ['사시카야', '사시카이아'],
  ['사씨카이야', '사시카이아'],
] as const;

const KOREAN_WINE_ALIAS_CORRECTIONS: ReadonlyMap<string, string> = new Map(
  KOREAN_WINE_ALIAS_CORRECTION_ENTRIES,
);
const KOREAN_WINE_ALIAS_VINTAGE_GATED_CORRECTIONS: ReadonlyMap<string, string> = new Map(
  KOREAN_WINE_ALIAS_VINTAGE_GATED_CORRECTION_ENTRIES,
);

const KOREAN_WINE_ALIAS_VARIANTS = (() => {
  const variants = new Map<string, string[]>();
  for (const [variant, canonical] of KOREAN_WINE_ALIAS_CORRECTIONS) {
    const existing = variants.get(canonical) ?? [];
    if (!existing.includes(variant)) {
      existing.push(variant);
    }
    variants.set(canonical, existing);
  }
  return variants;
})();

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
  if (extractQueryVintageYear(corrected) !== null) {
    for (const [typo, canonical] of KOREAN_WINE_ALIAS_VINTAGE_GATED_CORRECTIONS) {
      if (corrected.includes(typo)) {
        corrected = corrected.replaceAll(typo, canonical);
      }
    }
  }
  return corrected;
}

export function expandKoreanWineTypoVariants(surface: string): readonly string[] {
  const normalized = surface.normalize('NFC');
  return KOREAN_WINE_ALIAS_VARIANTS.get(normalized) ?? [];
}
