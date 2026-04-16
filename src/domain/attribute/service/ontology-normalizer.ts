/**
 * Domain Ontology Normalizer
 *
 * A single, authoritative service that maps raw phrases or tokens to canonical
 * ontology axes + values before retrieval.  Consolidates grape, region, style,
 * body, sweetness, acidity, tannin, pairing, occasion, price-band,
 * producer-prestige, and certification signals.
 *
 * Implements T2.2 (domain ontology normalization pipeline).
 */

// ── Public types ─────────────────────────────────────────────────────────────

type OntologyAxis =
  | 'grape'
  | 'region'
  | 'style'
  | 'body'
  | 'sweetness'
  | 'acidity'
  | 'tannin'
  | 'pairing'
  | 'occasion'
  | 'price_band'
  | 'producer_prestige'
  | 'certification';

interface OntologyNormalization {
  readonly axis: OntologyAxis;
  /** Underscore-separated canonical value, e.g. 'cabernet_sauvignon', 'full_body'. */
  readonly canonicalValue: string;
  /** Human-readable display value, e.g. 'Cabernet Sauvignon', 'Bordeaux'. */
  readonly displayValue: string;
  /** Confidence in the normalization: 1.0 for exact matches, < 1.0 otherwise. */
  readonly confidence: number;
  readonly source: 'exact' | 'fuzzy' | 'rule' | 'nlp';
}

export const OCCASION_ONTOLOGY_VERSION = 'occasion-v1-20260414' as const;

export const GIFT_SUITABILITY_VERSION = 'gift-suitability-v1-20260416' as const;
export const BEGINNER_SUITABILITY_VERSION = 'beginner-suitability-v1-20260416' as const;

export const OCCASION_ONTOLOGY_VALUES = [
  'gift',
  'party',
  'celebration',
  'anniversary',
  'wedding',
  'date_night',
  'housewarming',
  'birthday',
  'solo',
  'special_occasion',
  'healing',
] as const;

// ── Internal map entry type ───────────────────────────────────────────────────

interface MappingEntry {
  readonly axis: OntologyAxis;
  readonly canonicalValue: string;
  readonly displayValue: string;
}

// ── Built-in exact lookup table ───────────────────────────────────────────────
//
// Keys are lowercased, trimmed input phrases.
// Values are canonical ontology entries.

