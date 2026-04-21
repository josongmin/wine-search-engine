import { z } from 'zod';
import { KRW_PER_USD_APPROXIMATE } from '../../domain/shared/constants.js';
import { coerceFiniteNumber, coerceNonNegativeInt, coercePositiveInt } from '../../domain/shared/utils/zod-coerce.js';
import { resolveSemanticStyleQueryTerms } from '../../domain/query/service/semantic-style-query-terms.js';
import type { NormalizedConstraint } from '../../domain/shared/types/index.js';

export const SEARCH_TOOL_RETRIEVAL_MODES = ['auto', 'entity', 'hybrid', 'mixed'] as const;
export const SEARCH_TOOL_WINE_TYPES = ['red', 'white', 'rosé', 'sparkling', 'fortified', 'dessert', 'orange', 'natural'] as const;
export const SEARCH_TOOL_OCCASION_VALUES = [
  'gift',
  'celebration',
  'anniversary',
  'birthday',
  'date_night',
  'housewarming',
  'party',
  'wedding',
  'special_occasion',
  'solo',
  'healing',
  'comforting',
  'camping',
  'romantic',
] as const;
export const FOOD_PAIRING_COLORS = ['red', 'white', 'rosé', 'sparkling', 'both'] as const;
export const SEARCH_TOOL_DESCRIPTION =
  'Search for wines by query. Returns matching wines with scores, attributes, and drinking windows.';
export const FOOD_PAIRINGS_TOOL_DESCRIPTION =
  'Find wines that pair well with a specific food. Optionally filter by price and wine color.';
export const DRINKING_WINDOW_TOOL_DESCRIPTION =
  'Check if a wine is currently drinkable or predict its drinking window based on vintage and attributes.';
export const COMPARE_WINES_TOOL_DESCRIPTION =
  'Compare two wines side-by-side with rankings and attributes. Optional structured constraints apply identically to both sides.';

const SEARCH_TOOL_FILTER_TEXT_MAX_LEN = 100;
const SEARCH_TOOL_STYLE_HINT_MAX_LEN = 50;
export const SEARCH_TOOL_MAX_STYLES = 5;
export const SEARCH_TOOL_MAX_EXCLUDE_FILTERS = 10;
export const SEARCH_TOOL_VINTAGE_MIN = 1600;
export const SEARCH_TOOL_VINTAGE_MAX = 2100;
const FOOD_PAIRING_FOOD_MAX_LEN = 200;

export const SEARCH_TOOL_QUERY_DESCRIPTION =
  'Wine search query anchor. Preserve the user\'s original language and lexical anchor; do not translate Korean queries into broad English paraphrases. Put extra constraints into structured fields instead (e.g., "보르도 5만원 이하", "Pinot Noir 2020", "dry red wine").';
export const SEARCH_TOOL_LIMIT_DESCRIPTION =
  'Maximum number of results to return (1-50, default: 10).';
export const SEARCH_TOOL_RETRIEVAL_MODE_DESCRIPTION =
  'Search mode: auto (planner decides), entity (exact entity matching), hybrid (semantic+lexical), mixed (advanced reasoning)';
export const SEARCH_TOOL_EXCLUDE_GRAPES_DESCRIPTION =
  'Optional grape varieties to exclude via exact index-level NOT filters.';
export const SEARCH_TOOL_EXCLUDE_REGIONS_DESCRIPTION =
  'Optional countries or regions to exclude via exact index-level NOT filters.';
export const SEARCH_TOOL_MIN_PRICE_KRW_DESCRIPTION =
  'Optional minimum price in KRW (e.g. 10000 for 1만원 하한). Use together with max_price_krw for price ranges.';
export const SEARCH_TOOL_MAX_PRICE_KRW_DESCRIPTION =
  'Optional maximum price in KRW (e.g. 50000 for 5만원).';
export const SEARCH_TOOL_MAX_ALCOHOL_PCT_DESCRIPTION =
  'Optional low-alcohol ceiling as ABV percent (e.g. 12 for low-alcohol / 도수 낮은 와인). Used as a retrieval preference and excludes only results whose ABV is explicitly verified above the ceiling; unknown ABV candidates remain marked as unverified.';
