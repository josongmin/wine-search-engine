import { z } from 'zod';
import { KRW_PER_USD_APPROXIMATE } from '../../domain/shared/constants.js';
import { coerceFiniteNumber, coerceNonNegativeInt, coercePositiveInt } from '../../domain/shared/utils/zod-coerce.js';

export const SEARCH_TOOL_RETRIEVAL_MODES = ['auto', 'entity', 'hybrid', 'mixed'] as const;
export const SEARCH_TOOL_WINE_TYPES = ['red', 'white', 'rosé', 'sparkling', 'fortified', 'dessert', 'orange', 'natural'] as const;
export const FOOD_PAIRING_COLORS = ['red', 'white', 'rosé', 'sparkling', 'both'] as const;
export const SEARCH_TOOL_DESCRIPTION =
  'Search for wines by query. Returns matching wines with scores, attributes, and drinking windows.';
export const FOOD_PAIRINGS_TOOL_DESCRIPTION =
  'Find wines that pair well with a specific food. Optionally filter by price and wine color.';
export const DRINKING_WINDOW_TOOL_DESCRIPTION =
  'Check if a wine is currently drinkable or predict its drinking window based on vintage and attributes.';
export const COMPARE_WINES_TOOL_DESCRIPTION =
  'Compare two wines side-by-side with rankings and attributes.';

export const SEARCH_TOOL_FILTER_TEXT_MAX_LEN = 100;
export const SEARCH_TOOL_STYLE_HINT_MAX_LEN = 50;
export const SEARCH_TOOL_MAX_STYLES = 5;
export const SEARCH_TOOL_MAX_EXCLUDE_FILTERS = 10;
export const SEARCH_TOOL_VINTAGE_MIN = 1600;
export const SEARCH_TOOL_VINTAGE_MAX = 2100;
export const FOOD_PAIRING_FOOD_MAX_LEN = 200;

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
export const SEARCH_TOOL_MAX_PRICE_KRW_DESCRIPTION =
  'Optional maximum price in KRW (e.g. 50000 for 5만원).';
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
export const SEARCH_TOOL_WANT_DIVERSITY_DESCRIPTION =
  'When true, prefer varied grapes, regions, or styles rather than near-duplicates.';
export const FOOD_PAIRING_MAX_PRICE_KRW_DESCRIPTION =
  'Optional maximum wine price in KRW (preferred over USD).';
export const FOOD_PAIRING_MAX_PRICE_USD_DESCRIPTION =
  'Optional maximum wine price in USD (legacy compatibility input, e.g. 50).';
export const FOOD_PAIRING_COLOR_DESCRIPTION =
  'Optional wine color filter. Use "both" when red and white are both acceptable.';
export const FOOD_PAIRING_FOOD_DESCRIPTION =
  'Food item or dish to pair against (e.g. "grilled salmon", "pasta carbonara", "cheese platter").';
export const DRINKING_WINDOW_ENTITY_ID_DESCRIPTION =
  'Wine entity ID copied from previous search results.';
export const DRINKING_WINDOW_TARGET_YEAR_DESCRIPTION =
  'Optional year to check drinkability for (defaults to current year). Use for age predictions such as 2030.';
export const COMPARE_WINES_QUERY_A_DESCRIPTION =
  'First wine query (e.g. "Château Margaux 2015").';
export const COMPARE_WINES_QUERY_B_DESCRIPTION =
  'Second wine query (e.g. "Caymus Cabernet 2018").';
export const SEARCH_TOOL_PLACEHOLDER_PATTERN =
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
  'presentation_forward',
] as const;
const SEARCH_TOOL_STYLES_EXAMPLE_VALUES = ['approachable', 'crowd_pleasing', 'presentation_forward'] as const;

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
    max_price_krw: coerceNonNegativeInt.pipe(z.number().int().min(1).max(options.maxPriceKrwMax)).optional(),
    wine_type: z.enum(SEARCH_TOOL_WINE_TYPES).optional(),
    country: z.string().trim().min(1).max(SEARCH_TOOL_FILTER_TEXT_MAX_LEN).optional(),
    vintage_min: coercePositiveInt.pipe(z.number().int().min(SEARCH_TOOL_VINTAGE_MIN).max(SEARCH_TOOL_VINTAGE_MAX)).optional(),
    vintage_max: coercePositiveInt.pipe(z.number().int().min(SEARCH_TOOL_VINTAGE_MIN).max(SEARCH_TOOL_VINTAGE_MAX)).optional(),
    appellation: z.string().trim().min(1).max(SEARCH_TOOL_FILTER_TEXT_MAX_LEN).optional(),
    style: z.string().trim().min(1).max(SEARCH_TOOL_STYLE_HINT_MAX_LEN).optional(),
    styles: z.array(z.string().trim().min(1).max(SEARCH_TOOL_STYLE_HINT_MAX_LEN)).max(SEARCH_TOOL_MAX_STYLES).optional(),
    certification: z.string().trim().min(1).max(SEARCH_TOOL_STYLE_HINT_MAX_LEN).optional(),
    want_diversity: z.boolean().optional(),
  } as const;
}

export function validateSearchToolVintageRange(
  data: {
    readonly vintage_min?: number | undefined;
    readonly vintage_max?: number | undefined;
  },
  ctx: z.RefinementCtx,
): void {
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
    '- search_wines(query, limit?, retrieval_mode?, exclude_grapes?, exclude_regions?, max_price_krw?, wine_type?, country?, vintage_min?, vintage_max?, appellation?, style?, styles?, certification?, want_diversity?) — main search. ALWAYS use structured params — they are applied as exact Vespa index filters and are far more reliable than embedding constraints in query text. query = search INTENT only; structured params = hard CONSTRAINTS.',
    `  - retrieval_mode: ${quoteEnum(SEARCH_TOOL_RETRIEVAL_MODES)} (only when you intentionally need a non-default route)`,
    '  - query must preserve the user\'s original language and lexical anchor. If the user asked in Korean, keep search_wines.query in Korean. Do NOT translate or paraphrase it into broad English intent text. Put normalization and extra semantics into structured params/styles instead.',
    `  - wine_type: ${quoteEnum(SEARCH_TOOL_WINE_TYPES)} (use for type constraints, e.g. 레드→"red", 화이트→"white")`,
    '  - country: English name (e.g. "France", "Italy", "Chile", "United States", "Spain", "Australia")',
    '  - vintage_min/vintage_max: year range (e.g. "2018-2020년산" → vintage_min:2018, vintage_max:2020)',
    '  - appellation: specific appellation (e.g. "Pauillac", "Barolo", "Chianti Classico")',
    `  - style: OPTIONAL single semantic style hint. Preserve the user meaning losslessly instead of collapsing it to generic body terms. Valid examples include ${SEARCH_TOOL_STYLE_EXAMPLES.map((value) => `"${value}"`).join(', ')}.`,
    `  - styles: OPTIONAL array of semantic style hints when the user asks for multiple simultaneous qualities. Example: non-expert gift query → styles:[${SEARCH_TOOL_STYLES_EXAMPLE_VALUES.map((value) => `"${value}"`).join(',')}]. Prefer styles over style when there are 2+ style meanings.`,
    '  - certification: "organic" or "biodynamic"',
    `  - max_price_krw: KRW price cap ("5만원"→50000, "가성비"→50000, "$50"→${usd50ApproxKrw})`,
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
