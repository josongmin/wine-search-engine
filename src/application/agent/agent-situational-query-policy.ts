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
 *
 * Determinism / NFC stability: every entry point canonicalizes its input to
 * Unicode NFC before matching. The regex literals below are composed (NFC)
 * Hangul; NFD-decomposed input (macOS filesystems, some IMEs) would otherwise
 * silently fail to match — `맥주`(NFC) ≠ `ㅁㅐㄱㅈㅜ`(NFD). Normalizing makes the
 * classifier output a pure function of the *canonical* query, independent of
 * the caller's Unicode encoding.
 */

/**
 * Canonicalize external query text to Unicode NFC so composed-Hangul regexes
 * match regardless of the caller's encoding. Non-string / empty inputs collapse
 * to `''` (callers treat empty as "no match"). Pure function — no I/O.
 */
function toCanonicalQuery(query: string): string {
  if (typeof query !== 'string') return '';
  return query.normalize('NFC');
}

// -----------------------------------------------------------------------------
// Shared boundary tokens.
//
// `\b` is ASCII-only and silently fails next to Korean syllables (CLAUDE.md
// rule 8). It is therefore used ONLY around pure-ASCII alternatives; Korean
// boundaries use the explicit `[^가-힣]` / `(?:^|…)` lookarounds instead.
// -----------------------------------------------------------------------------

/** ASCII word boundary — safe ONLY around pure-Latin alternatives. */
const ASCII_WORD_BOUNDARY = '\\b';
/** Korean letter range, used as a manual boundary where `\b` is unsafe. */
const NON_HANGUL = '[^가-힣]';

// -----------------------------------------------------------------------------
// Tasting-context phrase matchers (Unicode-safe; no `\b` on Korean — see
// CLAUDE.md rule 8).
//
// Substring-collision safety (CLAUDE.md rule 29): the Latin context modifiers
// (online/virtual/live/session/…) are pure-ASCII, so an ASCII `\b` boundary is
// safe AND necessary — without it "delivery" matched "live", "obsession" matched
// "session", "alive" matched "live". The Korean modifiers (실시간/온라인/시음회)
// are multi-syllable loanwords with no common-word collision, matched verbatim.
// -----------------------------------------------------------------------------

/** Latin live/online/session-style modifiers — ASCII word-bounded (rule 29). */
const ONLINE_TASTING_CONTEXT_LATIN = `${ASCII_WORD_BOUNDARY}(?:online|virtual|live|session|webinar|zoom|streaming)${ASCII_WORD_BOUNDARY}`;
/** Korean live/online modifiers — verbatim multi-syllable loanwords (rule 8). */
const ONLINE_TASTING_CONTEXT_KOREAN = '(?:실시간|온라인|시음회)';
/** Live/online/session-style modifiers that contextualize "tasting". */
const ONLINE_TASTING_CONTEXT_RE = new RegExp(
  `${ONLINE_TASTING_CONTEXT_LATIN}|${ONLINE_TASTING_CONTEXT_KOREAN}`,
  'iu',
);

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