export const SEARCH_TOOL_WINE_TYPE_DESCRIPTION =
  'Optional exact wine-type constraint.';
export const SEARCH_TOOL_COUNTRY_DESCRIPTION =
  'Optional exact country constraint using English canonical country names.';
export const SEARCH_TOOL_VINTAGE_MIN_DESCRIPTION =
  'Optional minimum vintage year (inclusive).';
export const SEARCH_TOOL_VINTAGE_MAX_DESCRIPTION =
  'Optional maximum vintage year (inclusive).';
export const SEARCH_TOOL_APPELLATION_DESCRIPTION =
  'Optional exact appellation constraint.';
export const SEARCH_TOOL_STYLE_DESCRIPTION =
  'Optional semantic style hint. Preserve user meaning losslessly; examples: dry, sweet, oaked, light, chillable, screw_cap, approachable, crowd_pleasing.';
export const SEARCH_TOOL_STYLES_DESCRIPTION =
  'Optional multiple semantic style hints. Use when the query carries more than one style meaning at once, e.g. ["approachable","crowd_pleasing"].';
export const SEARCH_TOOL_CERTIFICATION_DESCRIPTION =
  'Optional certification hint such as organic or biodynamic.';
export const SEARCH_TOOL_OCCASION_DESCRIPTION =
  'Optional occasion semantics using canonical tags (e.g. gift, anniversary, birthday, date_night, housewarming, healing). Use when the user intent is situational rather than entity-specific.';
export const SEARCH_TOOL_GIFT_SUITABILITY_MIN_DESCRIPTION =
  'Optional minimum learned gift-suitability score in [0,1]. Use for safe/formal/gift-worthy recommendation intent when the request explicitly implies gifting.';
export const SEARCH_TOOL_BEGINNER_SUITABILITY_MIN_DESCRIPTION =
  'Optional minimum learned beginner-suitability score in [0,1]. Use for non-expert / approachable / easy-drinking recommendation intent when the request explicitly implies it.';
export const SEARCH_TOOL_WANT_DIVERSITY_DESCRIPTION =
  'When true, prefer varied grapes, regions, or styles rather than near-duplicates.';
export const FOOD_PAIRING_MAX_PRICE_KRW_DESCRIPTION =
  'Optional maximum wine price in KRW (preferred over USD).';
export const FOOD_PAIRING_MAX_PRICE_USD_DESCRIPTION =
  'Optional maximum wine price in USD (legacy compatibility input, e.g. 50).';
const FOOD_PAIRING_COLOR_DESCRIPTION =
  'Optional wine color filter. Use "both" when red and white are both acceptable.';
export const FOOD_PAIRING_FOOD_DESCRIPTION =
  'Food item or dish to pair against (e.g. "grilled salmon", "pasta carbonara", "cheese platter").';
export const DRINKING_WINDOW_ENTITY_ID_DESCRIPTION =
  'Wine entity ID copied from previous search results.';
export const DRINKING_WINDOW_TARGET_YEAR_DESCRIPTION =
  'Optional year to check drinkability for (defaults to current year). Use for age predictions such as 2030.';
export const COMPARE_WINES_QUERY_A_DESCRIPTION =
  'First wine query anchor (e.g. "Château Margaux 2015"). Preserve the user phrase; put shared filters into structured fields.';
export const COMPARE_WINES_QUERY_B_DESCRIPTION =
  'Second wine query anchor (e.g. "Caymus Cabernet 2018"). Preserve the user phrase; put shared filters into structured fields.';
const SEARCH_TOOL_PLACEHOLDER_PATTERN =
  /__[a-z_]+__|<[a-z_]+>|\{\{[^}]+\}\}|^(tbd|todo|placeholder|to_be_filled|unknown)$/i;

