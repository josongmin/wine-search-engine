import type { ConstraintBundle } from '../../shared/types/index.js';
import {
  KRW_PER_MAN_WON,
  KRW_PER_USD_APPROXIMATE,
} from '../../shared/constants.js';
import {
  BODY_FULL_MIN,
  BODY_LIGHT_MAX,
  BODY_MEDIUM_MAX,
  BODY_MEDIUM_MIN,
  SWEETNESS_DRY_MAX,
  SWEETNESS_SWEET_MIN,
} from '../../shared/constants/sensory-thresholds.js';
import { convertKrwToConstraintUsd } from '../../shared/utils/canonical-price.js';
import { WINE_TYPE_RULES } from '../model/wine-type-patterns.js';
import {
  extractSearchConstraints,
} from './search-constraint-extractor.js';
import { normalizeQueryPredicates } from './korean-predicate-variants.js';

/** Version tag applied to all rule-based constraints (RFC-004, RFC-005). */
const RULE_BASED_CONSTRAINT_MAPPING_VERSION = 'rule-based-v1.0';

const DECIMAL_RADIX = 10;

/**
 * Formalized negation scope thresholds (NLU rule-based-constraint-extractor v4).
 *
 * Wine palate attributes (tannin, sweetness, etc.) are normalized into the
 * [0, 1] range across the catalog. When a user phrases an aversion ("not too
 * tannic", "no high tannin", "안 단", "별로 안 단"), we map the implied
 * upper bound to one of two named percentile cutoffs instead of a magic
 * number. CLAUDE.md rule 15: extract penalty/threshold magic numbers to
 * named constants with documented rationale.
 *
 *   - SOFT cap (40th percentile): mild aversion phrasing — "not too X",
 *     "별로 안 X". The user tolerates moderate intensity but rejects the
 *     high end. Quantile chosen so that wines in the bottom 40% of the
 *     catalog's intensity distribution remain eligible — broad recall, mild
 *     filtering.
 *
 *   - HARD cap (25th percentile): strong aversion phrasing — "no high X",
 *     "low X only", "안 X" (Korean short-form negation), "X 빼고" /
 *     "X 없이" (exclusion phrases). The user wants the bottom quartile only;
 *     anything above is undesired.
 *
 * Note: these are *soft* constraint upper bounds (operator '<=') — they
 * influence ranking, not hard filtering. A wine at 0.45 tannin is still
 * eligible under "not too tannic" but penalized relative to one at 0.30.
 */
export const NEGATION_SOFT_CAP_QUANTILE = 0.4;
export const NEGATION_HARD_CAP_QUANTILE = 0.25;
/** USD thresholds for mapping numeric "under $X" hints to price_band labels.
 *  Derived from Vivino/Wine-Searcher market segmentation (2024):
 *    budget: ≤$20 (everyday wines, supermarket tier)
 *    mid:    ≤$50 (restaurant-by-the-glass, enthusiast entry)
 *    premium:≤$100 (cellar-worthy, boutique producers)
 *    luxury: >$100 (fine wine, collector market) */
const PRICE_BAND_BUDGET_MAX_USD = 20;
const PRICE_BAND_MID_MAX_USD = 50;
const PRICE_BAND_PREMIUM_MAX_USD = 100;

/**
 * Rule-based constraint extractor: pattern-matches the normalized query
 * directly without a mapping table.
 *
 * Fallback when NLMapper returns nothing; see Planner.parseConstraints.
 */
