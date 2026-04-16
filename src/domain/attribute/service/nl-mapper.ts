import type { NormalizedConstraint } from '../../shared/types/index.js';
import { throwIfAborted } from '../../shared/cooperative-abort.js';
import type { ConstraintExtractionTrace } from '../model/constraint-extraction-trace.js';
import type { NLMapping } from '../model/nl-mapping.js';
import type { MappingTablePort } from '../port/mapping-table.port.js';

/**
 * Current version of the default mapping table.
 */
const DEFAULT_MAPPING_VERSION = 'v1.0';

/**
 * Default source identifier for built-in mappings.
 */
const DEFAULT_SOURCE = 'builtin_curated';

/** Lower bound for moderate-sweet / elegant-light body curated ranges. */
const DEFAULT_MAPPING_ATTR_MODERATE_MIN = 0.3;
/** Upper bound shared by moderate-sweet and balanced-high body band. */
const DEFAULT_MAPPING_ATTR_MODERATE_MAX = 0.6;
/** Lower bound for "balanced body" phrasing (slightly fuller than elegant). */
const DEFAULT_MAPPING_ATTR_BALANCED_MIN = 0.4;
/** Curated [min,max] attribute range: moderately sweet / elegant light body. */
const DEFAULT_MAPPING_RANGE_MODERATE: readonly [number, number] = [
  DEFAULT_MAPPING_ATTR_MODERATE_MIN,
  DEFAULT_MAPPING_ATTR_MODERATE_MAX,
];
/** Curated [min,max] for "balanced" body phrasing. */
const DEFAULT_MAPPING_RANGE_BALANCED_BODY: readonly [number, number] = [
  DEFAULT_MAPPING_ATTR_BALANCED_MIN,
  DEFAULT_MAPPING_ATTR_MODERATE_MAX,
];

/**
 * Hardcoded default NL-to-attribute mappings for common Korean wine phrases.
 * These are deterministic: same phrase + same version = same output.
 * LLM-generated hard constraints are forbidden per RFC-004.
 */