const SEARCH_TOOL_STYLE_EXAMPLES = [
  'dry',
  'sweet',
  'oaked',
  'light',
  'chillable',
  'screw_cap',
  'approachable',
  'crowd_pleasing',
] as const;
const SEARCH_TOOL_STYLES_EXAMPLE_VALUES = ['approachable', 'crowd_pleasing', 'sweet'] as const;
const SEARCH_TOOL_SWEETNESS_DRY_MAX = 0.2;
const SEARCH_TOOL_SWEETNESS_SWEET_MIN = 0.5;
const SEARCH_TOOL_SWEETNESS_OFF_DRY_MIN = 0.2;
const SEARCH_TOOL_SWEETNESS_OFF_DRY_MAX = 0.6;
const SearchToolOccasionArraySchema = z.preprocess(
  (value) => (typeof value === 'string' ? [value] : value),
  z.array(z.enum(SEARCH_TOOL_OCCASION_VALUES)).max(SEARCH_TOOL_MAX_STYLES),
);

interface SearchToolTextFieldOptions {
  readonly maxLen: number;
  readonly requiredMessage?: string | undefined;
  readonly placeholderMessage?: string | undefined;
}

function buildRequiredTrimmedString(
  options: SearchToolTextFieldOptions,
): z.ZodType<string> {
  const requiredMessage = options.requiredMessage ?? 'String must contain at least 1 character(s)';
  const placeholderMessage = options.placeholderMessage ?? 'Value cannot be a placeholder.';
  return z.string()
    .trim()
    .min(1, requiredMessage)
    .max(options.maxLen)
    .refine((value) => !SEARCH_TOOL_PLACEHOLDER_PATTERN.test(value), {
      message: placeholderMessage,
    });
}

export function buildSearchToolQueryField(
  options: SearchToolTextFieldOptions,
): z.ZodType<string> {
  return buildRequiredTrimmedString({
    ...options,
    placeholderMessage: options.placeholderMessage ?? 'query cannot be a placeholder. Use actual search terms.',
  });
}

export function buildEntityIdToolField(
  options: SearchToolTextFieldOptions,
): z.ZodType<string> {
  return buildRequiredTrimmedString({
    ...options,
    placeholderMessage: options.placeholderMessage
      ?? 'entity_id cannot be a placeholder. Copy the canonical entity_id from a prior search_wines result (e.g. "opus-one-2018").',
  });
}

export function sanitizeOptionalToolNulls(
  input: unknown,
): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return input;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== null) result[key] = value;
  }
  return result;
}

interface SearchToolFieldShapeOptions {
  readonly limitMax: number;
  readonly defaultLimit?: number | undefined;
  readonly defaultRetrievalMode?: (typeof SEARCH_TOOL_RETRIEVAL_MODES)[number] | undefined;
  readonly maxPriceKrwMax: number;
}

interface CompareToolFieldShapeOptions {
  readonly maxPriceKrwMax: number;
}

export function buildSearchToolFieldShape(
  options: SearchToolFieldShapeOptions,
){
  const limitSchema = coercePositiveInt.pipe(z.number().int().min(1).max(options.limitMax)).optional();
  const retrievalModeSchema = z.enum(SEARCH_TOOL_RETRIEVAL_MODES).optional();

  return {
    limit:
      options.defaultLimit !== undefined
        ? limitSchema.default(options.defaultLimit)
        : limitSchema,
    retrieval_mode:
      options.defaultRetrievalMode !== undefined
        ? retrievalModeSchema.default(options.defaultRetrievalMode)
        : retrievalModeSchema,
    exclude_grapes: z.array(z.string().trim().min(1).max(SEARCH_TOOL_FILTER_TEXT_MAX_LEN)).max(SEARCH_TOOL_MAX_EXCLUDE_FILTERS).optional(),
    exclude_regions: z.array(z.string().trim().min(1).max(SEARCH_TOOL_FILTER_TEXT_MAX_LEN)).max(SEARCH_TOOL_MAX_EXCLUDE_FILTERS).optional(),
    min_price_krw: coerceNonNegativeInt.pipe(z.number().int().min(1).max(options.maxPriceKrwMax)).optional(),
    max_price_krw: coerceNonNegativeInt.pipe(z.number().int().min(1).max(options.maxPriceKrwMax)).optional(),
    max_alcohol_pct: coerceFiniteNumber.pipe(z.number().positive().max(100)).optional(),
    wine_type: z.enum(SEARCH_TOOL_WINE_TYPES).optional(),
    country: z.string().trim().min(1).max(SEARCH_TOOL_FILTER_TEXT_MAX_LEN).optional(),
    vintage_min: coercePositiveInt.pipe(z.number().int().min(SEARCH_TOOL_VINTAGE_MIN).max(SEARCH_TOOL_VINTAGE_MAX)).optional(),
    vintage_max: coercePositiveInt.pipe(z.number().int().min(SEARCH_TOOL_VINTAGE_MIN).max(SEARCH_TOOL_VINTAGE_MAX)).optional(),
    appellation: z.string().trim().min(1).max(SEARCH_TOOL_FILTER_TEXT_MAX_LEN).optional(),
    style: z.string().trim().min(1).max(SEARCH_TOOL_STYLE_HINT_MAX_LEN).optional(),
    styles: z.array(z.string().trim().min(1).max(SEARCH_TOOL_STYLE_HINT_MAX_LEN)).max(SEARCH_TOOL_MAX_STYLES).optional(),
    certification: z.string().trim().min(1).max(SEARCH_TOOL_STYLE_HINT_MAX_LEN).optional(),
    occasion: SearchToolOccasionArraySchema.optional(),
    gift_suitability_min: coerceFiniteNumber.pipe(z.number().min(0).max(1)).optional(),
    beginner_suitability_min: coerceFiniteNumber.pipe(z.number().min(0).max(1)).optional(),
    want_diversity: z.boolean().optional(),
  } as const;
}