export function extractRuleBasedConstraints(normalizedQuery: string): ConstraintBundle {
  const hard: ConstraintBundle['hard'][number][] = [];
  const soft: ConstraintBundle['soft'][number][] = [];
  // Unicode hygiene: Korean Hangul has both NFC (precomposed syllable) and
  // NFD (decomposed jamo) byte forms. All regexes in this file are written
  // in NFC; NFD input (e.g. from clipboard/HFS+ filenames/cross-platform
  // round-trips) would silently miss every Korean-targeting cap.
  // extractSearchConstraints (search-constraint-extractor.ts:823) already
  // normalizes internally — we now do the same at this entry boundary so
  // both extractor pipelines see identical Unicode forms (CLAUDE.md rule 8,
  // SOTA++ Unicode safety baseline).
  const q = normalizedQuery.normalize('NFC');
  const predicateNormalizedQuery = normalizeQueryPredicates(q);
  const searchConstraints = extractSearchConstraints(q);
  const mv = RULE_BASED_CONSTRAINT_MAPPING_VERSION;

  for (const [pattern, value] of WINE_TYPE_RULES) {
    if (pattern.test(q)) {
      hard.push({
        attribute: 'wine_type',
        operator: '=',
        value,
        source_phrase: value,
        confidence: 0.9,
        mapping_version: mv,
      });
      break;
    }
  }

  const countryRules: [RegExp, string][] = [
    [/(?:^|[^\p{L}\p{N}])(?:french|france|프랑스)(?=$|[^\p{L}\p{N}])/iu, 'France'],
    [/(?:^|[^\p{L}\p{N}])(?:italian|italy|이탈리아)(?=$|[^\p{L}\p{N}])/iu, 'Italy'],
    [/(?:^|[^\p{L}\p{N}])(?:spanish|spain|스페인)(?=$|[^\p{L}\p{N}])/iu, 'Spain'],
    [/(?:^|[^\p{L}\p{N}])(?:american|usa|us wine|california|napa|sonoma|oregon|미국)(?=$|[^\p{L}\p{N}])/iu, 'United States'],
    [/(?:^|[^\p{L}\p{N}])(?:australian|australia|호주)(?=$|[^\p{L}\p{N}])/iu, 'Australia'],
    [/(?:^|[^\p{L}\p{N}])(?:argentinian|argentina|아르헨티나)(?=$|[^\p{L}\p{N}])/iu, 'Argentina'],
    [/(?:^|[^\p{L}\p{N}])(?:chilean|chile|칠레)(?=$|[^\p{L}\p{N}])/iu, 'Chile'],
    [/(?:^|[^\p{L}\p{N}])(?:german|germany|독일)(?=$|[^\p{L}\p{N}])/iu, 'Germany'],
    [/(?:^|[^\p{L}\p{N}])(?:portuguese|portugal|포르투갈)(?=$|[^\p{L}\p{N}])/iu, 'Portugal'],
    [/(?:^|[^\p{L}\p{N}])(?:new zealand|뉴질랜드)(?=$|[^\p{L}\p{N}])/iu, 'New Zealand'],
    [/(?:^|[^\p{L}\p{N}])(?:south african?|south africa|남아공)(?=$|[^\p{L}\p{N}])/iu, 'South Africa'],
    [/(?:^|[^\p{L}\p{N}])(?:austrian|austria|오스트리아)(?=$|[^\p{L}\p{N}])/iu, 'Austria'],
  ];
  // No break — accumulate ALL matching countries. A query like "France or Italy"
  // should extract both; breaking at the first match silently drops subsequent ones
  // (CLAUDE.md Rule 17: for...of with break in accumulator loop is almost certainly wrong).
  for (const [pattern, value] of countryRules) {
    if (pattern.test(q)) {
      hard.push({
        attribute: 'country',
        operator: '=',
        value,
        source_phrase: value,
        confidence: 0.85,
        mapping_version: mv,
      });
    }
  }

  const priceUnder =
    // BUG-14: Use single character class `(?<![\p{L}\p{N}])` / `(?![\p{L}\p{N}])` (Rule 24).
    // Two separate lookaheads (?<!\p{L})(?<!\p{N}) are logically equivalent (both must pass)
    // but the canonical form with brackets is unambiguous and avoids confusion with the
    // truly broken 2-char sequence form (?<!\p{L}\p{N}).
    /(?<![\p{L}\p{N}])under\s+\$?(\d+)(?![\p{L}\p{N}])/iu.exec(q) ??
    /(\d+)\s*(?:달러|dollar)\s*이하/iu.exec(q) ??
    /(\d+)\s*만원\s*(?:이하|미만|대)/iu.exec(q);
  if (priceUnder?.[1] !== undefined && searchConstraints.maxPriceKrw === undefined) {
    const priceValue = parseInt(priceUnder[1], DECIMAL_RADIX);
    // Guard: parseInt can return NaN on malformed capture group (edge case with regex backtracking).
    // NaN would propagate into band comparison (always false) and corrupt soft constraints. (CLAUDE.md rule 28)
    // BUG-P1 fix: was `return { hard, soft, inferred: [] }` — that discarded all previously
    // accumulated hard constraints (wine_type, country, etc.) when price parsing failed.
    // Correct fix: skip only the price_band push; let the rest of the function continue.
    if (!Number.isFinite(priceValue)) {
      // skip price_band extraction — do not return early
    } else {
    // Determine the matched currency context from which regex fired.
    // The third regex (`만원 이하`) means the value is already in 만원 units (×10000 KRW).
    // The second regex (`달러 이하`) means USD. The first regex (`under $N`) means USD.
    // We must detect currency from the MATCHED regex, not from a global 만원 presence scan
    // (global scan would misfire on queries like "50달러 under wine 10만원" — the 만원
    // appears in the query but the matched price was in dollars).
    const matchedText = priceUnder[0];
    const isKrwManWon = /만원/u.test(matchedText);
    // If the matched text contains 만원, convert from 만원 units to USD.
    // Otherwise (달러, dollar, $, or bare number) treat directly as USD.
    const usd = isKrwManWon
      ? priceValue * KRW_PER_MAN_WON / KRW_PER_USD_APPROXIMATE
      : priceValue;
    const band =
      usd <= PRICE_BAND_BUDGET_MAX_USD
        ? 'budget'
        : usd <= PRICE_BAND_MID_MAX_USD
          ? 'mid'
          : usd <= PRICE_BAND_PREMIUM_MAX_USD
            ? 'premium'
            : 'luxury';
    soft.push({
      attribute: 'price_band',
      operator: '=',
      value: band,
      source_phrase: priceUnder[0],
      confidence: 0.8,
      mapping_version: mv,
    });
    } // end else (isFinite branch)
  }

  // Standalone price-level keywords (no numeric amount)
  const priceAversionContext =
    /(?:너무\s*)?비싸(?:면|서|고)?/u.test(q)
    || /부담(?:스럽|없는|없고|돼|되)/u.test(q);

  if (!priceUnder && /(?:비싼|비싸|고급|럭셔리|프리미엄)/u.test(q) && !priceAversionContext) {
    soft.push({
      attribute: 'price_band',
      operator: '=',
      value: /(?:비싼|비싸|럭셔리)/u.test(q) ? 'luxury' : 'premium',
      source_phrase: '비싼/고급',
      confidence: 0.7,
      mapping_version: mv,
    });
  } else if (/(?:저렴|싼|입문)/u.test(q) && !priceUnder) {
    // "저렴/싼/입문" without a numeric price → infer budget band.
    // Guarded by !priceUnder because a numeric price already carries the intent.
    soft.push({
      attribute: 'price_band',
      operator: '=',
      value: 'budget',
      source_phrase: '저렴/싼/입문',
      confidence: 0.7,
      mapping_version: mv,
    });
  }

  // "가성비" (value-for-money) is ALWAYS added as a soft signal, even when a
  // numeric price constraint is also present. The two intents are orthogonal:
  // "가성비 10만원 이하" means "best value within 100k", not just "under 100k".
  if (/가성비/u.test(q)) {
    soft.push({
      attribute: 'price_band',
      operator: '=',
      value: 'mid',
      source_phrase: '가성비',
      confidence: 0.7,
      mapping_version: mv,
    });
  }

  // Critic score / rating keywords: "평점 좋은/높은" and their connective variants
  // (좋고, 높고) are handled by DEFAULT_MAPPINGS in nl-mapper.ts (SSoT) +
  // predicate variant lookup. Only non-NL structural patterns remain here.
  if (
    /(?:^|[^\p{L}\p{N}])(?:평점|점수|별점|리뷰)\s*(?:좋은|높은|훌륭한|최고)(?=$|[^\p{L}\p{N}])/u
      .test(predicateNormalizedQuery)
  ) {
    soft.push({
      attribute: 'critic_score',
      operator: '>=',
      value: 0.7,
      source_phrase: '평점/점수 좋은',
      confidence: 0.75,
      mapping_version: mv,
    });
  }

  if (/(?:^|[^\p{L}\p{N}])(?:full(?:[\s-]?body|[\s-]?bodied)|풀바디|bold|heavy|묵직)(?=$|[^\p{L}\p{N}])/iu.test(q)) {
    soft.push({
      attribute: 'body',
      operator: '>=',
      value: BODY_FULL_MIN,
      source_phrase: 'full-body',
      confidence: 0.75,
      mapping_version: mv,
    });
  } else if (
    /(?:^|[^\p{L}\p{N}])(?:light(?:[\s-]?body|[\s-]?bodied)|라이트바디|light wine|가벼(?:운|운편|우며|우면서)|가볍(?:고|게|지만)?)(?=$|[^\p{L}\p{N}])/iu
      .test(q)
  ) {
    soft.push({
      attribute: 'body',
      operator: '<=',
      value: BODY_LIGHT_MAX,
      source_phrase: 'light-body',
      confidence: 0.75,
      mapping_version: mv,
    });
  } else if (
    /(?:^|[^\p{L}\p{N}])(?:medium(?:[\s-]?body|[\s-]?bodied)|미디엄바디|미디엄\s*바디|미디엄)(?=$|[^\p{L}\p{N}])/iu
      .test(q)
  ) {
    soft.push({
      attribute: 'body',
      operator: 'range',
      value: { min: BODY_MEDIUM_MIN, max: BODY_MEDIUM_MAX },
      source_phrase: 'medium-body',
      confidence: 0.78,
      mapping_version: mv,
    });
  }

  // Query-local connective normalization restores direct regex coverage for
  // connective/adnominal Korean quality phrases without mutating the original
  // query surface that SearchConstraints relies on for negation parsing.
  if (/(?:^|[^\p{L}\p{N}])(?:바디감|바디)\s*(?:있는|좋은)(?=$|[^\p{L}\p{N}])/u.test(predicateNormalizedQuery)) {
    soft.push({
      attribute: 'body',
      operator: '>=',
      value: 0.5,
      source_phrase: '바디감 있는',
      confidence: 0.8,
      mapping_version: mv,
    });
  }

  // "low tannin" intent
  if (
    /(?:타닌\s*약(?:한|하게)?|타닌감?\s*약(?:한|하게)?|타닌감?\s*없는|부드러(?:운|움|운편)?)/u
      .test(predicateNormalizedQuery)
  ) {
    soft.push({
      attribute: 'tannin',
      operator: '<=',
      value: 0.4,
      source_phrase: '타닌 약',
      confidence: 0.8,
      mapping_version: mv,
    });
  }

  // "fresh / crisp / high-acid" intent
  if (
    /(?:상큼(?:한|하게)?|산뜻(?:한|하게)?|산미\s*(?:있(?:는|고)|좋(?:은|고)|높(?:은|고))|crisp|fresh|zesty|high[\s-]?acid)/iu
      .test(predicateNormalizedQuery)
  ) {
    soft.push({
      attribute: 'acidity',
      operator: '>=',
      value: 0.6,
      source_phrase: '상큼/산미',
      confidence: 0.8,
      mapping_version: mv,
    });
  }

  // "high tannin / firm tannin" intent
  if (
    /(?:강한?\s*타닌|타닌감?\s*(?:강(?:한|하게)|있(?:는|고)|좋(?:은|고))|tannic|high[\s-]?tannin|firm[\s-]?tannin)/iu
      .test(predicateNormalizedQuery)
  ) {
    soft.push({
      attribute: 'tannin',
      operator: '>=',
      value: 0.6,
      source_phrase: '강한 타닌',
      confidence: 0.8,
      mapping_version: mv,
    });
  }

  // "fruity" intensity intent
  if (/(?:과일향\s*풍부(?:한|하게)?|과일향\s*진하(?:다|한|게)?|fruity)/iu.test(predicateNormalizedQuery)) {
    soft.push({
      attribute: 'fruit_intensity',
      operator: '>=',
      value: 0.6,
      source_phrase: '과일향 풍부',
      confidence: 0.78,
      mapping_version: mv,
    });
  }

  // SCAN4-05: standalone "dry" should match as sweetness=dry, but NOT when "dry"
  // modifies a wine type (e.g. "dry white wine", "dry red wine", "dry rosé").
  // Using negative lookahead (?!\s+(?:white|red|ros[eé]|wine|fruit)) prevents
  // the false-positive where "dry white wine" would emit sweetness='dry' even
  // though the user only means the wine type adjective, not a sweetness preference.
  // Rule 8: \b is ASCII-only — use Unicode-safe boundary assertions.
  // Rule 24: use [\p{L}\p{N}] character class (OR), not \p{L}\p{N} sequence.
  if (
    /(?:^|[^\p{L}\p{N}])(?:dry)(?!\s+(?:white|red|ros[eé]|wine|fruit))(?=$|[^\p{L}\p{N}])/iu.test(q)
    || /(?:^|[^\p{L}\p{N}])(?:드라이|brut|extra[\s-]?brut)(?=$|[^\p{L}\p{N}])/iu.test(q)
  ) {
    soft.push({
      attribute: 'sweetness',
      operator: '<=',
      value: SWEETNESS_DRY_MAX,
      source_phrase: 'dry',
      confidence: 0.8,
      mapping_version: mv,
    });
  } else if (
    /(?:^|[^\p{L}\p{N}])(?:sweet wine|달콤한|달달한|달달|달큰한|단맛(?:\s*(?:있는|나는))?|스위트|demi[\s-]?sec|semi[\s-]?sweet)(?=$|[^\p{L}\p{N}])/iu.test(q)
    // Bare "sweet" qualifies as a positive sweetness preference when it is
    // NOT immediately preceded by an aversion modifier ("too"/"not"/"no").
    // This allows "sweet but not too sweet" to emit BOTH sweetness=sweet
    // (positive intent) AND sweetness_max=SOFT cap (the "not too sweet"
    // qualifier). Negative lookbehind avoids false-positives where the
    // ONLY occurrence is in the negated phrase.
    || /(?:^|[^\p{L}\p{N}])(?<!too\s)(?<!not\s)(?<!no\s)sweet(?=$|[^\p{L}\p{N}])/iu.test(q)
  ) {
    soft.push({
      attribute: 'sweetness',
      operator: '>=',
      value: SWEETNESS_SWEET_MIN,
      source_phrase: 'sweet',
      confidence: 0.8,
      mapping_version: mv,
    });
  }

  // -------------------------------------------------------------------------
  // Formalized negation scope: tannin_max / sweetness_max upper bounds
  // -------------------------------------------------------------------------
  // Pure-pattern extraction of palate aversions. Two cap tiers:
  //   - SOFT (40th percentile) for mild phrasings: "not too X", "별로 안 X"
  //   - HARD (25th percentile) for strong phrasings: "no high X", "low X only",
  //     "안 X" (KR short-form negation), "X 빼고" / "X 없이" / "X 말고"
  //
  // Precedence rules (critical to correctness):
  //   1. SOFT must be detected before HARD ("별로 안 단" must NOT also trigger
  //      the bare "안" hard cap).
  //   2. "not too X" coexists with positive "X" (e.g. "sweet but not too sweet"
  //      emits BOTH sweetness=sweet (positive, above) AND sweetness_max=SOFT).
  //   3. False-positive guard: generic "not" without an adjective (e.g.
  //      "this wine is not what I want") MUST NOT trigger any cap.
  //
  // Rule 8 / 24: Unicode-safe boundaries via (?:^|[^\p{L}\p{N}]) /
  //              (?=$|[^\p{L}\p{N}]) — never \b on Korean.

  // English / Korean SOFT cap — TANNIN
  // "not too tannic" / "약간 떫은" / "별로 안 떫" — palatable bottom 40%.
  const tanninSoftNeg =
    /(?:^|[^\p{L}\p{N}])not\s+too\s+tannic(?=$|[^\p{L}\p{N}])/iu.test(q)
    || /별로\s*안\s*떫/u.test(q);

  // English / Korean HARD cap — TANNIN
  // "no high tannin" / "low tannin only" / "안 떫" (without 별로) /
  // "떫은 와인 빼고|없이|말고".
  const tanninHardNeg =
    /(?:^|[^\p{L}\p{N}])no\s+high\s+tannin(?=$|[^\p{L}\p{N}])/iu.test(q)
    || /(?:^|[^\p{L}\p{N}])low\s+tannin\s+only(?=$|[^\p{L}\p{N}])/iu.test(q)
    || (/(?:^|[^\p{L}\p{N}])안\s+떫/u.test(q) && !/별로\s*안\s*떫/u.test(q))
    || /떫은?\s*와인\s*(?:빼고|없이|말고)/u.test(q);

  if (tanninSoftNeg) {
    soft.push({
      attribute: 'tannin_max',
      operator: '<=',
      value: NEGATION_SOFT_CAP_QUANTILE,
      source_phrase: 'not too tannic / 별로 안 떫',
      confidence: 0.7,
      mapping_version: mv,
    });
  } else if (tanninHardNeg) {
    soft.push({
      attribute: 'tannin_max',
      operator: '<=',
      value: NEGATION_HARD_CAP_QUANTILE,
      source_phrase: 'no high tannin / low tannin only / 안 떫 / 떫은 와인 빼고',
      confidence: 0.8,
      mapping_version: mv,
    });
  }

  // English / Korean SOFT cap — SWEETNESS
  const sweetnessSoftNeg =
    /(?:^|[^\p{L}\p{N}])not\s+too\s+sweet(?=$|[^\p{L}\p{N}])/iu.test(q)
    || /별로\s*안\s*단/u.test(q);

  // English / Korean HARD cap — SWEETNESS
  // Includes both 안/못 short-form negations (KR) and exclusion phrases.
  const sweetnessHardNeg =
    /(?:^|[^\p{L}\p{N}])no\s+sweet(?:\s+wines?)?(?=$|[^\p{L}\p{N}])/iu.test(q)
    || /(?:^|[^\p{L}\p{N}])low\s+sweetness\s+only(?=$|[^\p{L}\p{N}])/iu.test(q)
    || (/(?:^|[^\p{L}\p{N}])안\s+단(?=[^\p{L}\p{N}]|$)/u.test(q) && !/별로\s*안\s*단/u.test(q))
    || /(?:^|[^\p{L}\p{N}])못\s+단(?=[^\p{L}\p{N}]|$)/u.test(q)
    || /단\s*와인(?:은|는)?\s*(?:빼고|없이|말고|제외)/u.test(q);

  if (sweetnessSoftNeg) {
    soft.push({
      attribute: 'sweetness_max',
      operator: '<=',
      value: NEGATION_SOFT_CAP_QUANTILE,
      source_phrase: 'not too sweet / 별로 안 단',
      confidence: 0.7,
      mapping_version: mv,
    });
  } else if (sweetnessHardNeg) {
    soft.push({
      attribute: 'sweetness_max',
      operator: '<=',
      value: NEGATION_HARD_CAP_QUANTILE,
      source_phrase: 'no sweet / 안 단 / 못 단 / 단 와인 빼고',
      confidence: 0.8,
      mapping_version: mv,
    });
  }

  // -------------------------------------------------------------------------
  // Exclusion constraints via SearchConstraints
  // -------------------------------------------------------------------------
  // extractSearchConstraints handles negation patterns ("빼고", "제외", "말고",
  // "without X", "no X", etc.) for grape, country, region, and style.
  // These are emitted as hard `exclude` constraints so downstream filter
  // injection can produce Vespa NOT-clauses.
  for (const grape of searchConstraints.excludeGrapes ?? []) {
    hard.push({
      attribute: 'grape_primary',
      operator: 'exclude',
      value: grape,
      source_phrase: grape,
      confidence: 0.9,
      mapping_version: mv,
    });
  }

  for (const country of searchConstraints.excludeCountries ?? []) {
    hard.push({
      attribute: 'country',
      operator: 'exclude',
      value: country,
      source_phrase: country,
      confidence: 0.88,
      mapping_version: mv,
    });
  }

  for (const region of searchConstraints.excludeRegions ?? []) {
    hard.push({
      attribute: 'region',
      operator: 'exclude',
      value: region,
      source_phrase: region,
      confidence: 0.8,
      mapping_version: mv,
    });
  }

  for (const style of searchConstraints.excludeStyles ?? []) {
    hard.push({
      attribute: 'style',
      operator: 'exclude',
      value: style,
      source_phrase: style,
      confidence: 0.85,
      mapping_version: mv,
    });
  }

  for (const wineType of searchConstraints.excludeWineTypes ?? []) {
    hard.push({
      attribute: 'wine_type',
      operator: 'exclude',
      value: wineType,
      source_phrase: wineType,
      confidence: 0.9,
      mapping_version: mv,
    });
  }

  // KRW price range constraints → soft (price filters are user preferences,
  // not hard requirements — a wine at 51,000₩ should not be excluded when
  // the user asked for "5만원 이하").
  if (searchConstraints.maxPriceKrw !== undefined) {
    soft.push({
      attribute: 'price_usd',
      operator: '<=',
      value: convertKrwToConstraintUsd(searchConstraints.maxPriceKrw),
      source_phrase: `${searchConstraints.maxPriceKrw / KRW_PER_MAN_WON}만원 이하`,
      confidence: 0.85,
      mapping_version: mv,
    });
  }

  if (searchConstraints.minPriceKrw !== undefined) {
    soft.push({
      attribute: 'price_usd',
      operator: '>=',
      value: convertKrwToConstraintUsd(searchConstraints.minPriceKrw),
      source_phrase: `${searchConstraints.minPriceKrw / KRW_PER_MAN_WON}만원 이상`,
      confidence: 0.85,
      mapping_version: mv,
    });
  }

  // Retail-channel hint (편의점/마트/백화점) — emit a soft preference so the
  // ranker can still favour wines in that price band, but NEVER promote it
  // to a hard YQL filter. Lower confidence than numeric to reflect that the
  // user's stated band is approximate. Skipped when a numeric maxPriceKrw is
  // already present (the extractor strips the hint in that case).
  if (
    searchConstraints.maxPriceKrw === undefined
    && searchConstraints.softMaxPriceKrwHint !== undefined
  ) {
    soft.push({
      attribute: 'price_usd',
      operator: '<=',
      value: convertKrwToConstraintUsd(searchConstraints.softMaxPriceKrwHint),
      source_phrase: `약 ${searchConstraints.softMaxPriceKrwHint / KRW_PER_MAN_WON}만원 (retail-channel hint)`,
      confidence: 0.55,
      mapping_version: mv,
    });
  }

  // Vintage range constraints → hard (explicit vintage = hard requirement).
  // When min === max, emit a single `=` constraint (exact year: "2015년산")
  // instead of separate >= and <= — the scorer expects `=` for exact years.
  if (
    searchConstraints.vintageMin !== undefined &&
    searchConstraints.vintageMax !== undefined &&
    searchConstraints.vintageMin === searchConstraints.vintageMax
  ) {
    hard.push({
      attribute: 'vintage_year',
      operator: '=',
      value: searchConstraints.vintageMin,
      source_phrase: `${searchConstraints.vintageMin}년산`,
      confidence: 0.9,
      mapping_version: mv,
    });
  } else {
    if (searchConstraints.vintageMin !== undefined) {
      hard.push({
        attribute: 'vintage_year',
        operator: '>=',
        value: searchConstraints.vintageMin,
        source_phrase: `${searchConstraints.vintageMin}년 이후`,
        confidence: 0.9,
        mapping_version: mv,
      });
    }

    if (searchConstraints.vintageMax !== undefined) {
      hard.push({
        attribute: 'vintage_year',
        operator: '<=',
        value: searchConstraints.vintageMax,
        source_phrase: `${searchConstraints.vintageMax}년 이전`,
        confidence: 0.9,
        mapping_version: mv,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Certification / philosophy signals (vegan / biodynamic / organic).
  //
  // These are wine-domain attributes that the user expects to filter on but
  // were previously absent from the rule-based catalog — queries like
  // "비건 와인 추천" and "바이오다이내믹 와인" produced zero anchors AND
  // zero constraints, which collapsed to `intent=unknown` →
  // router.reject(unsupported_intent) (CLAUDE.md rule 23 false-positive
  // for the unsupported-intent gate). Surface as soft constraints so the
  // analyzer can route them through the single-search lane.
  //
  // Patterns use Unicode-safe boundaries (rule 8): `(?:^|[^\p{L}\p{N}])` /
  // `(?=$|[^\p{L}\p{N}])` instead of `\b` (which is ASCII-only and
  // silently fails on Korean).
  // -------------------------------------------------------------------------

  if (
    /(?:^|[^\p{L}\p{N}])(?:vegan|비건)(?=$|[^\p{L}\p{N}])/iu.test(q)
  ) {
    soft.push({
      attribute: 'certification',
      operator: '=',
      value: 'vegan',
      source_phrase: 'vegan/비건',
      confidence: 0.85,
      mapping_version: mv,
    });
  }

  if (
    /(?:^|[^\p{L}\p{N}])(?:biodynamic|바이오다이내믹|바이오다이나믹)(?=$|[^\p{L}\p{N}])/iu.test(q)
  ) {
    soft.push({
      attribute: 'certification',
      operator: '=',
      value: 'biodynamic',
      source_phrase: 'biodynamic/바이오다이내믹',
      confidence: 0.85,
      mapping_version: mv,
    });
  }

  if (
    /(?:^|[^\p{L}\p{N}])(?:organic|오가닉|유기농)(?=$|[^\p{L}\p{N}])/iu.test(q)
  ) {
    soft.push({
      attribute: 'certification',
      operator: '=',
      value: 'organic',
      source_phrase: 'organic/오가닉/유기농',
      confidence: 0.8,
      mapping_version: mv,
    });
  }

  // -------------------------------------------------------------------------
  // Cellaring / aging intent.
  //
  // "셀러에 넣어둘 만한 와인" / "장기 숙성용" / "long-term cellaring" — user
  // is asking for wines suitable for aging. Surface as a soft `aging_potential`
  // signal so the analyzer routes through single-search rather than rejecting
  // the query as unsupported (CLAUDE.md rule 23 false-positive guard).
  // -------------------------------------------------------------------------

  if (
    /(?:^|[^\p{L}\p{N}])(?:cellaring|cellar[\s-]?worthy|aging[\s-]?potential|장기\s*숙성|숙성\s*가능|셀러|셀러링)(?=$|[^\p{L}\p{N}])/iu.test(q)
    || /셀러에\s*넣/u.test(q)
    || /오래\s*보관/u.test(q)
  ) {
    soft.push({
      attribute: 'aging_potential',
      operator: '=',
      value: 'high',
      source_phrase: 'cellaring / 셀러 / 장기 숙성',
      confidence: 0.75,
      mapping_version: mv,
    });
  }

  return { hard, soft, inferred: [] };
}
