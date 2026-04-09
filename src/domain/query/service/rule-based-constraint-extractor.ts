import type { ConstraintBundle } from '../../shared/types/index.js';
import {
  KRW_PER_MAN_WON,
} from '../../shared/constants.js';
import { WINE_TYPE_RULES } from '../model/wine-type-patterns.js';
import {
  extractSearchConstraints,
  krwToUsd,
} from './search-constraint-extractor.js';

/** Version tag applied to all rule-based constraints (RFC-004, RFC-005). */
export const RULE_BASED_CONSTRAINT_MAPPING_VERSION = 'rule-based-v1.0';

const DECIMAL_RADIX = 10;
/** Rough KRW→USD factor when user says "만원" without explicit FX context.
 *  Fixed at 7 for deterministic constraint extraction (not live FX).
 *  1만원 ≈ $7 at KRW/USD ≈ 1,400 — intentionally rounded for soft banding. */
const KRW_MANWON_TO_USD_HEURISTIC = 7;
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
  const q = normalizedQuery;
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
      break;
    }
  }

  const priceUnder =
    // (?<!\p{L})(?<!\p{N}) = two separate lookbehinds ("not preceded by letter" AND "not preceded by digit").
    // (?<!\p{L})(?<!\p{N}) was wrong: AND-sequence checks for letter THEN digit (2-char seq), never matches anything.
    /(?<!\p{L})(?<!\p{N})under\s+\$?(\d+)(?!\p{L})(?!\p{N})/iu.exec(q) ??
    /(\d+)\s*(?:달러|dollar)\s*이하/iu.exec(q) ??
    /(\d+)\s*만원\s*(?:이하|미만|대)/iu.exec(q);
  if (priceUnder?.[1] !== undefined) {
    const priceValue = parseInt(priceUnder[1], DECIMAL_RADIX);
    // Guard: parseInt can return NaN on malformed capture group (edge case with regex backtracking).
    // NaN would propagate into band comparison (always false) and corrupt soft constraints. (CLAUDE.md rule 28)
    if (!Number.isFinite(priceValue)) return { hard, soft, inferred: [] };
    const usd = /만원/u.test(q) ? priceValue * KRW_MANWON_TO_USD_HEURISTIC : priceValue;
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
  }

  // Standalone price-level keywords (no numeric amount)
  if (!priceUnder && /(?:비싼|비싸|고급|럭셔리|프리미엄)/u.test(q)) {
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

  // Critic score / rating keywords
  if (/(?:평점|점수|별점|리뷰)\s*(?:좋은|높은|훌륭|최고)/u.test(q)) {
    soft.push({
      attribute: 'critic_score',
      operator: '>=',
      value: 0.7,
      source_phrase: '평점 좋은',
      confidence: 0.75,
      mapping_version: mv,
    });
  }

  if (/(?:^|[^\p{L}\p{N}])(?:full[\s-]?body|풀바디|bold|heavy|묵직)(?=$|[^\p{L}\p{N}])/iu.test(q)) {
    soft.push({
      attribute: 'body',
      operator: '=',
      value: 'full',
      source_phrase: 'full-body',
      confidence: 0.75,
      mapping_version: mv,
    });
  } else if (/(?:^|[^\p{L}\p{N}])(?:light[\s-]?body|라이트바디|light wine|가벼운|가볍)(?=$|[^\p{L}\p{N}])/iu.test(q)) {
    soft.push({
      attribute: 'body',
      operator: '=',
      value: 'light',
      source_phrase: 'light-body',
      confidence: 0.75,
      mapping_version: mv,
    });
  }

  // "low tannin" intent
  if (/(?:타닌\s*약(?:한|하게)?|타닌감?\s*약(?:한|하게)?|부드러(?:운|움|운편)?)/u.test(q)) {
    soft.push({
      attribute: 'tannin',
      operator: '<=',
      value: 0.4,
      source_phrase: '타닌 약',
      confidence: 0.8,
      mapping_version: mv,
    });
  }

  // "fruity" intensity intent
  if (/(?:과일향\s*풍부(?:한|하게)?|과일향\s*진하(?:다|한|게)?|fruity)/iu.test(q)) {
    soft.push({
      attribute: 'fruit_intensity',
      operator: '>=',
      value: 0.6,
      source_phrase: '과일향 풍부',
      confidence: 0.78,
      mapping_version: mv,
    });
  }

  if (/(?:^|[^\p{L}\p{N}])(?:dry wine|드라이|brut|extra[\s-]?brut)(?=$|[^\p{L}\p{N}])/iu.test(q)) {
    soft.push({
      attribute: 'sweetness',
      operator: '=',
      value: 'dry',
      source_phrase: 'dry',
      confidence: 0.8,
      mapping_version: mv,
    });
  } else if (/(?:^|[^\p{L}\p{N}])(?:sweet wine|달콤한|스위트|demi[\s-]?sec|semi[\s-]?sweet)(?=$|[^\p{L}\p{N}])/iu.test(q)) {
    soft.push({
      attribute: 'sweetness',
      operator: '=',
      value: 'sweet',
      source_phrase: 'sweet',
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
  const searchConstraints = extractSearchConstraints(q);

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

  // KRW price range constraints → soft (price filters are user preferences,
  // not hard requirements — a wine at 51,000₩ should not be excluded when
  // the user asked for "5만원 이하").
  if (searchConstraints.maxPriceKrw !== undefined) {
    const maxUsd = krwToUsd(searchConstraints.maxPriceKrw);
    soft.push({
      attribute: 'max_price_krw',
      operator: '<=',
      value: searchConstraints.maxPriceKrw,
      source_phrase: `${searchConstraints.maxPriceKrw / KRW_PER_MAN_WON}만원 이하`,
      confidence: 0.85,
      mapping_version: mv,
    });
    soft.push({
      attribute: 'price_usd',
      operator: '<=',
      value: maxUsd,
      source_phrase: `${searchConstraints.maxPriceKrw / KRW_PER_MAN_WON}만원 이하`,
      confidence: 0.82,
      mapping_version: mv,
    });
  }

  if (searchConstraints.minPriceKrw !== undefined) {
    const minUsd = krwToUsd(searchConstraints.minPriceKrw);
    soft.push({
      attribute: 'min_price_krw',
      operator: '>=',
      value: searchConstraints.minPriceKrw,
      source_phrase: `${searchConstraints.minPriceKrw / KRW_PER_MAN_WON}만원 이상`,
      confidence: 0.85,
      mapping_version: mv,
    });
    soft.push({
      attribute: 'price_usd',
      operator: '>=',
      value: minUsd,
      source_phrase: `${searchConstraints.minPriceKrw / KRW_PER_MAN_WON}만원 이상`,
      confidence: 0.82,
      mapping_version: mv,
    });
  }

  // Vintage range constraints → hard (explicit vintage = hard requirement).
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

  return { hard, soft, inferred: [] };
}
