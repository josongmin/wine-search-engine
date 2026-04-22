export function isAccessibleOnlineTastingQuery(query: string): boolean {
  return /(?:온라인\s*와인\s*시음회|온라인\s*시음회|online\s+tasting|virtual\s+tasting)/iu.test(query)
    && /(?:참가자|모두|살\s*수|accessible|available|distributed|supermarket)/iu.test(query);
}

const NON_WINE_ALCOHOL_QUERY_RE =
  /(?:맥주|beer|소주|soju|위스키|whisk(?:e)?y|브랜디|brandy|보드카|vodka|진(?:토닉)?|gin|럼|rum|데킬라|tequila|사케|sake)/iu;
const WINE_NEGATION_RE =
  /(?:와인|wine)\s*(?:말고|빼고|아닌|제외|except|instead\s+of|not)/iu;
const WEATHER_QUERY_RE =
  /(?:날씨|weather|기온|temperature|비\s*오|rain|맑|cloudy|sunny|humid|습도)/iu;

export function isWineOutOfDomainAlcoholQuery(query: string): boolean {
  return NON_WINE_ALCOHOL_QUERY_RE.test(query)
    && (WINE_NEGATION_RE.test(query) || !/(?:와인|wine)/iu.test(query));
}

export function isUnsupportedWineExternalInfoQuery(query: string): boolean {
  return WEATHER_QUERY_RE.test(query);
}

export function buildOutOfDomainWineRedirectAnswer(queryHasHangul: boolean): string {
  return queryHasHangul
    ? '저는 와인 중심으로만 도와드립니다. 맥주나 다른 주류 추천은 도와드리지 않고, 원하시면 취향에 맞는 와인으로 바로 추천해드릴게요.'
    : 'I specialize in wine. I cannot help with beer or other spirits, but I can recommend a wine instead.';
}

export function buildUnsupportedWineExternalInfoAnswer(queryHasHangul: boolean): string {
  return queryHasHangul
    ? '저는 와인 중심으로 도와드립니다. 실시간 날씨 같은 외부 정보는 현재 확인할 수 없으니, 날씨 API나 실시간 검색으로 확인해 주세요.'
    : 'I specialize in wine. I cannot verify real-time weather here, so please check a weather API or live search.';
}