export function isAccessibleOnlineTastingQuery(rawQuery: string): boolean {
  const query = toCanonicalQuery(rawQuery);
  if (query.trim().length === 0) return false;

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
//
// Substring-collision safety (CLAUDE.md rule 29 — the #1 bug class here):
//   * Latin alcohol terms are pure-ASCII → wrap in ASCII `\b` boundaries.
//     Without boundaries: "rumored"→rum, "ginger/beginning"→gin,
//     "for the sake of"→sake. With `\b` these no longer false-fire. The "sake"
//     idiom "sake of" is structurally excluded via a negative lookahead (a
//     precise lexical rule, not a heuristic guess).
//   * Korean alcohol terms must NOT match common syllables in isolation
//     (CLAUDE.md schema bar). Bare "진" matched "진한"(full-bodied)/"사진"(photo)
//     /"진짜"; bare "럼" matched "드럼"(drum)/"클럼지"(clumsy). Fix: drop the bare
//     "진" branch (require the full loanword "진토닉"), and require Korean
//     boundaries `[^가-힣]` around the high-collision "럼". Multi-syllable
//     loanwords (맥주/소주/위스키/브랜디/보드카/데킬라/사케/칵테일) carry no
//     common-word collision and are matched verbatim.
// -----------------------------------------------------------------------------

/**
 * Pure-ASCII non-wine alcohol terms. `\b`-bounded. `sake` excludes the English
 * idiom "sake of" (e.g. "for the sake of pairing") via negative lookahead so the
 * purpose-noun never reads as the rice-wine drink.
 */
const ALCOHOL_LATIN =
  `${ASCII_WORD_BOUNDARY}(?:beer|soju|whisk(?:e)?y|brandy|vodka|gin|rum|tequila|sake(?!\\s+of${ASCII_WORD_BOUNDARY})|cocktails?)${ASCII_WORD_BOUNDARY}`;
/** Multi-syllable Korean alcohol loanwords with no common-word collision. */
const ALCOHOL_KOREAN_UNAMBIGUOUS = '(?:맥주|소주|위스키|브랜디|보드카|데킬라|사케|칵테일|진토닉)';
/** High-collision Korean "럼"(rum) — require Korean boundaries (드럼/클럼지 guard). */
const ALCOHOL_KOREAN_RUM = `(?:^|${NON_HANGUL})럼(?:주)?(?=$|${NON_HANGUL})`;

const NON_WINE_ALCOHOL_QUERY_RE = new RegExp(
  `${ALCOHOL_LATIN}|${ALCOHOL_KOREAN_UNAMBIGUOUS}|${ALCOHOL_KOREAN_RUM}`,
  'iu',
);

/**
 * Global token-stripping variant for pairing-context extraction. Unlike the
 * detection regex it (a) is `g`-flagged so EVERY alcohol mention is removed and
 * (b) matches "럼"/"럼주" without consuming the surrounding boundary character
 * (the detection regex's boundary group would otherwise eat an adjacent dish
 * character). Keep token lists in sync with the detection constants above.
 */
const ALCOHOL_STRIP_RE = new RegExp(
  `${ASCII_WORD_BOUNDARY}(?:beer|soju|whisk(?:e)?y|brandy|vodka|gin|rum|tequila|sake|cocktails?)${ASCII_WORD_BOUNDARY}`
  + `|맥주|소주|위스키|브랜디|보드카|데킬라|사케|칵테일|진토닉|럼주|럼`,
  'giu',
);

const WINE_NEGATION_RE =
  /(?:와인|wine)\s*(?:말고|빼고|아닌|제외|except|instead\s+of|not)/iu;
const WINE_TOKEN_RE = /(?:와인|wine)/iu;

/**
 * Weather / external-info terms. Latin terms `\b`-bounded (rule 29 —
 * "training"/"terrain"→rain). Korean "비 오"(rain) and "맑"(clear) require Korean
 * boundaries so "준비 오래"(takes long to prepare) and prefixed forms don't fire.
 */
const WEATHER_LATIN = `${ASCII_WORD_BOUNDARY}(?:weather|temperature|rain|cloudy|sunny|humid)${ASCII_WORD_BOUNDARY}`;
const WEATHER_KOREAN_WORDS = '날씨|기온|습도';
const WEATHER_KOREAN_RAIN = `(?:^|${NON_HANGUL})비\\s*[오와온]`;
const WEATHER_KOREAN_CLEAR = `(?:^|${NON_HANGUL})맑(?=음|은|게|아|을|다|$|${NON_HANGUL})`;
const WEATHER_QUERY_RE = new RegExp(
  `${WEATHER_LATIN}|${WEATHER_KOREAN_WORDS}|${WEATHER_KOREAN_RAIN}|${WEATHER_KOREAN_CLEAR}`,
  'iu',
);

export function isWineOutOfDomainAlcoholQuery(rawQuery: string): boolean {
  const query = toCanonicalQuery(rawQuery);
  if (query.trim().length === 0) return false;
  return NON_WINE_ALCOHOL_QUERY_RE.test(query)
    && (WINE_NEGATION_RE.test(query) || !WINE_TOKEN_RE.test(query));
}

export function isUnsupportedWineExternalInfoQuery(rawQuery: string): boolean {
  const query = toCanonicalQuery(rawQuery);
  if (query.trim().length === 0) return false;
  return WEATHER_QUERY_RE.test(query);
}

// -----------------------------------------------------------------------------
// Pairing-intent preservation for OOD redirect.
// -----------------------------------------------------------------------------

/**
 * Upper bound on the surfaced pairing residue (characters). A redirect hint is a
 * short dish phrase ("steak", "삼겹살"); anything longer is almost certainly a
 * run-on query and is truncated so the response stays bounded regardless of
 * input length. 80 chars comfortably holds multi-word dishes in either script.
 */
const MAX_PAIRING_CONTEXT_LEN = 80;

/**
 * Pairing-intent markers (verbs/prepositions that signal "X with Y" intent).
 * Korean: "어울리", "페어링", "잘 맞" — common pairing verbs.
 * English: "pair", "pairs", "pairing", "matches".
 *
 * Unicode-safe boundaries (CLAUDE.md rule 8 — `\b` is ASCII-only and silently
 * fails next to Korean syllables). `(?:^|[^\p{L}\p{N}])` / `(?=$|[^\p{L}\p{N}])`
 * give us a real letter/number boundary on either side.
 */
const PAIRING_INTENT_RE =
  /(?:^|[^\p{L}\p{N}])(?:pair(?:s|ing|ed|ings)?|match(?:es|ed|ing)?)(?=$|[^\p{L}\p{N}])|어울리|페어링|잘\s*맞|와\s*어울/iu;

/**
 * Extract the *non-alcohol* dish/context that the user wants paired.
 * Heuristic-free design — we just trim the alcohol token out of the query and
 * surface the remainder verbatim so the user can confirm their intent.
 *
 * Returns `null` if no pairing intent or no usable remainder.
 *
 * Output is length-bounded (`MAX_PAIRING_CONTEXT_LEN`) so an adversarially long
 * query cannot blow up the redirect string — the surfaced residue is a short
 * confirmation hint, never the entire payload.
 */
function extractPairingContext(query: string): string | null {
  if (!PAIRING_INTENT_RE.test(query)) return null;
  // Strip alcohol tokens + pairing connectives so the dish surfaces alone.
  const cleaned = query
    .replace(ALCOHOL_STRIP_RE, ' ')
    .replace(/(?:that\s+pairs?\s+with|pairs?\s+with|pairing\s+with|어울리는|와\s*어울리는|에\s*어울리는|페어링)/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > MAX_PAIRING_CONTEXT_LEN
    ? cleaned.slice(0, MAX_PAIRING_CONTEXT_LEN).trim()
    : cleaned;
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

  const query = toCanonicalQuery(options?.query ?? '');
  if (query.trim().length === 0) return base;

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