const EXACT_MAPPINGS: ReadonlyMap<string, MappingEntry> = new Map<string, MappingEntry>([
  // ── Grapes: English ─────────────────────────────────────────────────────────
  ['cabernet sauvignon', { axis: 'grape', canonicalValue: 'cabernet_sauvignon', displayValue: 'Cabernet Sauvignon' }],
  ['cabernet', { axis: 'grape', canonicalValue: 'cabernet_sauvignon', displayValue: 'Cabernet Sauvignon' }],
  ['cab sauv', { axis: 'grape', canonicalValue: 'cabernet_sauvignon', displayValue: 'Cabernet Sauvignon' }],
  ['cab', { axis: 'grape', canonicalValue: 'cabernet_sauvignon', displayValue: 'Cabernet Sauvignon' }],
  ['merlot', { axis: 'grape', canonicalValue: 'merlot', displayValue: 'Merlot' }],
  ['pinot noir', { axis: 'grape', canonicalValue: 'pinot_noir', displayValue: 'Pinot Noir' }],
  ['pinot', { axis: 'grape', canonicalValue: 'pinot_noir', displayValue: 'Pinot Noir' }],
  ['chardonnay', { axis: 'grape', canonicalValue: 'chardonnay', displayValue: 'Chardonnay' }],
  ['sauvignon blanc', { axis: 'grape', canonicalValue: 'sauvignon_blanc', displayValue: 'Sauvignon Blanc' }],
  ['sauv blanc', { axis: 'grape', canonicalValue: 'sauvignon_blanc', displayValue: 'Sauvignon Blanc' }],
  ['riesling', { axis: 'grape', canonicalValue: 'riesling', displayValue: 'Riesling' }],
  ['syrah', { axis: 'grape', canonicalValue: 'syrah', displayValue: 'Syrah' }],
  ['shiraz', { axis: 'grape', canonicalValue: 'syrah', displayValue: 'Syrah' }],
  ['sangiovese', { axis: 'grape', canonicalValue: 'sangiovese', displayValue: 'Sangiovese' }],
  ['tempranillo', { axis: 'grape', canonicalValue: 'tempranillo', displayValue: 'Tempranillo' }],
  ['grenache', { axis: 'grape', canonicalValue: 'grenache', displayValue: 'Grenache' }],
  ['garnacha', { axis: 'grape', canonicalValue: 'grenache', displayValue: 'Grenache' }],
  ['nebbiolo', { axis: 'grape', canonicalValue: 'nebbiolo', displayValue: 'Nebbiolo' }],
  ['moscato', { axis: 'grape', canonicalValue: 'moscato', displayValue: 'Moscato' }],
  ['muscat', { axis: 'grape', canonicalValue: 'moscato', displayValue: 'Moscato' }],
  ['gewurztraminer', { axis: 'grape', canonicalValue: 'gewurztraminer', displayValue: 'Gewurztraminer' }],
  ['gewürztraminer', { axis: 'grape', canonicalValue: 'gewurztraminer', displayValue: 'Gewurztraminer' }],
  ['viognier', { axis: 'grape', canonicalValue: 'viognier', displayValue: 'Viognier' }],
  ['malbec', { axis: 'grape', canonicalValue: 'malbec', displayValue: 'Malbec' }],
  ['zinfandel', { axis: 'grape', canonicalValue: 'zinfandel', displayValue: 'Zinfandel' }],
  ['zin', { axis: 'grape', canonicalValue: 'zinfandel', displayValue: 'Zinfandel' }],
  ['primitivo', { axis: 'grape', canonicalValue: 'zinfandel', displayValue: 'Zinfandel' }],
  ['montepulciano', { axis: 'grape', canonicalValue: 'montepulciano', displayValue: 'Montepulciano' }],
  ['barbera', { axis: 'grape', canonicalValue: 'barbera', displayValue: 'Barbera' }],
  ['gruner veltliner', { axis: 'grape', canonicalValue: 'gruner_veltliner', displayValue: 'Grüner Veltliner' }],
  ['grüner veltliner', { axis: 'grape', canonicalValue: 'gruner_veltliner', displayValue: 'Grüner Veltliner' }],
  ['chenin blanc', { axis: 'grape', canonicalValue: 'chenin_blanc', displayValue: 'Chenin Blanc' }],
  ['pinot gris', { axis: 'grape', canonicalValue: 'pinot_gris', displayValue: 'Pinot Gris' }],
  ['pinot grigio', { axis: 'grape', canonicalValue: 'pinot_gris', displayValue: 'Pinot Gris' }],
  ['pinot blanc', { axis: 'grape', canonicalValue: 'pinot_blanc', displayValue: 'Pinot Blanc' }],
  ['torrontes', { axis: 'grape', canonicalValue: 'torrontes', displayValue: 'Torrontés' }],
  ['torrontés', { axis: 'grape', canonicalValue: 'torrontes', displayValue: 'Torrontés' }],

  // ── Grapes: Korean ──────────────────────────────────────────────────────────
  ['카베르네 소비뇽', { axis: 'grape', canonicalValue: 'cabernet_sauvignon', displayValue: 'Cabernet Sauvignon' }],
  ['카베르네소비뇽', { axis: 'grape', canonicalValue: 'cabernet_sauvignon', displayValue: 'Cabernet Sauvignon' }],
  ['카베르네', { axis: 'grape', canonicalValue: 'cabernet_sauvignon', displayValue: 'Cabernet Sauvignon' }],
  ['메를로', { axis: 'grape', canonicalValue: 'merlot', displayValue: 'Merlot' }],
  ['피노 누아르', { axis: 'grape', canonicalValue: 'pinot_noir', displayValue: 'Pinot Noir' }],
  ['피노누아르', { axis: 'grape', canonicalValue: 'pinot_noir', displayValue: 'Pinot Noir' }],
  ['피노 누아', { axis: 'grape', canonicalValue: 'pinot_noir', displayValue: 'Pinot Noir' }],
  ['샤르도네', { axis: 'grape', canonicalValue: 'chardonnay', displayValue: 'Chardonnay' }],
  ['소비뇽 블랑', { axis: 'grape', canonicalValue: 'sauvignon_blanc', displayValue: 'Sauvignon Blanc' }],
  ['소비뇽블랑', { axis: 'grape', canonicalValue: 'sauvignon_blanc', displayValue: 'Sauvignon Blanc' }],
  ['리슬링', { axis: 'grape', canonicalValue: 'riesling', displayValue: 'Riesling' }],
  ['시라', { axis: 'grape', canonicalValue: 'syrah', displayValue: 'Syrah' }],
  ['쉬라즈', { axis: 'grape', canonicalValue: 'syrah', displayValue: 'Syrah' }],
  ['산지오베제', { axis: 'grape', canonicalValue: 'sangiovese', displayValue: 'Sangiovese' }],
  ['템프라니요', { axis: 'grape', canonicalValue: 'tempranillo', displayValue: 'Tempranillo' }],
  ['그르나슈', { axis: 'grape', canonicalValue: 'grenache', displayValue: 'Grenache' }],
  ['네비올로', { axis: 'grape', canonicalValue: 'nebbiolo', displayValue: 'Nebbiolo' }],
  ['모스카토', { axis: 'grape', canonicalValue: 'moscato', displayValue: 'Moscato' }],
  ['게뷔르츠트라미너', { axis: 'grape', canonicalValue: 'gewurztraminer', displayValue: 'Gewurztraminer' }],
  ['말벡', { axis: 'grape', canonicalValue: 'malbec', displayValue: 'Malbec' }],
  ['진판델', { axis: 'grape', canonicalValue: 'zinfandel', displayValue: 'Zinfandel' }],

  // ── Regions: English ────────────────────────────────────────────────────────
  ['bordeaux', { axis: 'region', canonicalValue: 'bordeaux', displayValue: 'Bordeaux' }],
  ['burgundy', { axis: 'region', canonicalValue: 'burgundy', displayValue: 'Burgundy' }],
  ['bourgogne', { axis: 'region', canonicalValue: 'burgundy', displayValue: 'Burgundy' }],
  ['champagne', { axis: 'region', canonicalValue: 'champagne', displayValue: 'Champagne' }],
  ['napa valley', { axis: 'region', canonicalValue: 'napa_valley', displayValue: 'Napa Valley' }],
  ['napa', { axis: 'region', canonicalValue: 'napa_valley', displayValue: 'Napa Valley' }],
  ['sonoma', { axis: 'region', canonicalValue: 'sonoma', displayValue: 'Sonoma' }],
  ['tuscany', { axis: 'region', canonicalValue: 'tuscany', displayValue: 'Tuscany' }],
  ['toscana', { axis: 'region', canonicalValue: 'tuscany', displayValue: 'Tuscany' }],
  ['rioja', { axis: 'region', canonicalValue: 'rioja', displayValue: 'Rioja' }],
  ['barossa valley', { axis: 'region', canonicalValue: 'barossa_valley', displayValue: 'Barossa Valley' }],
  ['barossa', { axis: 'region', canonicalValue: 'barossa_valley', displayValue: 'Barossa Valley' }],
  ['marlborough', { axis: 'region', canonicalValue: 'marlborough', displayValue: 'Marlborough' }],
  ['mendoza', { axis: 'region', canonicalValue: 'mendoza', displayValue: 'Mendoza' }],
  ['rhone', { axis: 'region', canonicalValue: 'rhone', displayValue: 'Rhône' }],
  ['rhône', { axis: 'region', canonicalValue: 'rhone', displayValue: 'Rhône' }],
  ['alsace', { axis: 'region', canonicalValue: 'alsace', displayValue: 'Alsace' }],
  ['mosel', { axis: 'region', canonicalValue: 'mosel', displayValue: 'Mosel' }],
  ['barolo', { axis: 'region', canonicalValue: 'barolo', displayValue: 'Barolo' }],
  ['beaujolais', { axis: 'region', canonicalValue: 'beaujolais', displayValue: 'Beaujolais' }],
  ['sauternes', { axis: 'region', canonicalValue: 'sauternes', displayValue: 'Sauternes' }],
  ['priorat', { axis: 'region', canonicalValue: 'priorat', displayValue: 'Priorat' }],
  ['chablis', { axis: 'region', canonicalValue: 'chablis', displayValue: 'Chablis' }],
  ['loire', { axis: 'region', canonicalValue: 'loire', displayValue: 'Loire Valley' }],
  ['loire valley', { axis: 'region', canonicalValue: 'loire', displayValue: 'Loire Valley' }],

  // ── Regions: Korean ─────────────────────────────────────────────────────────
  ['보르도', { axis: 'region', canonicalValue: 'bordeaux', displayValue: 'Bordeaux' }],
  ['부르고뉴', { axis: 'region', canonicalValue: 'burgundy', displayValue: 'Burgundy' }],
  ['샹파뉴', { axis: 'region', canonicalValue: 'champagne', displayValue: 'Champagne' }],
  ['나파 밸리', { axis: 'region', canonicalValue: 'napa_valley', displayValue: 'Napa Valley' }],
  ['나파밸리', { axis: 'region', canonicalValue: 'napa_valley', displayValue: 'Napa Valley' }],
  ['나파', { axis: 'region', canonicalValue: 'napa_valley', displayValue: 'Napa Valley' }],
  ['토스카나', { axis: 'region', canonicalValue: 'tuscany', displayValue: 'Tuscany' }],
  ['리오하', { axis: 'region', canonicalValue: 'rioja', displayValue: 'Rioja' }],
  ['바로사 밸리', { axis: 'region', canonicalValue: 'barossa_valley', displayValue: 'Barossa Valley' }],
  ['바로사밸리', { axis: 'region', canonicalValue: 'barossa_valley', displayValue: 'Barossa Valley' }],
  ['말버러', { axis: 'region', canonicalValue: 'marlborough', displayValue: 'Marlborough' }],
  ['멘도자', { axis: 'region', canonicalValue: 'mendoza', displayValue: 'Mendoza' }],
  ['모젤', { axis: 'region', canonicalValue: 'mosel', displayValue: 'Mosel' }],
  ['바롤로', { axis: 'region', canonicalValue: 'barolo', displayValue: 'Barolo' }],
  ['보졸레', { axis: 'region', canonicalValue: 'beaujolais', displayValue: 'Beaujolais' }],
  ['소테른', { axis: 'region', canonicalValue: 'sauternes', displayValue: 'Sauternes' }],
  ['알자스', { axis: 'region', canonicalValue: 'alsace', displayValue: 'Alsace' }],
  ['론', { axis: 'region', canonicalValue: 'rhone', displayValue: 'Rhône' }],

  // ── Body ────────────────────────────────────────────────────────────────────
  ['light body', { axis: 'body', canonicalValue: 'light_body', displayValue: 'Light Body' }],
  ['light-body', { axis: 'body', canonicalValue: 'light_body', displayValue: 'Light Body' }],
  ['light', { axis: 'body', canonicalValue: 'light_body', displayValue: 'Light Body' }],
  ['라이트바디', { axis: 'body', canonicalValue: 'light_body', displayValue: 'Light Body' }],
  ['가벼운', { axis: 'body', canonicalValue: 'light_body', displayValue: 'Light Body' }],
  ['medium body', { axis: 'body', canonicalValue: 'medium_body', displayValue: 'Medium Body' }],
  ['medium-body', { axis: 'body', canonicalValue: 'medium_body', displayValue: 'Medium Body' }],
  ['미디엄바디', { axis: 'body', canonicalValue: 'medium_body', displayValue: 'Medium Body' }],
  ['full body', { axis: 'body', canonicalValue: 'full_body', displayValue: 'Full Body' }],
  ['full-body', { axis: 'body', canonicalValue: 'full_body', displayValue: 'Full Body' }],
  ['full bodied', { axis: 'body', canonicalValue: 'full_body', displayValue: 'Full Body' }],
  ['풀바디', { axis: 'body', canonicalValue: 'full_body', displayValue: 'Full Body' }],
  ['묵직한', { axis: 'body', canonicalValue: 'full_body', displayValue: 'Full Body' }],
  ['bold', { axis: 'body', canonicalValue: 'full_body', displayValue: 'Full Body' }],

  // ── Sweetness / Style ───────────────────────────────────────────────────────
  ['dry', { axis: 'style', canonicalValue: 'dry', displayValue: 'Dry' }],
  ['드라이', { axis: 'style', canonicalValue: 'dry', displayValue: 'Dry' }],
  ['달지 않은', { axis: 'style', canonicalValue: 'dry', displayValue: 'Dry' }],
  ['off dry', { axis: 'style', canonicalValue: 'off_dry', displayValue: 'Off-Dry' }],
  ['off-dry', { axis: 'style', canonicalValue: 'off_dry', displayValue: 'Off-Dry' }],
  ['semi-sweet', { axis: 'style', canonicalValue: 'off_dry', displayValue: 'Off-Dry' }],
  ['demi-sec', { axis: 'style', canonicalValue: 'off_dry', displayValue: 'Off-Dry' }],
  ['sweet', { axis: 'style', canonicalValue: 'sweet', displayValue: 'Sweet' }],
  ['스위트', { axis: 'style', canonicalValue: 'sweet', displayValue: 'Sweet' }],
  ['달달한', { axis: 'style', canonicalValue: 'sweet', displayValue: 'Sweet' }],
  ['달콤한', { axis: 'style', canonicalValue: 'sweet', displayValue: 'Sweet' }],
  ['sparkling', { axis: 'style', canonicalValue: 'sparkling', displayValue: 'Sparkling' }],
  ['스파클링', { axis: 'style', canonicalValue: 'sparkling', displayValue: 'Sparkling' }],
  ['bubbles', { axis: 'style', canonicalValue: 'sparkling', displayValue: 'Sparkling' }],
  ['fizzy', { axis: 'style', canonicalValue: 'sparkling', displayValue: 'Sparkling' }],
  ['prosecco', { axis: 'style', canonicalValue: 'sparkling', displayValue: 'Sparkling' }],
  ['cava', { axis: 'style', canonicalValue: 'sparkling', displayValue: 'Sparkling' }],
  ['fortified', { axis: 'style', canonicalValue: 'fortified', displayValue: 'Fortified' }],
  ['주정강화', { axis: 'style', canonicalValue: 'fortified', displayValue: 'Fortified' }],
  ['port', { axis: 'style', canonicalValue: 'fortified', displayValue: 'Fortified' }],
  ['sherry', { axis: 'style', canonicalValue: 'fortified', displayValue: 'Fortified' }],
  ['rosé', { axis: 'style', canonicalValue: 'rose', displayValue: 'Rosé' }],
  ['rose', { axis: 'style', canonicalValue: 'rose', displayValue: 'Rosé' }],
  ['로제', { axis: 'style', canonicalValue: 'rose', displayValue: 'Rosé' }],
  ['natural wine', { axis: 'style', canonicalValue: 'natural', displayValue: 'Natural Wine' }],
  ['내추럴', { axis: 'style', canonicalValue: 'natural', displayValue: 'Natural Wine' }],
  ['내추럴 와인', { axis: 'style', canonicalValue: 'natural', displayValue: 'Natural Wine' }],
  ['orange wine', { axis: 'style', canonicalValue: 'orange', displayValue: 'Orange Wine' }],
  ['오렌지 와인', { axis: 'style', canonicalValue: 'orange', displayValue: 'Orange Wine' }],
  ['chillable', { axis: 'style', canonicalValue: 'chillable', displayValue: 'Chillable' }],
  ['serve chilled', { axis: 'style', canonicalValue: 'chillable', displayValue: 'Chillable' }],
  ['시원하게', { axis: 'style', canonicalValue: 'chillable', displayValue: 'Chillable' }],
  ['차갑게 마실', { axis: 'style', canonicalValue: 'chillable', displayValue: 'Chillable' }],
  ['screw cap', { axis: 'style', canonicalValue: 'screw_cap', displayValue: 'Screw Cap' }],
  ['screwcap', { axis: 'style', canonicalValue: 'screw_cap', displayValue: 'Screw Cap' }],
  ['스크류캡', { axis: 'style', canonicalValue: 'screw_cap', displayValue: 'Screw Cap' }],
  ['approachable', { axis: 'style', canonicalValue: 'approachable', displayValue: 'Approachable' }],
  ['beginner friendly', { axis: 'style', canonicalValue: 'approachable', displayValue: 'Approachable' }],
  ['입문자', { axis: 'style', canonicalValue: 'approachable', displayValue: 'Approachable' }],
  ['crowd pleasing', { axis: 'style', canonicalValue: 'crowd_pleasing', displayValue: 'Crowd-Pleasing' }],
  ['crowd-pleasing', { axis: 'style', canonicalValue: 'crowd_pleasing', displayValue: 'Crowd-Pleasing' }],
  ['실패 없는', { axis: 'style', canonicalValue: 'crowd_pleasing', displayValue: 'Crowd-Pleasing' }],
  ['무난한', { axis: 'style', canonicalValue: 'crowd_pleasing', displayValue: 'Crowd-Pleasing' }],
  ['예쁜 라벨', { axis: 'style', canonicalValue: 'presentation_forward', displayValue: 'Presentation-Forward' }],
  ['예쁜 라벨이면', { axis: 'style', canonicalValue: 'presentation_forward', displayValue: 'Presentation-Forward' }],
  ['예쁜 병', { axis: 'style', canonicalValue: 'presentation_forward', displayValue: 'Presentation-Forward' }],
  ['예쁜 거', { axis: 'style', canonicalValue: 'presentation_forward', displayValue: 'Presentation-Forward' }],
  ['패키지 예쁜', { axis: 'style', canonicalValue: 'presentation_forward', displayValue: 'Presentation-Forward' }],
  ['보기 좋은', { axis: 'style', canonicalValue: 'presentation_forward', displayValue: 'Presentation-Forward' }],
  ['pretty label', { axis: 'style', canonicalValue: 'presentation_forward', displayValue: 'Presentation-Forward' }],
  ['giftable presentation', { axis: 'style', canonicalValue: 'presentation_forward', displayValue: 'Presentation-Forward' }],

  // ── Sweetness axis (numeric sense) ──────────────────────────────────────────
  ['bone dry', { axis: 'sweetness', canonicalValue: 'bone_dry', displayValue: 'Bone Dry' }],
  ['very sweet', { axis: 'sweetness', canonicalValue: 'luscious', displayValue: 'Luscious Sweet' }],
  ['luscious', { axis: 'sweetness', canonicalValue: 'luscious', displayValue: 'Luscious Sweet' }],

  // ── Price band ──────────────────────────────────────────────────────────────
  ['budget', { axis: 'price_band', canonicalValue: 'budget', displayValue: 'Budget' }],
  ['저렴한', { axis: 'price_band', canonicalValue: 'budget', displayValue: 'Budget' }],
  ['저렴', { axis: 'price_band', canonicalValue: 'budget', displayValue: 'Budget' }],
  ['cheap', { axis: 'price_band', canonicalValue: 'budget', displayValue: 'Budget' }],
  ['affordable', { axis: 'price_band', canonicalValue: 'budget', displayValue: 'Budget' }],
  ['value', { axis: 'price_band', canonicalValue: 'value', displayValue: 'Value' }],
  ['가성비', { axis: 'price_band', canonicalValue: 'value', displayValue: 'Value' }],
  ['가성비 좋은', { axis: 'price_band', canonicalValue: 'value', displayValue: 'Value' }],
  ['입문용', { axis: 'price_band', canonicalValue: 'budget', displayValue: 'Budget' }],
  ['데일리 와인', { axis: 'price_band', canonicalValue: 'budget', displayValue: 'Budget' }],
  ['데일리와인', { axis: 'price_band', canonicalValue: 'budget', displayValue: 'Budget' }],
  ['mid range', { axis: 'price_band', canonicalValue: 'mid_range', displayValue: 'Mid-Range' }],
  ['mid-range', { axis: 'price_band', canonicalValue: 'mid_range', displayValue: 'Mid-Range' }],
  ['middle', { axis: 'price_band', canonicalValue: 'mid_range', displayValue: 'Mid-Range' }],
  ['premium', { axis: 'price_band', canonicalValue: 'premium', displayValue: 'Premium' }],
  ['프리미엄', { axis: 'price_band', canonicalValue: 'premium', displayValue: 'Premium' }],
  ['luxury', { axis: 'price_band', canonicalValue: 'luxury', displayValue: 'Luxury' }],
  ['고급', { axis: 'price_band', canonicalValue: 'luxury', displayValue: 'Luxury' }],
  ['고급와인', { axis: 'price_band', canonicalValue: 'luxury', displayValue: 'Luxury' }],
  ['특별한', { axis: 'price_band', canonicalValue: 'premium', displayValue: 'Premium' }],

  // ── Occasion ────────────────────────────────────────────────────────────────
  ['gift', { axis: 'occasion', canonicalValue: 'gift', displayValue: 'Gift' }],
  ['선물', { axis: 'occasion', canonicalValue: 'gift', displayValue: 'Gift' }],
  ['선물용', { axis: 'occasion', canonicalValue: 'gift', displayValue: 'Gift' }],
  ['gifting', { axis: 'occasion', canonicalValue: 'gift', displayValue: 'Gift' }],
  ['party', { axis: 'occasion', canonicalValue: 'party', displayValue: 'Party' }],
  ['파티', { axis: 'occasion', canonicalValue: 'party', displayValue: 'Party' }],
  ['파티용', { axis: 'occasion', canonicalValue: 'party', displayValue: 'Party' }],
  ['celebration', { axis: 'occasion', canonicalValue: 'celebration', displayValue: 'Celebration' }],
  ['celebrations', { axis: 'occasion', canonicalValue: 'celebration', displayValue: 'Celebration' }],
  ['축하', { axis: 'occasion', canonicalValue: 'celebration', displayValue: 'Celebration' }],
  ['anniversary', { axis: 'occasion', canonicalValue: 'anniversary', displayValue: 'Anniversary' }],
  ['기념일', { axis: 'occasion', canonicalValue: 'anniversary', displayValue: 'Anniversary' }],
  ['wedding', { axis: 'occasion', canonicalValue: 'wedding', displayValue: 'Wedding' }],
  ['결혼식', { axis: 'occasion', canonicalValue: 'wedding', displayValue: 'Wedding' }],
  ['date', { axis: 'occasion', canonicalValue: 'date_night', displayValue: 'Date Night' }],
  ['date night', { axis: 'occasion', canonicalValue: 'date_night', displayValue: 'Date Night' }],
  ['romantic dinner', { axis: 'occasion', canonicalValue: 'date_night', displayValue: 'Date Night' }],
  ['special dinner', { axis: 'occasion', canonicalValue: 'date_night', displayValue: 'Date Night' }],
  ['데이트', { axis: 'occasion', canonicalValue: 'date_night', displayValue: 'Date Night' }],
  ['special occasion', { axis: 'occasion', canonicalValue: 'special_occasion', displayValue: 'Special Occasion' }],
  ['birthday', { axis: 'occasion', canonicalValue: 'birthday', displayValue: 'Birthday' }],
  ['생일', { axis: 'occasion', canonicalValue: 'birthday', displayValue: 'Birthday' }],
  ['housewarming', { axis: 'occasion', canonicalValue: 'housewarming', displayValue: 'Housewarming' }],
  ['집들이', { axis: 'occasion', canonicalValue: 'housewarming', displayValue: 'Housewarming' }],
  ['solo', { axis: 'occasion', canonicalValue: 'solo', displayValue: 'Solo' }],
  ['혼술', { axis: 'occasion', canonicalValue: 'solo', displayValue: 'Solo' }],
  ['healing', { axis: 'occasion', canonicalValue: 'healing', displayValue: 'Healing' }],
  ['힐링', { axis: 'occasion', canonicalValue: 'healing', displayValue: 'Healing' }],
  ['camping', { axis: 'occasion', canonicalValue: 'camping', displayValue: 'Camping' }],
  ['캠핑', { axis: 'occasion', canonicalValue: 'camping', displayValue: 'Camping' }],
  ['romantic', { axis: 'occasion', canonicalValue: 'romantic', displayValue: 'Romantic' }],
  ['로맨틱', { axis: 'occasion', canonicalValue: 'romantic', displayValue: 'Romantic' }],
  ['comforting', { axis: 'occasion', canonicalValue: 'comforting', displayValue: 'Comforting' }],
  ['우울할 때', { axis: 'occasion', canonicalValue: 'comforting', displayValue: 'Comforting' }],
  ['비 오는 날', { axis: 'occasion', canonicalValue: 'comforting', displayValue: 'Comforting' }],

  // ── Producer prestige ────────────────────────────────────────────────────────
  ['grand cru', { axis: 'producer_prestige', canonicalValue: 'grand_cru', displayValue: 'Grand Cru' }],
  ['premier cru', { axis: 'producer_prestige', canonicalValue: 'premier_cru', displayValue: 'Premier Cru' }],
  ['1er cru', { axis: 'producer_prestige', canonicalValue: 'premier_cru', displayValue: 'Premier Cru' }],
  ['first growth', { axis: 'producer_prestige', canonicalValue: 'grand_cru', displayValue: 'Grand Cru' }],
  ['village', { axis: 'producer_prestige', canonicalValue: 'village', displayValue: 'Village' }],
  ['regional', { axis: 'producer_prestige', canonicalValue: 'regional', displayValue: 'Regional' }],

  // ── Certification ────────────────────────────────────────────────────────────
  ['organic', { axis: 'certification', canonicalValue: 'organic', displayValue: 'Organic' }],
  ['오가닉', { axis: 'certification', canonicalValue: 'organic', displayValue: 'Organic' }],
  ['유기농', { axis: 'certification', canonicalValue: 'organic', displayValue: 'Organic' }],
  ['biodynamic', { axis: 'certification', canonicalValue: 'biodynamic', displayValue: 'Biodynamic' }],
  ['바이오다이나믹', { axis: 'certification', canonicalValue: 'biodynamic', displayValue: 'Biodynamic' }],
  ['natural', { axis: 'certification', canonicalValue: 'natural', displayValue: 'Natural' }],
  ['vegan', { axis: 'certification', canonicalValue: 'vegan', displayValue: 'Vegan' }],
  ['비건', { axis: 'certification', canonicalValue: 'vegan', displayValue: 'Vegan' }],
  ['sulfite free', { axis: 'certification', canonicalValue: 'sulfite_free', displayValue: 'Sulfite-Free' }],
  ['no sulfites', { axis: 'certification', canonicalValue: 'sulfite_free', displayValue: 'Sulfite-Free' }],
  ['아황산염 없는', { axis: 'certification', canonicalValue: 'sulfite_free', displayValue: 'Sulfite-Free' }],

  // ── Acidity ──────────────────────────────────────────────────────────────────
  ['high acidity', { axis: 'acidity', canonicalValue: 'high_acidity', displayValue: 'High Acidity' }],
  ['산도 높은', { axis: 'acidity', canonicalValue: 'high_acidity', displayValue: 'High Acidity' }],
  ['crisp', { axis: 'acidity', canonicalValue: 'high_acidity', displayValue: 'High Acidity' }],
  ['low acidity', { axis: 'acidity', canonicalValue: 'low_acidity', displayValue: 'Low Acidity' }],
  ['산도 낮은', { axis: 'acidity', canonicalValue: 'low_acidity', displayValue: 'Low Acidity' }],
  ['smooth acidity', { axis: 'acidity', canonicalValue: 'medium_acidity', displayValue: 'Medium Acidity' }],

  // ── Tannin ───────────────────────────────────────────────────────────────────
  ['high tannin', { axis: 'tannin', canonicalValue: 'high_tannin', displayValue: 'High Tannin' }],
  ['타닌감', { axis: 'tannin', canonicalValue: 'high_tannin', displayValue: 'High Tannin' }],
  ['tannic', { axis: 'tannin', canonicalValue: 'high_tannin', displayValue: 'High Tannin' }],
  ['low tannin', { axis: 'tannin', canonicalValue: 'low_tannin', displayValue: 'Low Tannin' }],
  ['부드러운', { axis: 'tannin', canonicalValue: 'low_tannin', displayValue: 'Low Tannin' }],
  ['soft tannin', { axis: 'tannin', canonicalValue: 'low_tannin', displayValue: 'Low Tannin' }],
  ['silky', { axis: 'tannin', canonicalValue: 'low_tannin', displayValue: 'Low Tannin' }],

  // ── Pairing ─────────────────────────────────────────────────────────────────
  ['beef', { axis: 'pairing', canonicalValue: 'beef', displayValue: 'Beef' }],
  ['소고기', { axis: 'pairing', canonicalValue: 'beef', displayValue: 'Beef' }],
  ['스테이크', { axis: 'pairing', canonicalValue: 'beef', displayValue: 'Beef' }],
  ['lamb', { axis: 'pairing', canonicalValue: 'lamb', displayValue: 'Lamb' }],
  ['양고기', { axis: 'pairing', canonicalValue: 'lamb', displayValue: 'Lamb' }],
  ['pork', { axis: 'pairing', canonicalValue: 'pork', displayValue: 'Pork' }],
  ['돼지고기', { axis: 'pairing', canonicalValue: 'pork', displayValue: 'Pork' }],
  ['chicken', { axis: 'pairing', canonicalValue: 'chicken', displayValue: 'Chicken' }],
  ['닭', { axis: 'pairing', canonicalValue: 'chicken', displayValue: 'Chicken' }],
  ['salmon', { axis: 'pairing', canonicalValue: 'salmon', displayValue: 'Salmon' }],
  ['연어', { axis: 'pairing', canonicalValue: 'salmon', displayValue: 'Salmon' }],
  ['tuna', { axis: 'pairing', canonicalValue: 'tuna', displayValue: 'Tuna' }],
  ['참치', { axis: 'pairing', canonicalValue: 'tuna', displayValue: 'Tuna' }],
  ['oyster', { axis: 'pairing', canonicalValue: 'shellfish', displayValue: 'Shellfish' }],
  ['굴', { axis: 'pairing', canonicalValue: 'shellfish', displayValue: 'Shellfish' }],
  ['cheese', { axis: 'pairing', canonicalValue: 'cheese', displayValue: 'Cheese' }],
  ['치즈', { axis: 'pairing', canonicalValue: 'cheese', displayValue: 'Cheese' }],
  ['mushroom', { axis: 'pairing', canonicalValue: 'mushroom', displayValue: 'Mushroom' }],
  ['버섯', { axis: 'pairing', canonicalValue: 'mushroom', displayValue: 'Mushroom' }],
  ['pasta', { axis: 'pairing', canonicalValue: 'pasta', displayValue: 'Pasta' }],
  ['파스타', { axis: 'pairing', canonicalValue: 'pasta', displayValue: 'Pasta' }],
]);

