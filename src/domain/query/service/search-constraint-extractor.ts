/**
 * Pure, zero-cost (no LLM) extraction of structured search constraints from
 * natural-language query strings.
 *
 * Produces a {@link SearchConstraints} object that can be used to:
 *  1. Inject YQL NOT-filters into the Vespa query (exclusions).
 *  2. Inject numeric range filters (price, vintage).
 *
 * Constraint extraction happens before any LLM call — the result is
 * deterministic and testable in isolation.
 *
 * @module search-constraint-extractor
 */

import {
  KRW_PER_CHEON_WON,
  KRW_PER_EOK_WON,
  KRW_PER_MAN_WON,
  KRW_PER_USD_APPROXIMATE,
  KRW_PER_EUR_APPROXIMATE,
  KRW_PER_GBP_APPROXIMATE,
} from '../../shared/constants.js';
import { WINE_TYPE_ALL_TOKENS, WINE_TYPE_RULES } from '../model/wine-type-patterns.js';
import {
  extractKoreanVintageAfter,
  extractKoreanVintageBefore,
  extractVintageRange,
} from '../../shared/utils/vintage.js';
import { normalizeKoreanNegation } from './korean-negation-normalizer.js';

// ---------------------------------------------------------------------------
// KRW ↔ USD conversion
// ---------------------------------------------------------------------------

/**
 * Approximate KRW → USD conversion rate used for price-range filters.
 *
 * Vespa stores prices as USD (field: `price_usd`). Korean-market queries
 * express prices in KRW (원/만원). A fixed rate is used here so the extractor
 * stays purely lexical (no network calls). The rate is intentionally a round
 * number — it influences soft filtering only; the ranking pipeline does its
 * own calibration.
 *
 * Single source: {@link KRW_PER_USD_APPROXIMATE} in domain shared constants.
 */
export const KRW_PER_USD = KRW_PER_USD_APPROXIMATE;

/** "만원대" (price-range suffix) band fractions: ±10% of the midpoint KRW value.
 *  "5만원대" = "around 50K KRW" → range [45K, 55K]. The ±10% band balances
 *  user intent ("in the ballpark") vs. precision — wider bands (±20%) returned
 *  too many off-target results in A/B testing; narrower (±5%) excluded wines
 *  priced at rounding boundaries (e.g. 47,000 for a "5만원대" query). */
const KRW_PRICE_BAND_LOWER_FRACTION = 0.9;
const KRW_PRICE_BAND_UPPER_FRACTION = 1.1;

/**
 * Converts Korean Won to US Dollars, rounding to two decimal places.
 *
 * @param krw - Price in Korean Won.
 * @returns Price in USD.
 */
export function krwToUsd(krw: number): number {
  return Math.round((krw / KRW_PER_USD) * 100) / 100;
}

// ---------------------------------------------------------------------------
// SearchConstraints interface
// ---------------------------------------------------------------------------

/**
 * Structured constraints extracted from a natural-language query using
 * purely lexical (pattern-match) rules — no LLM cost.
 *
 * All fields are optional; an absent field means "no constraint on that
 * attribute." All string arrays are lower-case-normalized for comparison.
 *
 * These constraints complement the existing {@link ConstraintBundle} system:
 * the bundle handles positive matching ("I want X"); SearchConstraints handles
 * exclusion ("I don't want X") and precise numeric ranges (KRW price).
 */
export interface SearchConstraints {
  /**
   * Grape variety names to exclude (normalized to canonical English names).
   * Maps to `!(grape_primary contains "X") AND !(grapes contains "X")` in YQL.
   */
  readonly excludeGrapes?: readonly string[];

  /**
   * Country names to exclude (canonical English, e.g. "France", "Italy").
   * Maps to `!(country contains "X")` in YQL.
   */
  readonly excludeCountries?: readonly string[];

  /**
   * Region names to exclude (free-form; maps to `!(region contains "X")`).
   */
  readonly excludeRegions?: readonly string[];

  /**
   * Style descriptors to exclude (e.g. "oaked", "sweet").
   * Maps to `!(style contains "X")` in YQL.
   */
  readonly excludeStyles?: readonly string[];

  /**
   * Wine types to exclude (canonical English values: 'red', 'white', 'sparkling', etc.).
   * Maps to `!(wine_type contains "X")` in YQL.
   *
   * Separated from excludeStyles because (a) the Vespa field is `wine_type`, not `style`,
   * and (b) Vespa stores canonical English values — Korean surface tokens like "화이트"
   * would never match the `wine_type` field if routed through excludeStyles.
   */
  readonly excludeWineTypes?: readonly string[];

  /**
   * Maximum price in KRW. Converted to USD before injecting into Vespa.
   * Maps to `price_usd <= (maxPriceKrw / KRW_PER_USD)`.
   */
  readonly maxPriceKrw?: number;

  /**
   * Minimum price in KRW. Converted to USD before injecting into Vespa.
   * Maps to `price_usd >= (minPriceKrw / KRW_PER_USD)`.
   */
  readonly minPriceKrw?: number;

  /**
   * Minimum vintage year (inclusive).
   * Maps to `vintage_year >= vintageMin`.
   */
  readonly vintageMin?: number;

  /**
   * Maximum vintage year (inclusive).
   * Maps to `vintage_year <= vintageMax`.
   */
  readonly vintageMax?: number;
}

// ---------------------------------------------------------------------------
// Grape name normalization
// ---------------------------------------------------------------------------

/**
 * Maps Korean grape name fragments (and common English abbreviations) to
 * their canonical English grape variety names for Vespa filtering.
 *
 * The key is a regex source string (used with the unicode-safe negation
 * boundary pattern); the value is the canonical English name stored in
 * the Vespa `grape_primary` / `grapes` fields.
 */
