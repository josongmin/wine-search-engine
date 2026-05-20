/**
 * Situational query policy: hard-block / OOD-redirect classifier.
 *
 * Phrase-level parsing for "online tasting" (rule 8 / Unicode-safe boundaries):
 *  - Requires contextual indicators ("online", "virtual", "live", "session",
 *    "실시간", "온라인", "시음회") in proximity to "tasting"/"시음" so that
 *    "tasting notes for Opus One" / "오푸스 원의 시음 노트" do not falsely
 *    fire the online-tasting branch (audit-identified false-positive).
 *
 * OOD alcohol redirect now optionally **preserves pairing intent** —
 * e.g. "beer that pairs with steak" returns a redirect that keeps `steak`
 * visible to the user instead of dropping the entire constraint.
 */

// -----------------------------------------------------------------------------
// Tasting-context phrase matchers (Unicode-safe; no `\b` on Korean — see
// CLAUDE.md rule 8).
// -----------------------------------------------------------------------------

/** Live/online/session-style modifiers that contextualize "tasting". */
const ONLINE_TASTING_CONTEXT_RE =
  /(?:online|virtual|live|session|webinar|zoom|streaming|실시간|온라인|시음회)/iu;

/** Bare "tasting" / "시음" tokens — only situational when paired with a context word. */
const TASTING_TOKEN_RE = /(?:tasting|시음)/iu;

/**
 * Phrases that mean "tasting notes" (reference material, NOT a live tasting).
 * Used as a negative guard so adversarial inputs like "tasting notes for Opus
 * One" or "시음 노트" cannot accidentally trigger the online-tasting branch
 * when the user only adds an "accessible" marker as a refinement filter.
 */
const TASTING_NOTES_NEGATIVE_RE = /(?:tasting\s*notes?|시음\s*노트)/iu;

const ACCESSIBLE_MARKER_RE =
  /(?:참가자|모두|살\s*수|accessible|available|distributed|supermarket)/iu;

export function isAccessibleOnlineTastingQuery(query: string): boolean {
  if (typeof query !== 'string' || query.trim().length === 0) return false;

  // Phrase-level guard: reject pure "tasting notes" references.
  if (TASTING_NOTES_NEGATIVE_RE.test(query) && !ONLINE_TASTING_CONTEXT_RE.test(query)) {
    return false;
  }

  // Require BOTH a tasting token AND a live/online context modifier.
  if (!TASTING_TOKEN_RE.test(query)) return false;
  if (!ONLINE_TASTING_CONTEXT_RE.test(query)) return false;

  return ACCESSIBLE_MARKER_RE.test(query);
}

// -----------------------------------------------------------------------------
// OOD alcohol classification.
// -----------------------------------------------------------------------------

const NON_WINE_ALCOHOL_QUERY_RE =
  /(?:맥주|beer|소주|soju|위스키|whisk(?:e)?y|브랜디|brandy|보드카|vodka|진(?:토닉)?|gin|럼|rum|데킬라|tequila|사케|sake|칵테일|cocktail|cocktails)/iu;
const WINE_NEGATION_RE =
  /(?:와인|wine)\s*(?:말고|빼고|아닌|제외|except|instead\s+of|not)/iu;
const WEATHER_QUERY_RE =
  /(?:날씨|weather|기온|temperature|비\s*오|rain|맑|cloudy|sunny|humid|습도)/iu;

export function isWineOutOfDomainAlcoholQuery(query: string): boolean {
  if (typeof query !== 'string' || query.trim().length === 0) return false;
  return NON_WINE_ALCOHOL_QUERY_RE.test(query)
    && (WINE_NEGATION_RE.test(query) || !/(?:와인|wine)/iu.test(query));
}

export function isUnsupportedWineExternalInfoQuery(query: string): boolean {
  if (typeof query !== 'string' || query.trim().length === 0) return false;
  return WEATHER_QUERY_RE.test(query);
}

// -----------------------------------------------------------------------------
// Pairing-intent preservation for OOD redirect.
// -----------------------------------------------------------------------------

/**
 * Pairing-intent markers (verbs/prepositions that signal "X with Y" intent).
 * Korean: "어울리", "페어링", "잘 맞" — common pairing verbs.
 * English: "pair", "pairs", "pairing", "matches".
 *
 * Korean syllables avoid `\b` (rule 8). Latin terms keep `\b` safely (ASCII).
 */
// Unicode-safe boundaries (CLAUDE.md rule 8 — `\b` is ASCII-only and silently
// fails next to Korean syllables). `(?:^|[^\p{L}\p{N}])` / `(?=$|[^\p{L}\p{N}])`
// give us a real letter/number boundary on either side.
const PAIRING_INTENT_RE =
  /(?:^|[^\p{L}\p{N}])(?:pair(?:s|ing|ed|ings)?|match(?:es|ed|ing)?)(?=$|[^\p{L}\p{N}])|어울리|페어링|잘\s*맞|와\s*어울/iu;

/**
 * Extract the *non-alcohol* dish/context that the user wants paired.
 * Heuristic-free design — we just trim the alcohol token out of the query and
 * surface the remainder verbatim so the user can confirm their intent.
 *
 * Returns `null` if no pairing intent or no usable remainder.
 */
function extractPairingContext(query: string): string | null {
  if (!PAIRING_INTENT_RE.test(query)) return null;
  // Strip alcohol tokens + pairing connectives so the dish surfaces alone.
  const cleaned = query
    .replace(NON_WINE_ALCOHOL_QUERY_RE, ' ')
    .replace(/(?:that\s+pairs?\s+with|pairs?\s+with|pairing\s+with|어울리는|와\s*어울리는|에\s*어울리는|페어링)/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (cleaned.length === 0) return null;
  return cleaned;
}

export interface OutOfDomainRedirectOptions {
  /** Original user query — enables pairing-intent preservation when present. */
  query?: string;
}

export function buildOutOfDomainWineRedirectAnswer(
  queryHasHangul: boolean,
  options?: OutOfDomainRedirectOptions,
): string {
  const base = queryHasHangul
    ? '저는 와인 중심으로만 도와드립니다. 맥주나 다른 주류 추천은 도와드리지 않고, 원하시면 취향에 맞는 와인으로 바로 추천해드릴게요.'
    : 'I specialize in wine. I cannot help with beer or other spirits, but I can recommend a wine instead.';

  const query = options?.query;
  if (typeof query !== 'string' || query.trim().length === 0) return base;

  const pairingContext = extractPairingContext(query);
  if (pairingContext == null) return base;

  return queryHasHangul
    ? `${base} (${pairingContext}에 어울리는 와인으로 찾아드릴까요?)`
    : `${base} (Would you like a wine that pairs with ${pairingContext} instead?)`;
}

export function buildUnsupportedWineExternalInfoAnswer(queryHasHangul: boolean): string {
  return queryHasHangul
    ? '저는 와인 중심으로 도와드립니다. 실시간 날씨 같은 외부 정보는 현재 확인할 수 없으니, 날씨 API나 실시간 검색으로 확인해 주세요.'
    : 'I specialize in wine. I cannot verify real-time weather here, so please check a weather API or live search.';
}