export function buildCompareToolFieldShape(
  options: CompareToolFieldShapeOptions,
){
  const {
    limit: _limit,
    retrieval_mode: _retrievalMode,
    want_diversity: _wantDiversity,
    ...shared
  } = buildSearchToolFieldShape({
    limitMax: 1,
    maxPriceKrwMax: options.maxPriceKrwMax,
  });
  return shared;
}

export function validateSearchToolVintageRange(
  data: {
    readonly min_price_krw?: number | undefined;
    readonly max_price_krw?: number | undefined;
    readonly vintage_min?: number | undefined;
    readonly vintage_max?: number | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (
    data.min_price_krw !== undefined
    && data.max_price_krw !== undefined
    && data.min_price_krw > data.max_price_krw
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['max_price_krw'],
      message: `max_price_krw (${data.max_price_krw}) must be >= min_price_krw (${data.min_price_krw})`,
    });
  }
  if (data.vintage_min !== undefined && data.vintage_max !== undefined && data.vintage_min > data.vintage_max) {
    ctx.addIssue({
      code: 'custom',
      path: ['vintage_max'],
      message: `vintage_max (${data.vintage_max}) must be >= vintage_min (${data.vintage_min})`,
    });
  }
}

interface FoodPairingFieldShapeOptions {
  readonly foodRequiredMessage: string;
  readonly maxPriceKrwMax: number;
}

export function buildFoodPairingFieldShape(
  options: FoodPairingFieldShapeOptions,
){
  const maxPriceUsdMax = Math.ceil(options.maxPriceKrwMax / KRW_PER_USD_APPROXIMATE);
  return {
    food: buildRequiredTrimmedString({
      maxLen: FOOD_PAIRING_FOOD_MAX_LEN,
      requiredMessage: options.foodRequiredMessage,
      placeholderMessage: 'food cannot be a placeholder. Use the actual dish or ingredient.',
    }),
    max_price: coerceFiniteNumber.pipe(z.number().finite().min(1).max(maxPriceUsdMax)).optional(),
    max_price_krw: coerceNonNegativeInt.pipe(z.number().int().min(1).max(options.maxPriceKrwMax)).optional(),
    color: z.enum(FOOD_PAIRING_COLORS).optional(),
  } as const;
}

function quoteEnum(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(' | ');
}

export function buildFoodPairingColorSchemaDescription(): string {
  return `${FOOD_PAIRING_COLOR_DESCRIPTION} "both" is legacy compatibility only; mixed-color recommendation requests should prefer search_wines.`;
}