const KOREAN_GRAPE_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/카베르네\s*소비뇽|카베르네|cab(?:ernet)?\s*sauv(?:ignon)?/iu, 'Cabernet Sauvignon'],
  [/카베르네\s*프랑|cab(?:ernet)?\s*franc/iu, 'Cabernet Franc'],
  [/메를로|merlot/iu, 'Merlot'],
  [/피노\s*누아르?|피노누아|pinot\s*noir/iu, 'Pinot Noir'],
  [/피노\s*그리(?:지오)?|pinot\s*gri(?:gio|s)/iu, 'Pinot Grigio'],
  [/피노\s*블랑|pinot\s*blanc/iu, 'Pinot Blanc'],
  [/소비뇽\s*블랑|쇼비뇽|sauvignon\s*blanc/iu, 'Sauvignon Blanc'],
  [/샤르도네|chardonnay/iu, 'Chardonnay'],
  [/시라(?:즈)?|shiraz|syrah/iu, 'Syrah'],
  [/리슬링|riesling/iu, 'Riesling'],
  [/그르나슈|grenache|garnacha/iu, 'Grenache'],
  [/산지오베제|sangiovese/iu, 'Sangiovese'],
  [/템프라니요|tempranillo/iu, 'Tempranillo'],
  [/네비올로|nebbiolo/iu, 'Nebbiolo'],
  [/말벡|malbec/iu, 'Malbec'],
  [/무스카|muscat|moscato/iu, 'Muscat'],
  [/게뷔르츠트라미너|gewürztraminer|gewurztraminer/iu, 'Gewürztraminer'],
  [/비오니에|viognier/iu, 'Viognier'],
  [/진판델|zinfandel/iu, 'Zinfandel'],
  [/피노타지|pinotage/iu, 'Pinotage'],
];

/**
 * Normalizes a raw grape name token to its canonical English form.
 * Returns `undefined` if no known alias matches.
 */
function normalizeGrapeName(raw: string): string | undefined {
  for (const [pattern, canonical] of KOREAN_GRAPE_ALIASES) {
    if (pattern.test(raw)) return canonical;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Country name normalization
// ---------------------------------------------------------------------------

/**
 * Maps Korean (and abbreviated English) country names to canonical English
 * country names used in the Vespa `country` field.
 */
const KOREAN_COUNTRY_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/프랑스|france|french/iu, 'France'],
  [/이탈리아|italy|italian/iu, 'Italy'],
  [/스페인|spain|spanish/iu, 'Spain'],
  [/호주|australia|australian/iu, 'Australia'],
  [/칠레|chile|chilean/iu, 'Chile'],
  // Lookbehind required for bare '미': without it, '아미' or '카미' would match via '미'
  // at the end of the syllable sequence, incorrectly classifying producer/winery
  // names containing '미' as 'United States'. (Rule 8: non-ASCII boundary guard)
  [/미국|(?<![\p{L}\p{N}])미(?![\p{L}\p{N}])|usa|united\s+states|american/iu, 'United States'],
  [/아르헨티나|argentina|argentinian/iu, 'Argentina'],
  [/독일|germany|german/iu, 'Germany'],
  [/포르투갈|portugal|portuguese/iu, 'Portugal'],
  [/뉴질랜드|new\s+zealand/iu, 'New Zealand'],
  [/남아공|south\s+africa|south\s+african/iu, 'South Africa'],
  [/오스트리아|austria|austrian/iu, 'Austria'],
];

/**
 * Normalizes a raw country name token to its canonical English form.
 * Returns `undefined` if no known alias matches.
 */
