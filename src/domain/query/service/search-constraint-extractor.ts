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
  KRW_PER_MAN_WON,
  KRW_PER_USD_APPROXIMATE,
} from '../../shared/constants.js';
import { WINE_TYPE_ALL_TOKENS } from '../model/wine-type-patterns.js';
import {
  extractKoreanVintageAfter,
  extractKoreanVintageBefore,
  extractVintageRange,
} from '../../shared/utils/vintage.js';

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
  // (?![\p{L}\p{N}]) = lookahead character class: not followed by letter OR digit. (rule 24)
  // (?!\p{L})(?!\p{N}) was wrong: AND-sequence, never blocks anything useful.
  [/미국|미(?![\p{L}\p{N}])|usa|united\s+states|american/iu, 'United States'],
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
  /(?:^|[^\p{L}\p{N}])(?<subject>[^\s,;]+(?:\s+[^\s,;]+)?)\s+(?:빼고|제외|말고|없이|빼(?=[^\p{L}\p{N}]|$))/giu;

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
  return s.replace(
    /([일이삼사오육칠팔구십백]+)\s*(만|천)(?=원|대|$|[^가-힣])/gu,
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

  // Priority 4 — man_under: "X만원 이하/이내/미만/정도/쯤/약"
  // 정도/쯤/약 are "approximate around" markers — treated as soft upper bound
  // (the band logic at priority 3 handles the explicit "대" form with ±10%).
  const underMatch = /(\d+(?:\.\d+)?)\s*만원\s*(?:이하|이내|미만|정도|쯤|약)/u.exec(qn);
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
 */
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

  return {};
}

// ---------------------------------------------------------------------------
// Main extractor
// ---------------------------------------------------------------------------

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
  const q = query;
  const excludeGrapeSet = new Set<string>();
  const excludeCountrySet = new Set<string>();
  const excludeRegionSet = new Set<string>();
  const excludeStyleSet = new Set<string>();

  // Collect all negated subject tokens from both negation patterns.
  const subjectTokens: string[] = [];

  // Reset lastIndex before exec loops to guarantee correct iteration.
  NEGATION_SUBJECT_BEFORE.lastIndex = 0;
  NEGATION_SUBJECT_AFTER.lastIndex = 0;

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

    // Style exclusion: wine type terms (from canonical WINE_TYPE_ALL_TOKENS SSOT)
    // plus style/flavor descriptors that are not wine types themselves.
    if (
      WINE_TYPE_ALL_TOKENS.has(token.toLowerCase()) ||
      /^(?:oaked?|sweet|sweeter|탄닌|오크)$/iu.test(token)
    ) {
      excludeStyleSet.add(token.toLowerCase());
      continue;
    }

    // Anything else treated as region exclusion (free-form)
    excludeRegionSet.add(token);
  }

  const price = extractKrwPrice(q);
  const vintage = extractVintage(q);

  const excludeGrapes = [...excludeGrapeSet];
  const excludeCountries = [...excludeCountrySet];
  const excludeRegions = [...excludeRegionSet];
  const excludeStyles = [...excludeStyleSet];

  return {
    ...(excludeGrapes.length > 0 ? { excludeGrapes } : {}),
    ...(excludeCountries.length > 0 ? { excludeCountries } : {}),
    ...(excludeRegions.length > 0 ? { excludeRegions } : {}),
    ...(excludeStyles.length > 0 ? { excludeStyles } : {}),
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