export function buildSearchWinesPromptContractLines(
  usd50ApproxKrw: number,
): readonly string[] {
  return [
    '- search_wines(query, limit?, retrieval_mode?, exclude_grapes?, exclude_regions?, min_price_krw?, max_price_krw?, max_alcohol_pct?, wine_type?, country?, vintage_min?, vintage_max?, appellation?, style?, styles?, certification?, occasion?, gift_suitability_min?, beginner_suitability_min?, want_diversity?) — main search. ALWAYS use structured params — they are applied as typed constraints / preference signals and are far more reliable than embedding semantics in query text. query = search INTENT only; structured params = typed CONSTRAINTS.',
    `  - retrieval_mode: ${quoteEnum(SEARCH_TOOL_RETRIEVAL_MODES)} (only when you intentionally need a non-default route)`,
    '  - query must preserve the user\'s original language and lexical anchor. If the user asked in Korean, keep search_wines.query in Korean. Do NOT translate or paraphrase it into broad English intent text. Put normalization and extra semantics into structured params/styles instead.',
    `  - wine_type: ${quoteEnum(SEARCH_TOOL_WINE_TYPES)} (use for type constraints, e.g. 레드→"red", 화이트→"white")`,
    '  - country: English name (e.g. "France", "Italy", "Chile", "United States", "Spain", "Australia")',
    '  - vintage_min/vintage_max: year range (e.g. "2018-2020년산" → vintage_min:2018, vintage_max:2020)',
    '  - appellation: specific appellation (e.g. "Pauillac", "Barolo", "Chianti Classico")',
    `  - style: OPTIONAL single semantic style hint. Preserve the user meaning losslessly instead of collapsing it to generic body terms. Valid examples include ${SEARCH_TOOL_STYLE_EXAMPLES.map((value) => `"${value}"`).join(', ')}. Use "sweet" / "off_dry" for sweetness intent instead of vague prose.`,
    `  - styles: OPTIONAL array of semantic style hints when the user asks for multiple simultaneous qualities. Example: non-expert gift query → styles:[${SEARCH_TOOL_STYLES_EXAMPLE_VALUES.map((value) => `"${value}"`).join(',')}]. Prefer styles over style when there are 2+ style meanings.`,
    `  - occasion: OPTIONAL canonical situation tags such as ${quoteEnum(SEARCH_TOOL_OCCASION_VALUES)}. Use for gift/anniversary/date/housewarming/healing intent.`,
    '  - gift_suitability_min: OPTIONAL [0,1] learned suitability floor for gifting queries (safe/formal/gift-worthy).',
    '  - beginner_suitability_min: OPTIONAL [0,1] learned suitability floor for non-expert / approachable requests.',
    '  - certification: "organic" or "biodynamic"',
    '  - min_price_krw: KRW price floor ("1만원 이상"→10000)',
    `  - max_price_krw: KRW price cap ("5만원"→50000, "가성비"→50000, "$50"→${usd50ApproxKrw})`,
    '  - Price ranges: "1-2만원 사이" → min_price_krw:10000, max_price_krw:20000',
    '  - max_alcohol_pct: ABV ceiling for low-alcohol requests ("도수 낮은" → 12); retrieval treats it as a preference, then post-result policy removes only verified over-ceiling wines and keeps unknown-ABV candidates as unverified',
    '  - exclude_grapes: grapes to exclude, e.g. ["Cabernet Sauvignon","Merlot"] — applied as Vespa NOT filter',
    '  - exclude_regions: countries/regions to exclude, e.g. ["France","Italy"] — applied as Vespa NOT filter',
    '  - want_diversity: true when user wants varied options ("다양하게", "각각", "종류별로", "different styles")',
  ];
}

export function buildFoodPairingsPromptContractLines(): readonly string[] {
  return [
    '- get_food_pairings(food, max_price?, max_price_krw?, color?) — food-wine pairing for a single wine color only.',
    '  - max_price is legacy USD input; prefer max_price_krw for new calls.',
    `  - color must be one of ${quoteEnum(FOOD_PAIRING_COLORS.filter((color) => color !== 'both'))}. Never use both, mixed, any, or a multi-color shorthand here.`,
    '  - For mixed red+white requests (e.g. couple sets, "both colors"), do NOT call get_food_pairings. Use search_wines with want_diversity=true or parallel search_wines calls instead.',
  ];
}