function normalizeCountryName(raw: string): string | undefined {
  for (const [pattern, canonical] of KOREAN_COUNTRY_ALIASES) {
    if (pattern.test(raw)) return canonical;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Negation patterns
// ---------------------------------------------------------------------------

/**
 * Korean and English negation word patterns that precede or follow an
 * attribute value to signal exclusion.
 *
 * Pattern contract:
 * - Named capture group `subject` captures the attribute value (grape/country/style name).
 * - All patterns use the `/u` flag for proper Unicode boundary handling.
 * - `\b` is intentionally avoided — use `[^\p{L}\p{N}]` boundaries instead.
 *
 * Korean patterns:
 *   "X 빼고"  — "excluding X"
 *   "X 제외"  — "excluding X"
 *   "X 말고"  — "except X" / "other than X"
 *   "X 없이"  — "without X"
 *   "X 빼"    — colloquial shortening of 빼고
 *
 * English patterns:
 *   "not X"      — standard negation
 *   "without X"  — absence
 *   "exclude X"  — explicit exclusion
 *   "no X"       — shorthand
 *   "except X"   — exception
 */
const NEGATION_SUBJECT_BEFORE: RegExp =
  /(?:^|[^\p{L}\p{N}])(?:not|without|exclude|no|except)\s+(?<subject>[^\s,;]+(?:\s+[^\s,;]+)?)/giu;

const NEGATION_SUBJECT_AFTER: RegExp =
  /(?:^|[^\p{L}\p{N}])(?<subject>[^\s,;]+(?:\s+[^\s,;]+)?)\s+(?:빼고|빼주세요|빼줘|제외|말고|없이|빼(?=[^\p{L}\p{N}]|$))/giu;

/**
 * Korean adverbial negation preceding the subject: "안 X"
 *
 * Korean pattern:
 *   "안 X"  — "not X" (short-form negation adverb placed BEFORE the predicate/subject)
 *
 * Examples:
 *   "오크 안 쓴 샤도네이" → subject = "쓴" (negated: oaky/oak-used)
 *   "탄닌 안 센 와인"     → subject = "센" (negated: strong tannin)
 *
 * Note: captures up to 2 words after "안" as the negated subject. The leading "안"
 * must be preceded by a non-word boundary or start-of-string to avoid matching
 * Korean words ending in "안" (e.g. "불안" = anxiety).
 */
const NEGATION_KOREAN_ADVERB_BEFORE: RegExp =
  /(?:^|[^\p{L}\p{N}])안\s+(?<subject>[^\s,;]+(?:\s+[^\s,;]+)?)/giu;

// ---------------------------------------------------------------------------
// Price extraction
// ---------------------------------------------------------------------------

/**
 * Extracts KRW price constraints from the query string.
 *
 * Pattern priority table (evaluated top-to-bottom, first match wins):
 *
 * Priority | Name           | Example            | Result
 * ---------|----------------|--------------------|-----------------------------
 *    1     | range          | "3~5만원"           | min=30000, max=50000
 *    2     | combined_unit  | "5만5천원"          | max=55000
 *    3     | band           | "5만원대"           | min≈45000, max≈55000 (±10%)
 *    4     | man_under      | "5만원 이하"        | max=50000
 *    5     | man_over       | "5만원 이상"        | min=50000
 *    6     | cheon_under    | "5천원 이하"        | max=5000
 *    7     | won_under      | "50000원 이하"      | max=50000
 *
 * Ordering rationale:
 *  - range BEFORE combined_unit: "3만5천원~5만원" must be a range, not combined.
 *  - combined_unit BEFORE band/man_under: "5만5천원" must not match as "5만" band.
 *  - band BEFORE man_under: "5만원대" must not match the "5만원" under-prefix.
 *
 * To add a new pattern: insert at the correct priority level with a comment
 * explaining WHY it must come before/after its neighbors.
 */
/**
 * Convert Korean number words to digit form. Handles Sino-Korean numerals up to
 * 만(10,000) units, which covers all realistic wine price expressions.
 *
 * Examples:
 *   "오만원" → "5만원"
 *   "십오만원" → "15만원"
 *   "이십만원" → "20만원"
 *   "백만원" → "100만원"
 *   "오만 정도" → "5만 정도"
 *
 * Supports compound forms: "오만 오천원" → "5만 5천원" (handled by space-separated parsing).
 *
 * Algorithm: scan for digit-word sequences immediately followed by 만/천 and replace
 * with the parsed integer. Conservative — only replaces when followed by a unit suffix
 * to avoid corrupting unrelated Korean text (e.g., "오늘" should NOT become "5늘").
 */
function koreanNumberWordToDigit(s: string): string {
  // Sino-Korean digit map (일/이/삼/사/오/육/칠/팔/구) + ten/hundred multipliers
  const DIGIT: Record<string, number> = {
    '일': 1, '이': 2, '삼': 3, '사': 4, '오': 5,
    '육': 6, '칠': 7, '팔': 8, '구': 9,
  };
  // Match any sequence of Sino-Korean digit/십/백 chars followed by a 만|천 unit.
  // The character class must be inclusive — we parse the sequence in a dedicated
  // tokenizer below, NOT via regex ordering. Using `+` (not a rigid `[d]?[십]?...` chain)
  // correctly handles arbitrary orderings like "삼백오십만" (3*100 + 5*10 = 350).
  //
  // Word boundary: after the unit syllable we MUST see end-of-string, whitespace, punctuation,
  // OR a legitimate price continuation (원, 대). We MUST NOT rewrite when followed by arbitrary
  // Korean syllables like 한/하/해 ("오만한" = "arrogant" is NOT "5만한"). The lookahead below
  // whitelists only the valid continuations. \b is ASCII-only and cannot be used here.
  // Units supported: 천(1,000), 만(10,000), 억(100,000,000). 억 is included because
  // grand-cru wines in Korea retail above 1억원 ("일억원 이상 와인"). Without 억 support
  // the downstream man_under/man_over regex never fires for all-Korean billion-won queries.
  return s.replace(
    /([일이삼사오육칠팔구십백]+)\s*(억|만|천)(?=원|대|$|[^가-힣])/gu,
    (match, group: string, unit: string) => {
      // Parse left-to-right with positional multipliers: 백 = 100, 십 = 10.
      // A digit before 백/십 multiplies it; a bare 백/십 is treated as 1*100 / 1*10.
      // A digit after the last 십/백 (or with no 십/백) is added as units.
      let total = 0;
      let pending = 0; // current digit waiting for a multiplier or to become units
      for (const ch of group) {
        if (ch === '백') {
          total += (pending === 0 ? 1 : pending) * 100;
          pending = 0;
        } else if (ch === '십') {
          total += (pending === 0 ? 1 : pending) * 10;
          pending = 0;
        } else {
          const d = DIGIT[ch];
          if (d !== undefined) pending = d;
        }
      }
      total += pending; // trailing units
      return total > 0 ? `${total}${unit}` : match;
    },
  );
}

/**
 * Converts a foreign-currency amount to KRW using a fixed approximate rate.
 *
 * Supported currency symbols:
 *   ₩ / W  — KRW (no conversion needed, returns as-is)
 *   $      — USD → KRW via KRW_PER_USD_APPROXIMATE
 *   €      — EUR → KRW via KRW_PER_EUR_APPROXIMATE
 *   £      — GBP → KRW via KRW_PER_GBP_APPROXIMATE
 *
 * Returns null if the symbol is unrecognised or the amount is not finite.
 * CLAUDE.md Rule 21: never uses toLocaleString(); amounts are converted with
 * integer arithmetic so locale-specific formatting cannot corrupt output.
 */
function foreignCurrencyToKrw(symbol: string, amount: number): number | null {
  if (!Number.isFinite(amount)) return null;
  const sym = symbol.trim();
  if (sym === '₩' || sym.toLowerCase() === 'w') return Math.round(amount);
  if (sym === '$') return Math.round(amount * KRW_PER_USD_APPROXIMATE);
  if (sym === '€') return Math.round(amount * KRW_PER_EUR_APPROXIMATE);
  if (sym === '£') return Math.round(amount * KRW_PER_GBP_APPROXIMATE);
  return null;
}

/**
 * Extracts price constraints from queries that contain foreign-currency symbols
 * (RCA5-07: mixed-currency price parsing).
 *
 * Supported patterns (evaluated before KRW-native patterns):
 *   "₩70000 이하"       → maxPriceKrw=70000
 *   "$100 이하"          → maxPriceKrw=100*1350
 *   "€50~€80"            → min/max range in EUR→KRW
 *   "$50 이상"           → minPriceKrw=50*1350
 *   "70,000원" / "₩70,000" — commas are thousands-separators, stripped upstream
 *
 * Returns {} when no foreign-currency pattern is found (caller falls through to
 * KRW-native patterns).
 *
 * Rule 21: No toLocaleString(). All numeric ops use integer math.
 */
function extractForeignCurrencyPrice(
  q: string,
): Pick<SearchConstraints, 'minPriceKrw' | 'maxPriceKrw'> {
  // Strip thousands-separator commas before matching
  const qn = q.replace(/,/g, '');

  // Priority A — foreign-currency range: "$50~$80" or "€30-€50" or "$50~80"
  // Symbol before both bounds, or only before the first (second bound uses same currency).
  const fxRangeMatch =
    /([$€£₩])(\d+(?:\.\d+)?)\s*[~\-–]\s*(?:[$€£₩])?(\d+(?:\.\d+)?)/u.exec(qn);
  if (
    fxRangeMatch !== null &&
    fxRangeMatch[1] !== undefined &&
    fxRangeMatch[2] !== undefined &&
    fxRangeMatch[3] !== undefined
  ) {
    const sym = fxRangeMatch[1];
    const loRaw = parseFloat(fxRangeMatch[2]);
    const hiRaw = parseFloat(fxRangeMatch[3]);
    if (!Number.isFinite(loRaw) || !Number.isFinite(hiRaw)) return {};
    const lo = foreignCurrencyToKrw(sym, loRaw);
    const hi = foreignCurrencyToKrw(sym, hiRaw);
    if (lo !== null && hi !== null) {
      const [safeMin, safeMax] = lo <= hi ? [lo, hi] : [hi, lo];
      return { minPriceKrw: safeMin, maxPriceKrw: safeMax };
    }
  }

  // Priority B1 — prefix upper bound with symbol: "under $100", "below €30".
  const fxUnderPrefixSymbolMatch =
    /(?:under|below|up\s+to|less\s+than|no\s+more\s+than)\s*([$€£₩])(\d+(?:\.\d+)?)(?=$|[^\p{L}\p{N}])/iu.exec(qn);
  if (
    fxUnderPrefixSymbolMatch !== null &&
    fxUnderPrefixSymbolMatch[1] !== undefined &&
    fxUnderPrefixSymbolMatch[2] !== undefined
  ) {
    const underAmt = parseFloat(fxUnderPrefixSymbolMatch[2]);
    if (!Number.isFinite(underAmt)) return {};
    const krw = foreignCurrencyToKrw(fxUnderPrefixSymbolMatch[1], underAmt);
    if (krw !== null) return { maxPriceKrw: krw };
  }

  // Priority B2 — explicit USD words: "under 100 dollars", "100 USD or less".
  const usdWordUnderPrefixMatch =
    /(?:under|below|up\s+to|less\s+than|no\s+more\s+than)\s+(\d+(?:\.\d+)?)\s*(?:usd|u\.s\.\s*dollars?|us\s*dollars?|dollars?)(?=$|[^\p{L}\p{N}])/iu.exec(qn);
  if (usdWordUnderPrefixMatch?.[1] !== undefined) {
    const underAmt = parseFloat(usdWordUnderPrefixMatch[1]);
    if (!Number.isFinite(underAmt)) return {};
    return { maxPriceKrw: Math.round(underAmt * KRW_PER_USD_APPROXIMATE) };
  }

  const usdWordUnderSuffixMatch =
    /(\d+(?:\.\d+)?)\s*(?:usd|u\.s\.\s*dollars?|us\s*dollars?|dollars?)\s*(?:or\s+less|and\s+under|or\s+under|under|below|max(?:imum)?)/iu.exec(qn);
  if (usdWordUnderSuffixMatch?.[1] !== undefined) {
    const underAmt = parseFloat(usdWordUnderSuffixMatch[1]);
    if (!Number.isFinite(underAmt)) return {};
    return { maxPriceKrw: Math.round(underAmt * KRW_PER_USD_APPROXIMATE) };
  }

  // Priority B — foreign-currency upper bound: "$100 이하/이내/미만" or "$100 under/below"
  const fxUnderMatch =
    /([$€£₩])(\d+(?:\.\d+)?)\s*(?:이하|이내|미만|under|below|or less)/iu.exec(qn);
  if (
    fxUnderMatch !== null &&
    fxUnderMatch[1] !== undefined &&
    fxUnderMatch[2] !== undefined
  ) {
    const underAmt = parseFloat(fxUnderMatch[2]);
    if (!Number.isFinite(underAmt)) return {};
    const krw = foreignCurrencyToKrw(fxUnderMatch[1], underAmt);
    if (krw !== null) return { maxPriceKrw: krw };
  }

  // Priority C — foreign-currency lower bound: "$50 이상/이상" or "$50 above/over"
  const fxOverMatch =
    /([$€£₩])(\d+(?:\.\d+)?)\s*(?:이상|초과|above|over|or more)/iu.exec(qn);
  if (
    fxOverMatch !== null &&
    fxOverMatch[1] !== undefined &&
    fxOverMatch[2] !== undefined
  ) {
    const overAmt = parseFloat(fxOverMatch[2]);
    if (!Number.isFinite(overAmt)) return {};
    const krw = foreignCurrencyToKrw(fxOverMatch[1], overAmt);
    if (krw !== null) return { minPriceKrw: krw };
  }

  // Priority D — bare foreign-currency amount with no direction keyword:
  // treat as "approximately" = upper bound only (matches user intent for "€50 와인").
  const fxBareMatch = /([$€£])(\d+(?:\.\d+)?)/u.exec(qn);
  if (
    fxBareMatch !== null &&
    fxBareMatch[1] !== undefined &&
    fxBareMatch[2] !== undefined
  ) {
    const bareAmt = parseFloat(fxBareMatch[2]);
    if (!Number.isFinite(bareAmt)) return {};
    const krw = foreignCurrencyToKrw(fxBareMatch[1], bareAmt);
    if (krw !== null) return { maxPriceKrw: krw };
  }

  return {};
}

/**
 * Korean retail-channel price caps (KRW).
 *
 * Derived from Korean retail market data (2025):
 *   편의점 (convenience store): GS25/CU/7-Eleven wine lines top out at 12-15K KRW
 *   마트/대형마트 (hypermarket): E-Mart/Homeplus everyday shelf; premium floor ~30K KRW
 *   백화점 (department store): Lotte/Shinsegae mid-range floor ~100K KRW (prestige is uncapped)
 *
 * Only upper bounds are recorded because "편의점 와인" implies affordability, not a floor.
 * These are maxPriceKrw constraints (soft upper bound), not hard Vespa YQL filters.
 */
/** Max KRW for convenience-store (편의점) wine tier. Source: GS25/CU/7-Eleven 2025 wine price survey. */
const RETAIL_CHANNEL_MAX_KRW_CONVENIENCE = 15_000;
/** Max KRW for hypermarket (마트/슈퍼) wine tier. Source: E-Mart/Homeplus everyday shelf 2025. */
const RETAIL_CHANNEL_MAX_KRW_MART = 30_000;
/** Max KRW for department store (백화점) wine tier. Source: Lotte/Shinsegae mid-range floor 2025. */
const RETAIL_CHANNEL_MAX_KRW_DEPARTMENT = 100_000;

const RETAIL_CHANNEL_MAX_KRW: ReadonlyArray<readonly [RegExp, number]> = [
  // 편의점: GS25, CU, 7-Eleven, 이마트24 — wine prices 5K-15K KRW
  [/편의점(?:\s*(?:와인|수준|에서|용))?/u, RETAIL_CHANNEL_MAX_KRW_CONVENIENCE],
  // 마트/대형마트/슈퍼: E-Mart, Homeplus, Lotte Mart everyday shelf
  // Boundary: 마트 must be followed by space, end, or Korean postposition (조사: 에/에서/의/용/와인/수준)
  // but NOT by an arbitrary Hangul letter — prevents "마트료시카" false positive.
  [/(?:대형\s*)?마트(?:\s*(?:와인|수준|용)|(?:에서?|의)(?:\s|$)|\s|$)|슈퍼(?:마켓)?(?:\s*(?:와인|수준))?/u, RETAIL_CHANNEL_MAX_KRW_MART],
  // 백화점: Lotte, Shinsegae, Hyundai mid-range floor
  [/백화점(?:\s*(?:와인|수준|용))?/u, RETAIL_CHANNEL_MAX_KRW_DEPARTMENT],
];

/**
 * Extracts a price cap from Korean retail channel keywords BEFORE numeric parsing.
 * Returns {} if no channel keyword is found so numeric price extraction continues normally.
 * When a numeric price constraint is ALSO present in the query, numeric wins (caller merges
 * with later extractors; the numeric patterns are more specific).
 */
function extractRetailChannelPrice(q: string): Pick<SearchConstraints, 'maxPriceKrw'> {
  for (const [pattern, maxKrw] of RETAIL_CHANNEL_MAX_KRW) {
    if (pattern.test(q)) {
      return { maxPriceKrw: maxKrw };
    }
  }
  return {};
}

function extractKrwPrice(q: string): Pick<SearchConstraints, 'minPriceKrw' | 'maxPriceKrw'> {
  // Normalize: strip ALL commas — in Korean price context commas are always thousands
  // separators ("50,000원") and never decimal separators. Global removal is safe and
  // avoids the false-strip risk of a digit-count-specific regex ("1,23원" → "123원").
  // Then convert Korean number words (오만원 → 5만원) so the digit-based regexes downstream
  // catch them via the standard "X만원" / "X만원 이하" patterns.
  const qn = koreanNumberWordToDigit(q.replace(/,/g, ''));

  // Priority 1 — range: "3~5만원" or "3-5만원"
  // MUST be before combined_unit: "3만5천원~5만원" is a range, not a single price.
  const rangeMatch = /(\d+(?:\.\d+)?)[~\-–](\d+(?:\.\d+)?)\s*만원/u.exec(qn);
  if (rangeMatch !== null && rangeMatch[1] !== undefined && rangeMatch[2] !== undefined) {
    const lo = parseFloat(rangeMatch[1]);
    const hi = parseFloat(rangeMatch[2]);
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      // Swap reversed ranges ("10~3만원") to avoid impossible min>max filter.
      const [safeMin, safeMax] = lo <= hi ? [lo, hi] : [hi, lo];
      return {
        minPriceKrw: Math.round(safeMin * KRW_PER_MAN_WON),
        maxPriceKrw: Math.round(safeMax * KRW_PER_MAN_WON),
      };
    }
  }

  // Priority 2 — combined_unit: "X만Y천원" (e.g. "5만5천원" = 55,000 KRW)
  // MUST be before band/man_under: "5만5천원" must not match the "5만" prefix patterns.
  const combinedMatch = /(\d+(?:\.\d+)?)\s*만\s*(\d+(?:\.\d+)?)\s*천원(?:\s*(?:이하|이내|미만))?/u.exec(qn);
  if (combinedMatch !== null && combinedMatch[1] !== undefined && combinedMatch[2] !== undefined) {
    const man = parseFloat(combinedMatch[1]);
    const cheon = parseFloat(combinedMatch[2]);
    if (Number.isFinite(man) && Number.isFinite(cheon)) {
      const combined = man * KRW_PER_MAN_WON + cheon * KRW_PER_CHEON_WON;
      if (Number.isFinite(combined)) return { maxPriceKrw: Math.round(combined) };
    }
  }

  // Priority 3 — band: "X만원대" → ±10% band around midpoint
  // MUST be before man_under: "5만원대" contains "5만원" which would match man_under.
  const bandMatch = /(\d+(?:\.\d+)?)\s*만원대/u.exec(qn);
  if (bandMatch !== null && bandMatch[1] !== undefined) {
    const mid = parseFloat(bandMatch[1]) * KRW_PER_MAN_WON;
    if (Number.isFinite(mid)) {
      return {
        minPriceKrw: Math.round(mid * KRW_PRICE_BAND_LOWER_FRACTION),
        maxPriceKrw: Math.round(mid * KRW_PRICE_BAND_UPPER_FRACTION),
      };
    }
  }

  // Priority 3b — eok_under/over: "X억원 이하/이상". 1억 = 100M KRW.
  // MUST be before man_under so "1억원" is not truncated as "1" + "억원".
  const eokUnderMatch = /(\d+(?:\.\d+)?)\s*억원?\s*(?:이하|이내|미만)/u.exec(qn);
  if (eokUnderMatch !== null && eokUnderMatch[1] !== undefined) {
    const v = parseFloat(eokUnderMatch[1]);
    if (Number.isFinite(v)) return { maxPriceKrw: Math.round(v * KRW_PER_EOK_WON) };
  }
  const eokOverMatch = /(\d+(?:\.\d+)?)\s*억원?\s*이상/u.exec(qn);
  if (eokOverMatch !== null && eokOverMatch[1] !== undefined) {
    const v = parseFloat(eokOverMatch[1]);
    if (Number.isFinite(v)) return { minPriceKrw: Math.round(v * KRW_PER_EOK_WON) };
  }

  // Priority 4 — man_under: "X만원 이하/이내/미만/정도/쯤/약/언저리/근처/정도/내외"
  // 정도/쯤/약/언저리/근처/내외 are "approximate around" markers — treated as soft upper bound
  // (the band logic at priority 3 handles the explicit "대" form with ±10%).
  // "언저리" (around, in the vicinity of) is commonly used in Korean price queries
  // e.g. "10만원 언저리로" = "around 100,000 KRW".
  const underMatch = /(\d+(?:\.\d+)?)\s*만원\s*(?:이하|이내|미만|정도|쯤|약|언저리|근처|내외)/u.exec(qn);
  if (underMatch !== null && underMatch[1] !== undefined) {
    const v = parseFloat(underMatch[1]);
    if (Number.isFinite(v)) return { maxPriceKrw: Math.round(v * KRW_PER_MAN_WON) };
  }

  // Priority 5 — man_over: "X만원 이상"
  const overMatch = /(\d+(?:\.\d+)?)\s*만원\s*이상/u.exec(qn);
  if (overMatch !== null && overMatch[1] !== undefined) {
    const v = parseFloat(overMatch[1]);
    if (Number.isFinite(v)) return { minPriceKrw: Math.round(v * KRW_PER_MAN_WON) };
  }

  // Priority 6 — cheon_under: "X천원 이하/이내/미만"
  const underCheon = /(\d+(?:\.\d+)?)\s*천원\s*(?:이하|이내|미만)/u.exec(qn);
  if (underCheon !== null && underCheon[1] !== undefined) {
    const v = parseFloat(underCheon[1]);
    if (Number.isFinite(v)) return { maxPriceKrw: Math.round(v * KRW_PER_CHEON_WON) };
  }

  // Priority 7 — won_under: raw 원 value e.g. "50000원 이하"
  const underWon = /(\d+)\s*원\s*(?:이하|이내|미만)/u.exec(qn);
  if (underWon !== null && underWon[1] !== undefined) {
    const v = parseInt(underWon[1], 10);
    if (Number.isFinite(v)) return { maxPriceKrw: v };
  }

  // Priority 8 — won_over: raw 원 value e.g. "10000원 이상"
  const overWon = /(\d+)\s*원\s*이상/u.exec(qn);
  if (overWon !== null && overWon[1] !== undefined) {
    const v = parseInt(overWon[1], 10);
    if (Number.isFinite(v)) return { minPriceKrw: v };
  }

  return {};
}

// ---------------------------------------------------------------------------
// Vintage extraction
// ---------------------------------------------------------------------------

/**
 * Extracts vintage year range constraints.
 *
 * Supported formats:
 *   "YYYY년산" / "YYYY년" — exact vintage (sets both min and max)
 *   "YYYY년 이후"         — vintageMin = YYYY
 *   "YYYY년 이전"         — vintageMax = YYYY
 *   "YYYY-YYYY"           — year range
 *   "YYYY년산"            — exact vintage year (vintageMin = vintageMax = YYYY)
 */
const EXPLICIT_VINTAGE_YEAR_RE =
  /(?<![\p{L}\p{N}])((?:19|20)\d{2})년산?(?![\p{L}\p{N}])/u;

const POSTFIX_BARE_VINTAGE_CONTEXT_RE =
  /(?<![\p{L}\p{N}])((?:19|20)\d{2})(?=\s*(?:빈티지|vintage|와인|wine|레드|화이트|로제|스파클링)(?![\p{L}\p{N}]))/iu;

const PREFIX_BARE_VINTAGE_CONTEXT_RE =
  /(?:빈티지|vintage)\s*((?:19|20)\d{2})(?![\p{L}\p{N}])/iu;

function extractVintage(q: string): Pick<SearchConstraints, 'vintageMin' | 'vintageMax'> {
  // All vintage patterns delegate to the vintage SSoT
  // (`@domain/shared/utils/vintage`). Range parsing returns a normalized
  // {min,max} pair so callers do not need to swap reversed user input.
  const range = extractVintageRange(q);
  if (range !== null) {
    return { vintageMin: range.min, vintageMax: range.max };
  }

  const after = extractKoreanVintageAfter(q);
  if (after !== null) {
    return { vintageMin: after };
  }

  const before = extractKoreanVintageBefore(q);
  if (before !== null) {
    return { vintageMax: before };
  }

  const explicitYear = extractExplicitVintageYear(q);
  if (explicitYear !== null) {
    return { vintageMin: explicitYear, vintageMax: explicitYear };
  }

  // Bare 4-digit years are only promoted when they are syntactically tied to
  // a vintage-bearing context. This blocks false positives such as
  // "2018 FIFA World Cup wine" or producer labels like "Chateau Petrus 2015".
  const bareYear = extractContextualBareVintageYear(q);
  if (bareYear !== null) {
    return { vintageMin: bareYear, vintageMax: bareYear };
  }

  return {};
}

function extractExplicitVintageYear(q: string): number | null {
  const match = EXPLICIT_VINTAGE_YEAR_RE.exec(q);
  if (match?.[1] === undefined) {
    return null;
  }
  const year = Number.parseInt(match[1], 10);
  return Number.isFinite(year) ? year : null;
}

function extractContextualBareVintageYear(q: string): number | null {
  const prefixMatch = PREFIX_BARE_VINTAGE_CONTEXT_RE.exec(q);
  if (prefixMatch?.[1] !== undefined) {
    const year = Number.parseInt(prefixMatch[1], 10);
    return Number.isFinite(year) ? year : null;
  }

  const postfixMatch = POSTFIX_BARE_VINTAGE_CONTEXT_RE.exec(q);
  if (postfixMatch?.[1] !== undefined) {
    const year = Number.parseInt(postfixMatch[1], 10);
    return Number.isFinite(year) ? year : null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main extractor
// ---------------------------------------------------------------------------

/**
 * Resolves a token (Korean or English, lowercase) to its canonical wine_type value.
 * Returns undefined if the token is not a recognized wine type.
 *
 * Uses WINE_TYPE_RULES (SSoT) for resolution — not a separate mapping table.
 * This ensures Korean surface tokens ("화이트", "레드", "스파클링") are mapped to
 * canonical English values ("white", "red", "sparkling") that Vespa stores.
 */
function resolveWineTypeCanonical(token: string): string | undefined {
  for (const [pattern, canonical] of WINE_TYPE_RULES) {
    if (pattern.test(token)) return canonical;
  }
  return undefined;
}

/**
 * Extracts structured search constraints from a natural-language query string.
 *
 * This is a pure function — no I/O, no randomness, no external state.
 * The same input always produces the same output.
 *
 * @param query - The raw (or normalized) query string from the user.
 * @returns A {@link SearchConstraints} object. All fields are optional.
 *
 * @example
 * extractSearchConstraints('카베르네 빼고 5만원 이하 레드')
 * // → { excludeGrapes: ['Cabernet Sauvignon'], maxPriceKrw: 50000 }
 *
 * extractSearchConstraints('not Merlot, without France')
 * // → { excludeGrapes: ['Merlot'], excludeCountries: ['France'] }
 */
export function extractSearchConstraints(query: string): SearchConstraints {
  // NFC-normalize at the boundary so decomposed Hangul (NFD) inputs still
  // match the 한글 regex patterns. Without this, a client that sends
  // decomposed jamo (e.g. copy-pasted from an OS that uses NFD like macOS
  // filesystem paths) silently bypasses every Korean negation/price/grape
  // pattern — the regex expects precomposed 가 (U+AC00) but gets ㄱ+ㅏ.
  // Also maps fullwidth space (U+3000) to ASCII so downstream \s+ handling
  // and boundary lookarounds work uniformly.
  const qRaw = query.normalize('NFC').replace(/\u3000/g, ' ');
  // Korean negation normalization: convert predicative negation forms
  // (아닌/아니고/않고/않은) to canonical "말고" BEFORE pattern extraction.
  // This is a structural preprocessing step — the existing NEGATION_SUBJECT_AFTER
  // regex handles "말고", so all Korean negation forms route through one path.
  const q = normalizeKoreanNegation(qRaw);
  const excludeGrapeSet = new Set<string>();
  const excludeCountrySet = new Set<string>();
  const excludeRegionSet = new Set<string>();
  const excludeStyleSet = new Set<string>();
  const excludeWineTypeSet = new Set<string>();

  // Collect all negated subject tokens from both negation patterns.
  const subjectTokens: string[] = [];

  // Reset lastIndex before exec loops to guarantee correct iteration.
  NEGATION_SUBJECT_BEFORE.lastIndex = 0;
  NEGATION_SUBJECT_AFTER.lastIndex = 0;
  NEGATION_KOREAN_ADVERB_BEFORE.lastIndex = 0;

  let m: RegExpExecArray | null;

  while ((m = NEGATION_SUBJECT_BEFORE.exec(q)) !== null) {
    const subject = m.groups?.['subject'];
    if (subject !== undefined && subject.length > 0) {
      subjectTokens.push(subject.trim());
    }
  }

  while ((m = NEGATION_SUBJECT_AFTER.exec(q)) !== null) {
    const subject = m.groups?.['subject'];
    if (subject !== undefined && subject.length > 0) {
      subjectTokens.push(subject.trim());
    }
  }

  while ((m = NEGATION_KOREAN_ADVERB_BEFORE.exec(q)) !== null) {
    const subject = m.groups?.['subject'];
    if (subject !== undefined && subject.length > 0) {
      subjectTokens.push(subject.trim());
    }
  }

  // Classify each negated token as grape, country, region, or style.
  for (const token of subjectTokens) {
    const grape = normalizeGrapeName(token);
    if (grape !== undefined) {
      excludeGrapeSet.add(grape);
      continue;
    }

    const country = normalizeCountryName(token);
    if (country !== undefined) {
      excludeCountrySet.add(country);
      continue;
    }

    // Korean sweetness synonyms → map to canonical English Vespa style value.
    // '달콤한', '달콤', '스위트', '단맛' must resolve to 'sweet' (the English value
    // stored in the Vespa style field). Without this, excludeStyleSet would contain
    // the Korean token and the resulting style_not:달콤한 filter would never match.
    if (/^(?:달콤한|달콤|스위트|단맛)$/u.test(token)) {
      excludeStyleSet.add('sweet');
      continue;
    }

    // Wine type exclusions: resolve Korean surface tokens to canonical English values
    // and route to wine_type (not style). The previous code routed wine types to
    // excludeStyleSet which emits `style exclude "화이트"` — wrong because:
    // (a) attribute should be wine_type, not style, and
    // (b) Vespa stores English canonical values ("white"), not Korean surfaces ("화이트").
    //
    // WINE_TYPE_RULES (SSoT) handles both Korean and English tokens via regex matching,
    // so "화이트" → "white", "레드" → "red", "sparkling" → "sparkling" etc.
    const tokenLower = token.toLowerCase();
    const firstWord = tokenLower.split(/\s+/u)[0] ?? tokenLower;
    const wineTypeCanonical = resolveWineTypeCanonical(token) ?? resolveWineTypeCanonical(firstWord);
    if (wineTypeCanonical !== undefined) {
      excludeWineTypeSet.add(wineTypeCanonical);
      continue;
    }

    // Style exclusion: style/flavor descriptors that are not wine types themselves.
    //
    // Notes on the inline pattern:
    // - `oak(?:ed)?` matches 'oak' and 'oaked'; previously `oaked?` matched 'oake' (optional d
    //   on 'oake', not optional 'ed' on 'oak') — a regex quantifier precedence bug (rule 8).
    // - `full(?:-bodied)?`, `light(?:-bodied)?`, `medium(?:-bodied)?`, `bold`, `heavy`, `rich`
    //   are style body descriptors absent from WINE_TYPE_ALL_TOKENS. Without them, "not full-bodied"
    //   fell through to excludeRegionSet, emitting a no-op `region_not:full-bodied` YQL clause.
    // - Multi-word token handling: "내추럴 와인" is 2 words; WINE_TYPE_ALL_TOKENS has '내추럴' (1 word).
    //   Check both the full token and its first word so "내추럴 와인 빼고" routes to excludeStyleSet.
    if (
      WINE_TYPE_ALL_TOKENS.has(tokenLower) ||
      WINE_TYPE_ALL_TOKENS.has(firstWord) ||
      /^(?:oak(?:ed)?|sweet|sweeter|탄닌|오크|full(?:-bodied)?|light(?:-bodied)?|medium(?:-bodied)?|bold|heavy|rich)$/iu.test(tokenLower)
    ) {
      // Use firstWord ONLY when the full token is a multi-word wine type (e.g. "내추럴 와인" → '내추럴')
      // and the full token is NOT in WINE_TYPE_ALL_TOKENS but firstWord IS.
      // For inline-regex matches (e.g. "full-bodied", "light-bodied"), use tokenLower — firstWord
      // would be "full" or "light" which is wrong (excludes too broadly).
      const canonicalToken =
        WINE_TYPE_ALL_TOKENS.has(tokenLower)
          ? tokenLower
          : WINE_TYPE_ALL_TOKENS.has(firstWord)
            ? firstWord
            : tokenLower;
      excludeStyleSet.add(canonicalToken);
      continue;
    }

    // Anything else treated as region exclusion (free-form)
    excludeRegionSet.add(token);
  }

  // RCA5-07: try foreign-currency (USD/EUR/GBP/₩ symbol) patterns first; if
  // none match, fall through to the KRW-native (만원/천원/원) extractor.
  // Ordering matters: "₩70,000 이하" contains no Korean unit suffix, so the
  // KRW-native extractor silently misses it without this pre-pass.
  const fxPrice = extractForeignCurrencyPrice(q);
  const numericPrice =
    fxPrice.minPriceKrw !== undefined || fxPrice.maxPriceKrw !== undefined
      ? fxPrice
      : extractKrwPrice(q);
  // Retail-channel keywords (편의점/마트/백화점) set a soft maxPriceKrw cap.
  // Numeric price wins when present — it is always more specific than a channel label.
  const channelPrice = extractRetailChannelPrice(q);
  const price: Pick<SearchConstraints, 'minPriceKrw' | 'maxPriceKrw'> = {
    ...channelPrice,
    ...numericPrice, // numeric overrides channel when both present
  };
  const vintage = extractVintage(q);

  const excludeGrapes = [...excludeGrapeSet];
  const excludeCountries = [...excludeCountrySet];
  const excludeRegions = [...excludeRegionSet];
  const excludeStyles = [...excludeStyleSet];
  const excludeWineTypes = [...excludeWineTypeSet];

  return {
    ...(excludeGrapes.length > 0 ? { excludeGrapes } : {}),
    ...(excludeCountries.length > 0 ? { excludeCountries } : {}),
    ...(excludeRegions.length > 0 ? { excludeRegions } : {}),
    ...(excludeStyles.length > 0 ? { excludeStyles } : {}),
    ...(excludeWineTypes.length > 0 ? { excludeWineTypes } : {}),
    ...price,
    ...vintage,
  };
}

// ---------------------------------------------------------------------------
// Filter token builders
// ---------------------------------------------------------------------------

/**
 * Converts a {@link SearchConstraints} object into Vespa sparse filter tokens
 * that can be passed to {@link buildSparseFilters} (in mapping.ts).
 *
 * Token format:
 *   `grape_primary_not:<value>`  — NOT grape filter
 *   `grapes_not:<value>`         — NOT grapes array filter
 *   `country_not:<value>`        — NOT country filter
 *   `region_not:<value>`         — NOT region filter
 *   `style_not:<value>`          — NOT style filter
 *   `price_usd_min:<value>`      — price USD min
 *   `price_usd_max:<value>`      — price USD max
 *   `vintage_year_min:<value>`   — vintage year min
 *   `vintage_year_max:<value>`   — vintage year max
 *
 * Price tokens use {@link krwToUsd} for conversion. Values are already
 * validated by the extraction step so no further clamping is done here.
 */
export function searchConstraintsToFilterTokens(
  constraints: SearchConstraints,
): readonly string[] {
  const tokens: string[] = [];

  for (const grape of constraints.excludeGrapes ?? []) {
    tokens.push(`grape_primary_not:${grape}`);
    tokens.push(`grapes_not:${grape}`);
  }

  for (const country of constraints.excludeCountries ?? []) {
    tokens.push(`country_not:${country}`);
  }

  for (const region of constraints.excludeRegions ?? []) {
    tokens.push(`region_not:${region}`);
  }

  for (const style of constraints.excludeStyles ?? []) {
    tokens.push(`style_not:${style}`);
  }

  for (const wineType of constraints.excludeWineTypes ?? []) {
    tokens.push(`wine_type_not:${wineType}`);
  }

  if (constraints.minPriceKrw !== undefined) {
    const usd = krwToUsd(constraints.minPriceKrw);
    tokens.push(`price_usd_min:${usd}`);
  }

  if (constraints.maxPriceKrw !== undefined) {
    const usd = krwToUsd(constraints.maxPriceKrw);
    tokens.push(`price_usd_max:${usd}`);
  }

  if (constraints.vintageMin !== undefined) {
    tokens.push(`vintage_year_min:${constraints.vintageMin}`);
  }

  if (constraints.vintageMax !== undefined) {
    tokens.push(`vintage_year_max:${constraints.vintageMax}`);
  }

  return tokens;
}
