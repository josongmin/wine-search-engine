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
 * 1 USD ≈ 1350 KRW (mid-2025 reference rate).
 */
export const KRW_PER_USD = 1350 as const;

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
  [/미국|미(?!\p{L}\p{N})|usa|united\s+states|american/iu, 'USA'],
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
 * Supported formats (where X/Y are integers or decimals):
 *   "X만원 이하"  / "X만원 이내"  / "X만원 미만"  → maxPriceKrw = X * 10_000
 *   "X만원 이상"                                  → minPriceKrw = X * 10_000
 *   "X~Y만원"    / "X-Y만원"                      → min/max range
 *   "X만원대"                                     → min/max band (±10%)
 *   "X천원 이하"                                  → maxPriceKrw = X * 1_000
 *   "X원 이하"                                    → maxPriceKrw = X (raw won)
 */
function extractKrwPrice(q: string): Pick<SearchConstraints, 'minPriceKrw' | 'maxPriceKrw'> {
  // Range: "3~5만원" or "3-5만원"
  const rangeMatch = /(\d+(?:\.\d+)?)[~\-–](\d+(?:\.\d+)?)\s*만원/u.exec(q);
  if (rangeMatch !== null && rangeMatch[1] !== undefined && rangeMatch[2] !== undefined) {
    const lo = parseFloat(rangeMatch[1]);
    const hi = parseFloat(rangeMatch[2]);
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      return {
        minPriceKrw: Math.round(lo * 10_000),
        maxPriceKrw: Math.round(hi * 10_000),
      };
    }
  }

  // "X만원대" — treat as ±10% band around X만원 midpoint
  const bandMatch = /(\d+(?:\.\d+)?)\s*만원대/u.exec(q);
  if (bandMatch !== null && bandMatch[1] !== undefined) {
    const mid = parseFloat(bandMatch[1]) * 10_000;
    if (Number.isFinite(mid)) {
      return {
        minPriceKrw: Math.round(mid * 0.9),
        maxPriceKrw: Math.round(mid * 1.1),
      };
    }
  }

  // Upper bound: "X만원 이하/이내/미만"
  const underMatch = /(\d+(?:\.\d+)?)\s*만원\s*(?:이하|이내|미만)/u.exec(q);
  if (underMatch !== null && underMatch[1] !== undefined) {
    const v = parseFloat(underMatch[1]);
    if (Number.isFinite(v)) return { maxPriceKrw: Math.round(v * 10_000) };
  }

  // Lower bound: "X만원 이상"
  const overMatch = /(\d+(?:\.\d+)?)\s*만원\s*이상/u.exec(q);
  if (overMatch !== null && overMatch[1] !== undefined) {
    const v = parseFloat(overMatch[1]);
    if (Number.isFinite(v)) return { minPriceKrw: Math.round(v * 10_000) };
  }

  // 천원 (thousands of won): "X천원 이하"
  const underCheon = /(\d+(?:\.\d+)?)\s*천원\s*(?:이하|이내|미만)/u.exec(q);
  if (underCheon !== null && underCheon[1] !== undefined) {
    const v = parseFloat(underCheon[1]);
    if (Number.isFinite(v)) return { maxPriceKrw: Math.round(v * 1_000) };
  }

  // Raw 원: "X원 이하"
  const underWon = /(\d+)\s*원\s*(?:이하|이내|미만)/u.exec(q);
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
  // Year range: "2018-2022" or "2018~2022"
  const rangeMatch = /(?<!\p{L}\p{N})((?:19|20)\d{2})[~\-–]((?:19|20)\d{2})(?!\p{L}\p{N})/u.exec(q);
  if (rangeMatch !== null && rangeMatch[1] !== undefined && rangeMatch[2] !== undefined) {
    const lo = parseInt(rangeMatch[1], 10);
    const hi = parseInt(rangeMatch[2], 10);
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      return { vintageMin: lo, vintageMax: hi };
    }
  }

  // "YYYY년 이후" — after
  const afterMatch = /((?:19|20)\d{2})년?\s*이후/u.exec(q);
  if (afterMatch !== null && afterMatch[1] !== undefined) {
    const v = parseInt(afterMatch[1], 10);
    if (Number.isFinite(v)) return { vintageMin: v };
  }

  // "YYYY년 이전" — before
  const beforeMatch = /((?:19|20)\d{2})년?\s*이전/u.exec(q);
  if (beforeMatch !== null && beforeMatch[1] !== undefined) {
    const v = parseInt(beforeMatch[1], 10);
    if (Number.isFinite(v)) return { vintageMax: v };
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
  const excludeGrapes: string[] = [];
  const excludeCountries: string[] = [];
  const excludeRegions: string[] = [];
  const excludeStyles: string[] = [];

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
      if (!excludeGrapes.includes(grape)) excludeGrapes.push(grape);
      continue;
    }

    const country = normalizeCountryName(token);
    if (country !== undefined) {
      if (!excludeCountries.includes(country)) excludeCountries.push(country);
      continue;
    }

    // Style exclusion: recognize common descriptors
    if (/^(?:oaked?|sweet|sweeter|dessert|fortified|sparkling|탄닌|오크)$/iu.test(token)) {
      if (!excludeStyles.includes(token.toLowerCase())) {
        excludeStyles.push(token.toLowerCase());
      }
      continue;
    }

    // Anything else treated as region exclusion (free-form)
    if (!excludeRegions.includes(token)) excludeRegions.push(token);
  }

  const price = extractKrwPrice(q);
  const vintage = extractVintage(q);

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