function collectSearchToolStyleHints(input: {
  readonly style?: string | undefined;
  readonly styles?: readonly string[] | undefined;
}): readonly string[] {
  return input.styles !== undefined && input.styles.length > 0
    ? [...new Set(input.styles)]
    : input.style !== undefined
      ? [input.style]
      : [];
}

function collectSearchToolStylePreferenceConstraints(input: {
  readonly style?: string | undefined;
  readonly styles?: readonly string[] | undefined;
}, mappingVersion: string): readonly NormalizedConstraint[] {
  const preferences: NormalizedConstraint[] = [];
  for (const styleHint of collectSearchToolStyleHints(input)) {
    if (styleHint === 'sweet') {
      preferences.push({
        attribute: 'sweetness',
        operator: '>=',
        value: SEARCH_TOOL_SWEETNESS_SWEET_MIN,
        source_phrase: 'sweet',
        confidence: 1.0,
        mapping_version: mappingVersion,
      });
      continue;
    }
    if (styleHint === 'dry') {
      preferences.push({
        attribute: 'sweetness',
        operator: '<=',
        value: SEARCH_TOOL_SWEETNESS_DRY_MAX,
        source_phrase: 'dry',
        confidence: 1.0,
        mapping_version: mappingVersion,
      });
      continue;
    }
    if (styleHint === 'off_dry') {
      preferences.push({
        attribute: 'sweetness',
        operator: '>=',
        value: SEARCH_TOOL_SWEETNESS_OFF_DRY_MIN,
        source_phrase: 'off_dry',
        confidence: 1.0,
        mapping_version: mappingVersion,
      });
      preferences.push({
        attribute: 'sweetness',
        operator: '<=',
        value: SEARCH_TOOL_SWEETNESS_OFF_DRY_MAX,
        source_phrase: 'off_dry',
        confidence: 1.0,
        mapping_version: mappingVersion,
      });
      continue;
    }
    preferences.push({
      attribute: 'style',
      operator: 'in',
      value: [styleHint],
      source_phrase: styleHint,
      confidence: 1.0,
      mapping_version: mappingVersion,
    });
  }
  return preferences;
}

export function buildSearchToolStructuredPreferences(input: {
  readonly max_alcohol_pct?: number | undefined;
  readonly style?: string | undefined;
  readonly styles?: readonly string[] | undefined;
  readonly occasion?: readonly string[] | undefined;
  readonly gift_suitability_min?: number | undefined;
  readonly beginner_suitability_min?: number | undefined;
}, mappingVersion: string): readonly NormalizedConstraint[] {
  const preferences: NormalizedConstraint[] = [];

  if (input.max_alcohol_pct !== undefined) {
    preferences.push({
      attribute: 'alcohol_pct',
      operator: '<=',
      value: input.max_alcohol_pct,
      source_phrase: `${input.max_alcohol_pct}% 이하`,
      confidence: 1.0,
      mapping_version: mappingVersion,
    });
  }
  preferences.push(...collectSearchToolStylePreferenceConstraints(input, mappingVersion));
  if (input.occasion !== undefined && input.occasion.length > 0) {
    preferences.push({
      attribute: 'occasion',
      operator: 'in',
      value: [...input.occasion],
      source_phrase: input.occasion.join(', '),
      confidence: 1.0,
      mapping_version: mappingVersion,
    });
  }
  if (input.gift_suitability_min !== undefined) {
    preferences.push({
      attribute: 'gift_suitability',
      operator: '>=',
      value: input.gift_suitability_min,
      source_phrase: `gift_suitability>=${input.gift_suitability_min}`,
      confidence: 1.0,
      mapping_version: mappingVersion,
    });
  }
  if (input.beginner_suitability_min !== undefined) {
    preferences.push({
      attribute: 'beginner_suitability',
      operator: '>=',
      value: input.beginner_suitability_min,
      source_phrase: `beginner_suitability>=${input.beginner_suitability_min}`,
      confidence: 1.0,
      mapping_version: mappingVersion,
    });
  }

  return preferences;
}

export function buildSearchToolStyleQueryTerms(input: {
  readonly style?: string | undefined;
  readonly styles?: readonly string[] | undefined;
}): readonly string[] {
  return resolveSemanticStyleQueryTerms(input);
}