const DEFAULT_MAPPINGS: ReadonlyMap<string, NLMapping> = new Map<string, NLMapping>([
  [
    '묵직한',
    {
      phrase: '묵직한',
      mappedAttribute: 'body',
      operator: '>=',
      value: 0.7,
      mappingConfidence: 0.95,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '풀바디',
    {
      phrase: '풀바디',
      mappedAttribute: 'body',
      operator: '>=',
      value: 0.7,
      mappingConfidence: 0.95,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '가벼운',
    {
      phrase: '가벼운',
      mappedAttribute: 'body',
      operator: '<=',
      value: 0.3,
      mappingConfidence: 0.95,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '라이트바디',
    {
      phrase: '라이트바디',
      mappedAttribute: 'body',
      operator: '<=',
      value: 0.3,
      mappingConfidence: 0.9,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '달지 않은',
    {
      phrase: '달지 않은',
      mappedAttribute: 'sweetness',
      operator: '<=',
      value: 0.2,
      mappingConfidence: 0.95,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '드라이',
    {
      phrase: '드라이',
      mappedAttribute: 'sweetness',
      operator: '<=',
      value: 0.2,
      mappingConfidence: 0.95,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '달달한',
    {
      phrase: '달달한',
      mappedAttribute: 'sweetness',
      operator: '>=',
      value: 0.5,
      mappingConfidence: 0.9,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '스위트',
    {
      phrase: '스위트',
      mappedAttribute: 'sweetness',
      operator: '>=',
      value: 0.5,
      mappingConfidence: 0.9,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '적당히 달달한',
    {
      phrase: '적당히 달달한',
      mappedAttribute: 'sweetness',
      operator: 'range',
      value: DEFAULT_MAPPING_RANGE_MODERATE,
      mappingConfidence: 0.85,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '선물용',
    {
      phrase: '선물용',
      mappedAttribute: 'occasion',
      operator: 'in',
      value: 'gift',
      mappingConfidence: 0.95,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '입문용',
    {
      phrase: '입문용',
      mappedAttribute: 'price_band',
      operator: '=',
      value: 'budget',
      mappingConfidence: 0.85,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '데일리 와인',
    {
      phrase: '데일리 와인',
      mappedAttribute: 'price_band',
      operator: '=',
      value: 'budget',
      mappingConfidence: 0.8,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '산도 높은',
    {
      phrase: '산도 높은',
      mappedAttribute: 'acidity',
      operator: '>=',
      value: 0.7,
      mappingConfidence: 0.9,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '타닌감',
    {
      phrase: '타닌감',
      mappedAttribute: 'tannin',
      operator: '>=',
      value: 0.6,
      mappingConfidence: 0.85,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '부드러운',
    {
      phrase: '부드러운',
      mappedAttribute: 'tannin',
      operator: '<=',
      value: 0.3,
      mappingConfidence: 0.8,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '파티용',
    {
      phrase: '파티용',
      mappedAttribute: 'occasion',
      operator: 'in',
      value: 'party',
      mappingConfidence: 0.9,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    'drinking window',
    {
      phrase: 'drinking window',
      mappedAttribute: 'drinking_window',
      operator: '>=',
      value: 0,
      mappingConfidence: 0.9,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    'when to drink',
    {
      phrase: 'when to drink',
      mappedAttribute: 'drinking_window',
      operator: '>=',
      value: 0,
      mappingConfidence: 0.9,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '마실 시기',
    {
      phrase: '마실 시기',
      mappedAttribute: 'drinking_window',
      operator: '>=',
      value: 0,
      mappingConfidence: 0.9,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '음용 시기',
    {
      phrase: '음용 시기',
      mappedAttribute: 'drinking_window',
      operator: '>=',
      value: 0,
      mappingConfidence: 0.9,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],

  // ── Korean slang / abbreviations / extended vocabulary ──────────────

  // Price: standalone price-level words
  ['비싼', { phrase: '비싼', mappedAttribute: 'price_band', operator: '=', value: 'luxury', mappingConfidence: 0.8, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['비싸', { phrase: '비싸', mappedAttribute: 'price_band', operator: '=', value: 'luxury', mappingConfidence: 0.8, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['저렴한', { phrase: '저렴한', mappedAttribute: 'price_band', operator: '=', value: 'budget', mappingConfidence: 0.8, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['싼', { phrase: '싼', mappedAttribute: 'price_band', operator: '=', value: 'budget', mappingConfidence: 0.75, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['가성비', { phrase: '가성비', mappedAttribute: 'price_band', operator: '=', value: 'value', mappingConfidence: 0.8, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['고급', { phrase: '고급', mappedAttribute: 'price_band', operator: '=', value: 'premium', mappingConfidence: 0.8, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],

  // Critic score / rating
  ['평점 좋은', { phrase: '평점 좋은', mappedAttribute: 'critic_score', operator: '>=', value: 0.7, mappingConfidence: 0.8, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['평점좋은', { phrase: '평점좋은', mappedAttribute: 'critic_score', operator: '>=', value: 0.7, mappingConfidence: 0.8, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['평점 높은', { phrase: '평점 높은', mappedAttribute: 'critic_score', operator: '>=', value: 0.8, mappingConfidence: 0.85, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['점수 높은', { phrase: '점수 높은', mappedAttribute: 'critic_score', operator: '>=', value: 0.8, mappingConfidence: 0.85, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],

  // Flavor / aroma
  ['과일향', { phrase: '과일향', mappedAttribute: 'flavor_profile', operator: 'in', value: 'fruity', mappingConfidence: 0.85, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['오크향', { phrase: '오크향', mappedAttribute: 'flavor_profile', operator: 'in', value: 'oaky', mappingConfidence: 0.85, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['꽃향', { phrase: '꽃향', mappedAttribute: 'flavor_profile', operator: 'in', value: 'floral', mappingConfidence: 0.85, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['스파이시', { phrase: '스파이시', mappedAttribute: 'flavor_profile', operator: 'in', value: 'spicy', mappingConfidence: 0.85, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['미네랄', { phrase: '미네랄', mappedAttribute: 'flavor_profile', operator: 'in', value: 'mineral', mappingConfidence: 0.8, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],

  // Texture / body
  ['강렬한', { phrase: '강렬한', mappedAttribute: 'body', operator: '>=', value: 0.8, mappingConfidence: 0.8, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['우아한', { phrase: '우아한', mappedAttribute: 'body', operator: 'range', value: DEFAULT_MAPPING_RANGE_MODERATE, mappingConfidence: 0.75, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['균형 잡힌', { phrase: '균형 잡힌', mappedAttribute: 'body', operator: 'range', value: DEFAULT_MAPPING_RANGE_BALANCED_BODY, mappingConfidence: 0.75, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],

  // Occasion extended
  ['기념일', { phrase: '기념일', mappedAttribute: 'occasion', operator: 'in', value: 'anniversary', mappingConfidence: 0.9, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['데이트', { phrase: '데이트', mappedAttribute: 'occasion', operator: 'in', value: 'date_night', mappingConfidence: 0.9, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['혼술', { phrase: '혼술', mappedAttribute: 'occasion', operator: 'in', value: 'solo', mappingConfidence: 0.85, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['집들이', { phrase: '집들이', mappedAttribute: 'occasion', operator: 'in', value: 'housewarming', mappingConfidence: 0.9, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['힐링', { phrase: '힐링', mappedAttribute: 'occasion', operator: 'in', value: 'healing', mappingConfidence: 0.8, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],

  // ── Wine types (Korean + English) ──────────────────────────────────
  // Maps to wine_type attribute via '=' operator for hard Vespa filter.
  ['레드', { phrase: '레드', mappedAttribute: 'wine_type', operator: '=', value: 'red', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['레드 와인', { phrase: '레드 와인', mappedAttribute: 'wine_type', operator: '=', value: 'red', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['레드와인', { phrase: '레드와인', mappedAttribute: 'wine_type', operator: '=', value: 'red', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['red wine', { phrase: 'red wine', mappedAttribute: 'wine_type', operator: '=', value: 'red', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['화이트', { phrase: '화이트', mappedAttribute: 'wine_type', operator: '=', value: 'white', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['화이트 와인', { phrase: '화이트 와인', mappedAttribute: 'wine_type', operator: '=', value: 'white', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['화이트와인', { phrase: '화이트와인', mappedAttribute: 'wine_type', operator: '=', value: 'white', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['white wine', { phrase: 'white wine', mappedAttribute: 'wine_type', operator: '=', value: 'white', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['로제', { phrase: '로제', mappedAttribute: 'wine_type', operator: '=', value: 'rosé', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['로제 와인', { phrase: '로제 와인', mappedAttribute: 'wine_type', operator: '=', value: 'rosé', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['rose wine', { phrase: 'rose wine', mappedAttribute: 'wine_type', operator: '=', value: 'rosé', mappingConfidence: 0.9, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['rosé', { phrase: 'rosé', mappedAttribute: 'wine_type', operator: '=', value: 'rosé', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['스파클링', { phrase: '스파클링', mappedAttribute: 'wine_type', operator: '=', value: 'sparkling', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['샴페인', { phrase: '샴페인', mappedAttribute: 'wine_type', operator: '=', value: 'sparkling', mappingConfidence: 0.9, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['sparkling wine', { phrase: 'sparkling wine', mappedAttribute: 'wine_type', operator: '=', value: 'sparkling', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['champagne', { phrase: 'champagne', mappedAttribute: 'wine_type', operator: '=', value: 'sparkling', mappingConfidence: 0.9, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['내추럴 와인', { phrase: '내추럴 와인', mappedAttribute: 'wine_type', operator: '=', value: 'natural', mappingConfidence: 0.9, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['natural wine', { phrase: 'natural wine', mappedAttribute: 'wine_type', operator: '=', value: 'natural', mappingConfidence: 0.9, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['디저트 와인', { phrase: '디저트 와인', mappedAttribute: 'wine_type', operator: '=', value: 'dessert', mappingConfidence: 0.9, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['dessert wine', { phrase: 'dessert wine', mappedAttribute: 'wine_type', operator: '=', value: 'dessert', mappingConfidence: 0.9, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['주정강화', { phrase: '주정강화', mappedAttribute: 'wine_type', operator: '=', value: 'fortified', mappingConfidence: 0.9, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['포트', { phrase: '포트', mappedAttribute: 'wine_type', operator: '=', value: 'fortified', mappingConfidence: 0.85, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['쉐리', { phrase: '쉐리', mappedAttribute: 'wine_type', operator: '=', value: 'fortified', mappingConfidence: 0.85, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],

  // ── Countries (Korean + English canonical) ────────────────────────
  ['프랑스', { phrase: '프랑스', mappedAttribute: 'country', operator: '=', value: 'France', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['france', { phrase: 'france', mappedAttribute: 'country', operator: '=', value: 'France', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['이탈리아', { phrase: '이탈리아', mappedAttribute: 'country', operator: '=', value: 'Italy', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['italy', { phrase: 'italy', mappedAttribute: 'country', operator: '=', value: 'Italy', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['italian', { phrase: 'italian', mappedAttribute: 'country', operator: '=', value: 'Italy', mappingConfidence: 0.9, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['미국', { phrase: '미국', mappedAttribute: 'country', operator: '=', value: 'United States', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['usa', { phrase: 'usa', mappedAttribute: 'country', operator: '=', value: 'United States', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['california', { phrase: 'california', mappedAttribute: 'country', operator: '=', value: 'United States', mappingConfidence: 0.85, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['칠레', { phrase: '칠레', mappedAttribute: 'country', operator: '=', value: 'Chile', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['chile', { phrase: 'chile', mappedAttribute: 'country', operator: '=', value: 'Chile', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['호주', { phrase: '호주', mappedAttribute: 'country', operator: '=', value: 'Australia', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['australia', { phrase: 'australia', mappedAttribute: 'country', operator: '=', value: 'Australia', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['스페인', { phrase: '스페인', mappedAttribute: 'country', operator: '=', value: 'Spain', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['spain', { phrase: 'spain', mappedAttribute: 'country', operator: '=', value: 'Spain', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['spanish', { phrase: 'spanish', mappedAttribute: 'country', operator: '=', value: 'Spain', mappingConfidence: 0.9, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['독일', { phrase: '독일', mappedAttribute: 'country', operator: '=', value: 'Germany', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['germany', { phrase: 'germany', mappedAttribute: 'country', operator: '=', value: 'Germany', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['뉴질랜드', { phrase: '뉴질랜드', mappedAttribute: 'country', operator: '=', value: 'New Zealand', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['new zealand', { phrase: 'new zealand', mappedAttribute: 'country', operator: '=', value: 'New Zealand', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['아르헨티나', { phrase: '아르헨티나', mappedAttribute: 'country', operator: '=', value: 'Argentina', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['argentina', { phrase: 'argentina', mappedAttribute: 'country', operator: '=', value: 'Argentina', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['포르투갈', { phrase: '포르투갈', mappedAttribute: 'country', operator: '=', value: 'Portugal', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['portugal', { phrase: 'portugal', mappedAttribute: 'country', operator: '=', value: 'Portugal', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['오스트리아', { phrase: '오스트리아', mappedAttribute: 'country', operator: '=', value: 'Austria', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['austria', { phrase: 'austria', mappedAttribute: 'country', operator: '=', value: 'Austria', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],

  // ── Regions (top-20 famous wine regions) ──────────────────────────
  ['보르도', { phrase: '보르도', mappedAttribute: 'region', operator: '=', value: 'Bordeaux', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['bordeaux', { phrase: 'bordeaux', mappedAttribute: 'region', operator: '=', value: 'Bordeaux', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['부르고뉴', { phrase: '부르고뉴', mappedAttribute: 'region', operator: '=', value: 'Burgundy', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['burgundy', { phrase: 'burgundy', mappedAttribute: 'region', operator: '=', value: 'Burgundy', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['나파', { phrase: '나파', mappedAttribute: 'region', operator: '=', value: 'Napa Valley', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['나파 밸리', { phrase: '나파 밸리', mappedAttribute: 'region', operator: '=', value: 'Napa Valley', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['napa', { phrase: 'napa', mappedAttribute: 'region', operator: '=', value: 'Napa Valley', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['napa valley', { phrase: 'napa valley', mappedAttribute: 'region', operator: '=', value: 'Napa Valley', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['토스카나', { phrase: '토스카나', mappedAttribute: 'region', operator: '=', value: 'Tuscany', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['tuscany', { phrase: 'tuscany', mappedAttribute: 'region', operator: '=', value: 'Tuscany', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['피에몬테', { phrase: '피에몬테', mappedAttribute: 'region', operator: '=', value: 'Piemonte', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['piemonte', { phrase: 'piemonte', mappedAttribute: 'region', operator: '=', value: 'Piemonte', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['piedmont', { phrase: 'piedmont', mappedAttribute: 'region', operator: '=', value: 'Piemonte', mappingConfidence: 0.9, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['리오하', { phrase: '리오하', mappedAttribute: 'region', operator: '=', value: 'Rioja', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['rioja', { phrase: 'rioja', mappedAttribute: 'region', operator: '=', value: 'Rioja', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['모젤', { phrase: '모젤', mappedAttribute: 'region', operator: '=', value: 'Mosel', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['mosel', { phrase: 'mosel', mappedAttribute: 'region', operator: '=', value: 'Mosel', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['알자스', { phrase: '알자스', mappedAttribute: 'region', operator: '=', value: 'Alsace', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['alsace', { phrase: 'alsace', mappedAttribute: 'region', operator: '=', value: 'Alsace', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['론', { phrase: '론', mappedAttribute: 'region', operator: '=', value: 'Rhône', mappingConfidence: 0.9, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['rhone', { phrase: 'rhone', mappedAttribute: 'region', operator: '=', value: 'Rhône', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['루아르', { phrase: '루아르', mappedAttribute: 'region', operator: '=', value: 'Loire', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['loire', { phrase: 'loire', mappedAttribute: 'region', operator: '=', value: 'Loire', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['멘도사', { phrase: '멘도사', mappedAttribute: 'region', operator: '=', value: 'Mendoza', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['mendoza', { phrase: 'mendoza', mappedAttribute: 'region', operator: '=', value: 'Mendoza', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['바로사', { phrase: '바로사', mappedAttribute: 'region', operator: '=', value: 'Barossa Valley', mappingConfidence: 0.9, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['barossa', { phrase: 'barossa', mappedAttribute: 'region', operator: '=', value: 'Barossa Valley', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['말버러', { phrase: '말버러', mappedAttribute: 'region', operator: '=', value: 'Marlborough', mappingConfidence: 0.9, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['marlborough', { phrase: 'marlborough', mappedAttribute: 'region', operator: '=', value: 'Marlborough', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],

  // ── Appellations (famous sub-regions) ─────────────────────────────
  ['바롤로', { phrase: '바롤로', mappedAttribute: 'appellation', operator: '=', value: 'Barolo', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['barolo', { phrase: 'barolo', mappedAttribute: 'appellation', operator: '=', value: 'Barolo', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['바르바레스코', { phrase: '바르바레스코', mappedAttribute: 'appellation', operator: '=', value: 'Barbaresco', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['barbaresco', { phrase: 'barbaresco', mappedAttribute: 'appellation', operator: '=', value: 'Barbaresco', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['브루넬로', { phrase: '브루넬로', mappedAttribute: 'appellation', operator: '=', value: 'Brunello di Montalcino', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['brunello', { phrase: 'brunello', mappedAttribute: 'appellation', operator: '=', value: 'Brunello di Montalcino', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['키안티', { phrase: '키안티', mappedAttribute: 'appellation', operator: '=', value: 'Chianti', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['chianti', { phrase: 'chianti', mappedAttribute: 'appellation', operator: '=', value: 'Chianti', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['포이약', { phrase: '포이약', mappedAttribute: 'appellation', operator: '=', value: 'Pauillac', mappingConfidence: 0.9, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['pauillac', { phrase: 'pauillac', mappedAttribute: 'appellation', operator: '=', value: 'Pauillac', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['마고', { phrase: '마고', mappedAttribute: 'appellation', operator: '=', value: 'Margaux', mappingConfidence: 0.9, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['margaux', { phrase: 'margaux', mappedAttribute: 'appellation', operator: '=', value: 'Margaux', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['생테밀리옹', { phrase: '생테밀리옹', mappedAttribute: 'appellation', operator: '=', value: 'Saint-Émilion', mappingConfidence: 0.9, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['saint-emilion', { phrase: 'saint-emilion', mappedAttribute: 'appellation', operator: '=', value: 'Saint-Émilion', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],

  // ── Grape varieties (top-15) ──────────────────────────────────────
  ['카베르네', { phrase: '카베르네', mappedAttribute: 'grape_primary', operator: '=', value: 'Cabernet Sauvignon', mappingConfidence: 0.9, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['카베르네 소비뇽', { phrase: '카베르네 소비뇽', mappedAttribute: 'grape_primary', operator: '=', value: 'Cabernet Sauvignon', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['cabernet', { phrase: 'cabernet', mappedAttribute: 'grape_primary', operator: '=', value: 'Cabernet Sauvignon', mappingConfidence: 0.9, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['cabernet sauvignon', { phrase: 'cabernet sauvignon', mappedAttribute: 'grape_primary', operator: '=', value: 'Cabernet Sauvignon', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['까쇼', { phrase: '까쇼', mappedAttribute: 'grape_primary', operator: '=', value: 'Cabernet Sauvignon', mappingConfidence: 0.85, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['메를로', { phrase: '메를로', mappedAttribute: 'grape_primary', operator: '=', value: 'Merlot', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['merlot', { phrase: 'merlot', mappedAttribute: 'grape_primary', operator: '=', value: 'Merlot', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['피노', { phrase: '피노', mappedAttribute: 'grape_primary', operator: '=', value: 'Pinot Noir', mappingConfidence: 0.85, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['피노 누아르', { phrase: '피노 누아르', mappedAttribute: 'grape_primary', operator: '=', value: 'Pinot Noir', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['피노누아', { phrase: '피노누아', mappedAttribute: 'grape_primary', operator: '=', value: 'Pinot Noir', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['pinot noir', { phrase: 'pinot noir', mappedAttribute: 'grape_primary', operator: '=', value: 'Pinot Noir', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['샤르도네', { phrase: '샤르도네', mappedAttribute: 'grape_primary', operator: '=', value: 'Chardonnay', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['chardonnay', { phrase: 'chardonnay', mappedAttribute: 'grape_primary', operator: '=', value: 'Chardonnay', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['소비뇽 블랑', { phrase: '소비뇽 블랑', mappedAttribute: 'grape_primary', operator: '=', value: 'Sauvignon Blanc', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['sauvignon blanc', { phrase: 'sauvignon blanc', mappedAttribute: 'grape_primary', operator: '=', value: 'Sauvignon Blanc', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['리슬링', { phrase: '리슬링', mappedAttribute: 'grape_primary', operator: '=', value: 'Riesling', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['riesling', { phrase: 'riesling', mappedAttribute: 'grape_primary', operator: '=', value: 'Riesling', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['산지오베제', { phrase: '산지오베제', mappedAttribute: 'grape_primary', operator: '=', value: 'Sangiovese', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['sangiovese', { phrase: 'sangiovese', mappedAttribute: 'grape_primary', operator: '=', value: 'Sangiovese', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['네비올로', { phrase: '네비올로', mappedAttribute: 'grape_primary', operator: '=', value: 'Nebbiolo', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['nebbiolo', { phrase: 'nebbiolo', mappedAttribute: 'grape_primary', operator: '=', value: 'Nebbiolo', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['시라', { phrase: '시라', mappedAttribute: 'grape_primary', operator: '=', value: 'Syrah', mappingConfidence: 0.9, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['쉬라즈', { phrase: '쉬라즈', mappedAttribute: 'grape_primary', operator: '=', value: 'Syrah', mappingConfidence: 0.9, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['syrah', { phrase: 'syrah', mappedAttribute: 'grape_primary', operator: '=', value: 'Syrah', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['shiraz', { phrase: 'shiraz', mappedAttribute: 'grape_primary', operator: '=', value: 'Syrah', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['말벡', { phrase: '말벡', mappedAttribute: 'grape_primary', operator: '=', value: 'Malbec', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['malbec', { phrase: 'malbec', mappedAttribute: 'grape_primary', operator: '=', value: 'Malbec', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['템프라니요', { phrase: '템프라니요', mappedAttribute: 'grape_primary', operator: '=', value: 'Tempranillo', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['tempranillo', { phrase: 'tempranillo', mappedAttribute: 'grape_primary', operator: '=', value: 'Tempranillo', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['진판델', { phrase: '진판델', mappedAttribute: 'grape_primary', operator: '=', value: 'Zinfandel', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['zinfandel', { phrase: 'zinfandel', mappedAttribute: 'grape_primary', operator: '=', value: 'Zinfandel', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['게뷔르츠트라미너', { phrase: '게뷔르츠트라미너', mappedAttribute: 'grape_primary', operator: '=', value: 'Gewürztraminer', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['gewurztraminer', { phrase: 'gewurztraminer', mappedAttribute: 'grape_primary', operator: '=', value: 'Gewürztraminer', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['gewürztraminer', { phrase: 'gewürztraminer', mappedAttribute: 'grape_primary', operator: '=', value: 'Gewürztraminer', mappingConfidence: 0.95, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
]);

type ResolverCompatibleAttribute =
  | 'wine_type'
  | 'country'
  | 'region'
  | 'appellation'
  | 'grape_primary';

interface DefaultEntityAliasMapping {
  readonly phrase: string;
  readonly mappedAttribute: ResolverCompatibleAttribute;
  readonly canonicalValue: string;
  readonly mappingConfidence: number;
}

/**
 * Returns resolver-compatible entity aliases sourced from DEFAULT_MAPPINGS.
 *
 * This keeps NL mapper phrase coverage and Entity Resolver coverage in sync so
 * new entity aliases are not accidentally added to one layer only.
 */
export function listDefaultEntityAliasMappings(): readonly DefaultEntityAliasMapping[] {
  const aliases: DefaultEntityAliasMapping[] = [];
  for (const mapping of DEFAULT_MAPPINGS.values()) {
    if (mapping.operator !== '=' || typeof mapping.value !== 'string') continue;
    if (!isResolverCompatibleAttribute(mapping.mappedAttribute)) continue;
    aliases.push({
      phrase: mapping.phrase,
      mappedAttribute: mapping.mappedAttribute,
      canonicalValue: mapping.value,
      mappingConfidence: mapping.mappingConfidence,
    });
  }
  return aliases;
}

function isResolverCompatibleAttribute(value: string): value is ResolverCompatibleAttribute {
  return value === 'wine_type'
    || value === 'country'
    || value === 'region'
    || value === 'appellation'
    || value === 'grape_primary';
}

/**
 * Converts an {@link NLMapping} to a {@link NormalizedConstraint}.
 */
export function toNormalizedConstraint(mapping: NLMapping): NormalizedConstraint {
  let constraintValue: NormalizedConstraint['value'];

  if (mapping.operator === 'range' && Array.isArray(mapping.value)) {
    const [min, max] = mapping.value as readonly [number, number];
    constraintValue = { min, max };
  } else if (mapping.operator === 'in' && typeof mapping.value === 'string') {
    constraintValue = [mapping.value];
  } else {
    constraintValue = mapping.value as string | number;
  }

  return {
    attribute: mapping.mappedAttribute,
    operator: mapping.operator,
    value: constraintValue,
    source_phrase: mapping.phrase,
    confidence: mapping.mappingConfidence,
    mapping_version: mapping.mappingVersion,
  };
}

/** Result of {@link NLMapper.mapConstraints} — constraints plus optional extraction provenance. */
export interface MapConstraintsResult {
  readonly constraints: NormalizedConstraint[];
  /** Request-scoped extraction provenance (observability / QueryPlanV2.constraintExtraction shape). */
  readonly constraintExtraction?: ConstraintExtractionTrace | undefined;
}

/** Optional controls for {@link NLMapper.mapConstraints} (cancellation, future flags). */
export interface MapConstraintsOptions {
  readonly abortSignal?: AbortSignal | undefined;
}

/**
 * Maps natural-language phrases to structured attribute constraints.
 * Implements RFC-004 §4.
 *
 * All mappings are deterministic. Same input + same version = same output.
 * Falls back to built-in default mappings when the repository has no match.
 */
export class NLMapper {
  constructor(private readonly mappingTable: MappingTablePort) {}

  /**
   * Maps a single natural-language phrase to a structured NLMapping.
   *
   * Resolution order:
   * 1. Query the mapping table repository.
   * 2. Fall back to built-in default mappings.
   *
   * @param phrase - The natural-language phrase (e.g. "묵직한").
   * @returns The mapping, or `null` if no mapping exists.
   */
  async mapPhrase(phrase: string): Promise<NLMapping | null> {
    const trimmed = phrase.trim();

    // 1. Check the repository (with lowercase normalisation so "Bordeaux" and
    // "bordeaux" always hit the same mapping row).
    const repoMapping = await this.mappingTable.findMapping(trimmed.toLowerCase());
    if (repoMapping !== null) {
      return repoMapping;
    }

    // 2. Fall back to built-in defaults (all DEFAULT_MAPPINGS keys are lowercase).
    const builtIn = DEFAULT_MAPPINGS.get(trimmed.toLowerCase());
    return builtIn ?? null;
  }

  /**
   * Maps multiple natural-language phrases to normalized constraints.
   * Phrases that do not match any mapping are silently skipped.
   *
   * @param phrases - Array of natural-language phrases.
   * @param options - Optional cancellation — when {@link MapConstraintsOptions.abortSignal}
   *   aborts, throws an `AbortError`-named {@link Error} (checked before each phrase).
   * @returns Constraints and a rule-table extraction trace (no LLM fields).
   */
  async mapConstraints(
    phrases: readonly string[],
    options?: MapConstraintsOptions,
  ): Promise<MapConstraintsResult> {
    throwIfAborted(options?.abortSignal, 'Constraint mapping aborted');

    const results: NormalizedConstraint[] = [];
    const seenPhrases = new Set<string>();

    for (const phrase of phrases) {
      throwIfAborted(options?.abortSignal, 'Constraint mapping aborted');
      const normalizedPhrase = phrase.trim();
      // Dedup by lowercase key so "Bordeaux" and "bordeaux" don't produce
      // duplicate constraints. mapPhrase also normalises to lowercase internally.
      const dedupKey = normalizedPhrase.toLowerCase();
      if (normalizedPhrase.length === 0 || seenPhrases.has(dedupKey)) {
        continue;
      }
      seenPhrases.add(dedupKey);
      const mapping = await this.mapPhrase(normalizedPhrase);
      if (mapping !== null) {
        results.push(toNormalizedConstraint(mapping));
      }
    }

    const source: ConstraintExtractionTrace['source'] =
      results.length > 0 ? 'rule_only' : 'fallback';
    const constraintExtraction: ConstraintExtractionTrace = {
      candidatePhraseCount: phrases.length,
      ruleTableHitCount: results.length,
      llmHitCount: 0,
      llmSkippedCount: 0,
      fallbackTriggered: results.length === 0,
      source,
      llmLatencyMs: null,
      phraseCacheHits: 0,
      phraseCacheNegativeSkipped: 0,
      phraseCacheMisses: 0,
      missedPhrases: [...seenPhrases].filter(
        (p) => !results.some((r) => r.source_phrase === p),
      ),
    };

    return { constraints: results, constraintExtraction };
  }
}