// ── OntologyNormalizer ────────────────────────────────────────────────────────

/**
 * Normalizes raw phrases/tokens to canonical ontology axis + value entries.
 *
 * Lookup strategy (in order):
 * 1. Exact match (case-insensitive, trimmed) → confidence 1.0, source 'exact'.
 * 2. No match → returns null.
 *
 * Fuzzy / NLP matching is reserved for future extension (source: 'fuzzy' / 'nlp').
 */
export class OntologyNormalizer {
  /**
   * Normalizes a single phrase.
   *
   * @param phrase - Raw input phrase (any language).
   * @returns Normalization result, or `null` if no mapping exists.
   */
  normalize(phrase: string): OntologyNormalization | null {
    const key = phrase.trim().toLowerCase();
    const entry = EXACT_MAPPINGS.get(key);
    if (entry === undefined) {
      return null;
    }
    return {
      axis: entry.axis,
      canonicalValue: entry.canonicalValue,
      displayValue: entry.displayValue,
      confidence: 1.0,
      source: 'exact',
    };
  }

  /**
   * Normalizes multiple phrases, filtering out any that have no mapping.
   *
   * @param phrases - Array of raw input phrases.
   * @returns Array of successful normalizations (same order, nulls excluded).
   */
  normalizeMany(phrases: readonly string[]): readonly OntologyNormalization[] {
    const results: OntologyNormalization[] = [];
    for (const phrase of phrases) {
      const result = this.normalize(phrase);
      if (result !== null) {
        results.push(result);
      }
    }
    return results;
  }
}
