/**
 * Claude Tool Schemas — HTTP/route surface for wine search tools.
 *
 * Defines 4 wine-specific tools in Claude API format:
 * 1. search_wines - Query wine inventory with mode selection
 * 2. get_food_pairings - Find wines that pair with foods
 * 3. check_drinking_window - Predict wine drinkability
 * 4. compare_wines - Compare two wines side-by-side
 *
 * SSOT chain:
 *   search-tool-contract.ts  → descriptions, enums, bounds, field builders
 *   agent-tool-attempt-schema.ts → attempt-level Zod schemas + discriminated types
 *   this file → re-exports attempt schemas + defines HTTP validator schemas + Claude API manifest
 */

import { z } from 'zod';
import {
  buildCompareToolFieldShape,
  COMPARE_WINES_QUERY_A_DESCRIPTION,
  COMPARE_WINES_QUERY_B_DESCRIPTION,
  COMPARE_WINES_TOOL_DESCRIPTION,
  DRINKING_WINDOW_ENTITY_ID_DESCRIPTION,
  DRINKING_WINDOW_TARGET_YEAR_DESCRIPTION,
  DRINKING_WINDOW_TOOL_DESCRIPTION,
  FOOD_PAIRING_COLORS,
  FOOD_PAIRING_ACIDITY_MIN_DESCRIPTION,
  FOOD_PAIRING_FOOD_DESCRIPTION,
  FOOD_PAIRING_MAX_PAIRING_TAGS,
  FOOD_PAIRING_MAX_PRICE_KRW_DESCRIPTION,
  FOOD_PAIRING_MAX_PRICE_USD_DESCRIPTION,
  FOOD_PAIRING_PAIRING_TAGS_DESCRIPTION,
  FOOD_PAIRING_SENSORY_SCALE_MAX,
  FOOD_PAIRING_SENSORY_SCALE_MIN,
  FOOD_PAIRING_STYLES_DESCRIPTION,
  FOOD_PAIRING_SWEETNESS_TARGET_DESCRIPTION,
  FOOD_PAIRING_SWEETNESS_TARGET_MAX,
  FOOD_PAIRING_SWEETNESS_TARGET_MIN,
  FOOD_PAIRING_TANNIN_MAX_DESCRIPTION,
  FOOD_PAIRINGS_TOOL_DESCRIPTION,
  SEARCH_TOOL_APPELLATION_DESCRIPTION,
  SEARCH_TOOL_CERTIFICATION_DESCRIPTION,
  SEARCH_TOOL_COUNTRY_DESCRIPTION,
  SEARCH_TOOL_REGION_DESCRIPTION,
  SEARCH_TOOL_DESCRIPTION,
  SEARCH_TOOL_EXCLUDE_GRAPES_DESCRIPTION,
  SEARCH_TOOL_EXCLUDE_REGIONS_DESCRIPTION,
  SEARCH_TOOL_LIMIT_DESCRIPTION,
  SEARCH_TOOL_OCCASION_DESCRIPTION,
  SEARCH_TOOL_GIFT_SUITABILITY_MIN_DESCRIPTION,
  SEARCH_TOOL_BEGINNER_SUITABILITY_MIN_DESCRIPTION,
  SEARCH_TOOL_PRODUCER_PRESTIGE_MIN_DESCRIPTION,
  SEARCH_TOOL_POPULARITY_MIN_DESCRIPTION,
  SEARCH_TOOL_RECIPIENT_PROFILE_DESCRIPTION,
  SEARCH_TOOL_SWEETNESS_MIN_DESCRIPTION,
  SEARCH_TOOL_SWEETNESS_MAX_DESCRIPTION,
  SEARCH_TOOL_ACIDITY_MIN_DESCRIPTION,
  SEARCH_TOOL_ACIDITY_MAX_DESCRIPTION,
  SEARCH_TOOL_TANNIN_MAX_DESCRIPTION,
  SEARCH_TOOL_DRINKING_WINDOW_DESCRIPTION,
  SEARCH_TOOL_DRINKING_WINDOW_TARGET_YEAR_DESCRIPTION,
  SEARCH_TOOL_DRINKING_WINDOW_VALUES,
  SEARCH_TOOL_GRAPE_PRIMARY_DESCRIPTION,
  SEARCH_TOOL_MAX_ALCOHOL_PCT_DESCRIPTION,
  SEARCH_TOOL_MAX_EXCLUDE_FILTERS,
  SEARCH_TOOL_MIN_PRICE_KRW_DESCRIPTION,
  SEARCH_TOOL_MAX_PRICE_KRW_DESCRIPTION,
  SEARCH_TOOL_MAX_STYLES,
  SEARCH_TOOL_QUERY_DESCRIPTION,
  SEARCH_TOOL_RETRIEVAL_MODE_DESCRIPTION,
  SEARCH_TOOL_RETRIEVAL_MODES,
  SEARCH_TOOL_STYLE_DESCRIPTION,
  SEARCH_TOOL_STYLES_DESCRIPTION,
  SEARCH_TOOL_VINTAGE_MAX,
  SEARCH_TOOL_VINTAGE_MAX_DESCRIPTION,
  SEARCH_TOOL_VINTAGE_MIN,
  SEARCH_TOOL_VINTAGE_MIN_DESCRIPTION,
  SEARCH_TOOL_WANT_DIVERSITY_DESCRIPTION,
  SEARCH_TOOL_WINE_TYPE_DESCRIPTION,
  SEARCH_TOOL_WINE_TYPES,
  buildEntityIdToolField,
  buildFoodPairingColorSchemaDescription,
  buildFoodPairingFieldShape,
  buildSearchToolFieldShape,
  buildSearchToolQueryField,
  validateSearchToolVintageRange,
} from '../../application/search/search-tool-contract.js';
import { RECIPIENT_PROFILE_VALUES } from '../../domain/query/service/recipient-situation-profile.js';
export {
  CompareWinesAttemptInputSchema,
  DrinkingWindowAttemptInputSchema,
  FoodPairingAttemptInputSchema,
  SearchToolAttemptInputSchema,
} from '../../application/agent/agent-tool-attempt-schema.js';
import {
  MAX_PRODUCED_VINTAGE_YEAR,
  MIN_PRODUCED_VINTAGE_YEAR,
  MAX_QUERY_LENGTH,
} from '../../domain/shared/constants.js';
import { coercePositiveInt } from '../../domain/shared/utils/zod-coerce.js';
import { MAX_WINE_TOOL_SEARCH_RESULTS } from '../http/constants.js';

const SEARCH_TOOL_QUERY_MAX_LEN = MAX_QUERY_LENGTH;
const ENTITY_ID_MAX_LEN = 500;
const MAX_PRICE_KRW_BOUND = Number.MAX_SAFE_INTEGER;

export const ClaudeToolNameSchema = z.enum([
  'search_wines',
  'get_food_pairings',
  'check_drinking_window',
  'compare_wines',
]);

const ClaudeToolStringPropertySchema = z.object({
  type: z.literal('string'),
  description: z.string().min(1),
  enum: z.array(z.string().min(1)).min(1).optional(),
}).strict();

const ClaudeToolNumberPropertySchema = z.object({
  type: z.literal('number'),
  description: z.string().min(1),
  minimum: z.number().finite().optional(),
  maximum: z.number().finite().optional(),
}).strict();

const ClaudeToolBooleanPropertySchema = z.object({
  type: z.literal('boolean'),
  description: z.string().min(1),
}).strict();

const ClaudeToolStringArrayPropertySchema = z.object({
  type: z.literal('array'),
  items: z.object({
    type: z.literal('string'),
  }).strict(),
  description: z.string().min(1),
  maxItems: z.number().int().positive().optional(),
}).strict();

const ClaudeToolInputSchemaPropertySchema = z.union([
  ClaudeToolStringPropertySchema,
  ClaudeToolNumberPropertySchema,
  ClaudeToolBooleanPropertySchema,
  ClaudeToolStringArrayPropertySchema,
]);

const ClaudeToolInputSchemaSchema = z.object({
  type: z.literal('object'),
  properties: z.record(ClaudeToolInputSchemaPropertySchema),
  required: z.array(z.string().min(1)),
}).strict();

export const ClaudeToolDefinitionSchema = z.object({
  name: ClaudeToolNameSchema,
  description: z.string().min(1),
  input_schema: ClaudeToolInputSchemaSchema,
}).strict();

type ClaudeToolDefinition = z.infer<typeof ClaudeToolDefinitionSchema>;

export const SearchToolInputSchema = z.object({
  query: buildSearchToolQueryField({
    maxLen: SEARCH_TOOL_QUERY_MAX_LEN,
    requiredMessage: 'Query must not be empty',
  }),
  ...buildSearchToolFieldShape({
    limitMax: MAX_WINE_TOOL_SEARCH_RESULTS,
    defaultLimit: 10,
    defaultRetrievalMode: 'auto',
    maxPriceKrwMax: MAX_PRICE_KRW_BOUND,
  }),
}).strict().superRefine((data, ctx) => {
  validateSearchToolVintageRange(data, ctx);
});

export const FoodPairingInputSchema = z.object({
  ...buildFoodPairingFieldShape({
    foodRequiredMessage: 'Food must not be empty',
    maxPriceKrwMax: MAX_PRICE_KRW_BOUND,
  }),
}).strict();

export const DrinkingWindowInputSchema = z.object({
  entity_id: buildEntityIdToolField({
    maxLen: ENTITY_ID_MAX_LEN,
    requiredMessage: 'Entity ID must not be empty',
  }),
  target_year: coercePositiveInt.pipe(
    z.number().int().min(MIN_PRODUCED_VINTAGE_YEAR).max(MAX_PRODUCED_VINTAGE_YEAR),
  ).optional(),
}).strict();

export const CompareWinesInputSchema = z.object({
  query_a: buildSearchToolQueryField({
    maxLen: SEARCH_TOOL_QUERY_MAX_LEN,
    requiredMessage: 'Query A must not be empty',
  }),
  query_b: buildSearchToolQueryField({
    maxLen: SEARCH_TOOL_QUERY_MAX_LEN,
    requiredMessage: 'Query B must not be empty',
  }),
  ...buildCompareToolFieldShape({
    maxPriceKrwMax: MAX_PRICE_KRW_BOUND,
  }),
  country_a: z.string().trim().min(1).max(MAX_QUERY_LENGTH).optional(),
  country_b: z.string().trim().min(1).max(MAX_QUERY_LENGTH).optional(),
  region_a: z.string().trim().min(1).max(MAX_QUERY_LENGTH).optional(),
  region_b: z.string().trim().min(1).max(MAX_QUERY_LENGTH).optional(),
  appellation_a: z.string().trim().min(1).max(MAX_QUERY_LENGTH).optional(),
  appellation_b: z.string().trim().min(1).max(MAX_QUERY_LENGTH).optional(),
  grape_primary_a: z.string().trim().min(1).max(MAX_QUERY_LENGTH).optional(),
  grape_primary_b: z.string().trim().min(1).max(MAX_QUERY_LENGTH).optional(),
  wine_type_a: z.enum(SEARCH_TOOL_WINE_TYPES).optional(),
  wine_type_b: z.enum(SEARCH_TOOL_WINE_TYPES).optional(),
  vintage_min_a: coercePositiveInt.pipe(
    z.number().int().min(MIN_PRODUCED_VINTAGE_YEAR).max(MAX_PRODUCED_VINTAGE_YEAR),
  ).optional(),
  vintage_min_b: coercePositiveInt.pipe(
    z.number().int().min(MIN_PRODUCED_VINTAGE_YEAR).max(MAX_PRODUCED_VINTAGE_YEAR),
  ).optional(),
  vintage_max_a: coercePositiveInt.pipe(
    z.number().int().min(MIN_PRODUCED_VINTAGE_YEAR).max(MAX_PRODUCED_VINTAGE_YEAR),
  ).optional(),
  vintage_max_b: coercePositiveInt.pipe(
    z.number().int().min(MIN_PRODUCED_VINTAGE_YEAR).max(MAX_PRODUCED_VINTAGE_YEAR),
  ).optional(),
}).strict().superRefine((data, ctx) => {
  validateSearchToolVintageRange(data, ctx);
  validateSearchToolVintageRange({
    vintage_min: data.vintage_min_a,
    vintage_max: data.vintage_max_a,
  }, ctx);
  validateSearchToolVintageRange({
    vintage_min: data.vintage_min_b,
    vintage_max: data.vintage_max_b,
  }, ctx);
});

/**
 * WINE_SEARCH_TOOLS: 4 wine-specific tools for Claude integration.
 *
 * Format: Claude API tools parameter specification (compatible with
 * claude-3-5-sonnet and later models).
 */
export const WINE_SEARCH_TOOLS = [
  {
    name: 'search_wines',
    description: SEARCH_TOOL_DESCRIPTION,
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: SEARCH_TOOL_QUERY_DESCRIPTION,
        },
        limit: {
          type: 'number',
          description: SEARCH_TOOL_LIMIT_DESCRIPTION,
          minimum: 1,
          maximum: MAX_WINE_TOOL_SEARCH_RESULTS,
        },
        retrieval_mode: {
          type: 'string',
          enum: [...SEARCH_TOOL_RETRIEVAL_MODES],
          description: SEARCH_TOOL_RETRIEVAL_MODE_DESCRIPTION,
        },
        exclude_grapes: {
          type: 'array',
          items: { type: 'string' },
          description: SEARCH_TOOL_EXCLUDE_GRAPES_DESCRIPTION,
          maxItems: SEARCH_TOOL_MAX_EXCLUDE_FILTERS,
        },
        exclude_regions: {
          type: 'array',
          items: { type: 'string' },
          description: SEARCH_TOOL_EXCLUDE_REGIONS_DESCRIPTION,
          maxItems: SEARCH_TOOL_MAX_EXCLUDE_FILTERS,
        },
        min_price_krw: {
          type: 'number',
          description: SEARCH_TOOL_MIN_PRICE_KRW_DESCRIPTION,
          minimum: 1,
        },
        max_price_krw: {
          type: 'number',
          description: SEARCH_TOOL_MAX_PRICE_KRW_DESCRIPTION,
          minimum: 1,
        },
        max_alcohol_pct: {
          type: 'number',
          description: SEARCH_TOOL_MAX_ALCOHOL_PCT_DESCRIPTION,
          minimum: 0.1,
          maximum: 100,
        },
        grape_primary: {
          type: 'string',
          description: SEARCH_TOOL_GRAPE_PRIMARY_DESCRIPTION,
        },
        wine_type: {
          type: 'string',
          enum: [...SEARCH_TOOL_WINE_TYPES],
          description: SEARCH_TOOL_WINE_TYPE_DESCRIPTION,
        },
        country: {
          type: 'string',
          description: SEARCH_TOOL_COUNTRY_DESCRIPTION,
        },
        region: {
          type: 'string',
          description: SEARCH_TOOL_REGION_DESCRIPTION,
        },
        vintage_min: {
          type: 'number',
          description: SEARCH_TOOL_VINTAGE_MIN_DESCRIPTION,
          minimum: SEARCH_TOOL_VINTAGE_MIN,
          maximum: SEARCH_TOOL_VINTAGE_MAX,
        },
        vintage_max: {
          type: 'number',
          description: SEARCH_TOOL_VINTAGE_MAX_DESCRIPTION,
          minimum: SEARCH_TOOL_VINTAGE_MIN,
          maximum: SEARCH_TOOL_VINTAGE_MAX,
        },
        appellation: {
          type: 'string',
          description: SEARCH_TOOL_APPELLATION_DESCRIPTION,
        },
        style: {
          type: 'string',
          description: SEARCH_TOOL_STYLE_DESCRIPTION,
        },
        styles: {
          type: 'array',
          items: { type: 'string' },
          description: SEARCH_TOOL_STYLES_DESCRIPTION,
          maxItems: SEARCH_TOOL_MAX_STYLES,
        },
        certification: {
          type: 'string',
          description: SEARCH_TOOL_CERTIFICATION_DESCRIPTION,
        },
        occasion: {
          type: 'array',
          items: { type: 'string' },
          description: SEARCH_TOOL_OCCASION_DESCRIPTION,
          maxItems: SEARCH_TOOL_MAX_STYLES,
        },
        gift_suitability_min: {
          type: 'number',
          description: SEARCH_TOOL_GIFT_SUITABILITY_MIN_DESCRIPTION,
          minimum: 0,
          maximum: 1,
        },
        beginner_suitability_min: {
          type: 'number',
          description: SEARCH_TOOL_BEGINNER_SUITABILITY_MIN_DESCRIPTION,
          minimum: 0,
          maximum: 1,
        },
        producer_prestige_min: {
          type: 'number',
          description: SEARCH_TOOL_PRODUCER_PRESTIGE_MIN_DESCRIPTION,
          minimum: 0,
          maximum: 1,
        },
        popularity_min: {
          type: 'number',
          description: SEARCH_TOOL_POPULARITY_MIN_DESCRIPTION,
          minimum: 0,
          maximum: 1,
        },
        recipient_profile: {
          type: 'string',
          enum: [...RECIPIENT_PROFILE_VALUES],
          description: SEARCH_TOOL_RECIPIENT_PROFILE_DESCRIPTION,
        },
        sweetness_min: {
          type: 'number',
          description: SEARCH_TOOL_SWEETNESS_MIN_DESCRIPTION,
          minimum: FOOD_PAIRING_SWEETNESS_TARGET_MIN,
          maximum: FOOD_PAIRING_SWEETNESS_TARGET_MAX,
        },
        sweetness_max: {
          type: 'number',
          description: SEARCH_TOOL_SWEETNESS_MAX_DESCRIPTION,
          minimum: FOOD_PAIRING_SWEETNESS_TARGET_MIN,
          maximum: FOOD_PAIRING_SWEETNESS_TARGET_MAX,
        },
        acidity_min: {
          type: 'number',
          description: SEARCH_TOOL_ACIDITY_MIN_DESCRIPTION,
          minimum: FOOD_PAIRING_SWEETNESS_TARGET_MIN,
          maximum: FOOD_PAIRING_SWEETNESS_TARGET_MAX,
        },
        acidity_max: {
          type: 'number',
          description: SEARCH_TOOL_ACIDITY_MAX_DESCRIPTION,
          minimum: FOOD_PAIRING_SWEETNESS_TARGET_MIN,
          maximum: FOOD_PAIRING_SWEETNESS_TARGET_MAX,
        },
        tannin_max: {
          type: 'number',
          description: SEARCH_TOOL_TANNIN_MAX_DESCRIPTION,
          minimum: FOOD_PAIRING_SWEETNESS_TARGET_MIN,
          maximum: FOOD_PAIRING_SWEETNESS_TARGET_MAX,
        },
        drinking_window: {
          type: 'string',
          enum: [...SEARCH_TOOL_DRINKING_WINDOW_VALUES],
          description: SEARCH_TOOL_DRINKING_WINDOW_DESCRIPTION,
        },
        drinking_window_target_year: {
          type: 'number',
          description: SEARCH_TOOL_DRINKING_WINDOW_TARGET_YEAR_DESCRIPTION,
          minimum: SEARCH_TOOL_VINTAGE_MIN,
          maximum: SEARCH_TOOL_VINTAGE_MAX,
        },
        want_diversity: {
          type: 'boolean',
          description: SEARCH_TOOL_WANT_DIVERSITY_DESCRIPTION,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_food_pairings',
    description: FOOD_PAIRINGS_TOOL_DESCRIPTION,
    input_schema: {
      type: 'object' as const,
      properties: {
        food: {
          type: 'string',
          description: FOOD_PAIRING_FOOD_DESCRIPTION,
        },
        max_price: {
          type: 'number',
          description: FOOD_PAIRING_MAX_PRICE_USD_DESCRIPTION,
        },
        max_price_krw: {
          type: 'number',
          description: FOOD_PAIRING_MAX_PRICE_KRW_DESCRIPTION,
          minimum: 1,
        },
        color: {
          type: 'string',
          enum: [...FOOD_PAIRING_COLORS],
          description: buildFoodPairingColorSchemaDescription(),
        },
        sweetness_target: {
          type: 'number',
          description: FOOD_PAIRING_SWEETNESS_TARGET_DESCRIPTION,
          minimum: FOOD_PAIRING_SWEETNESS_TARGET_MIN,
          maximum: FOOD_PAIRING_SWEETNESS_TARGET_MAX,
        },
        acidity_min: {
          type: 'number',
          description: FOOD_PAIRING_ACIDITY_MIN_DESCRIPTION,
          minimum: FOOD_PAIRING_SENSORY_SCALE_MIN,
          maximum: FOOD_PAIRING_SENSORY_SCALE_MAX,
        },
        tannin_max: {
          type: 'number',
          description: FOOD_PAIRING_TANNIN_MAX_DESCRIPTION,
          minimum: FOOD_PAIRING_SENSORY_SCALE_MIN,
          maximum: FOOD_PAIRING_SENSORY_SCALE_MAX,
        },
        styles: {
          type: 'array',
          items: { type: 'string' },
          description: FOOD_PAIRING_STYLES_DESCRIPTION,
          maxItems: SEARCH_TOOL_MAX_STYLES,
        },
        pairing_tags: {
          type: 'array',
          items: { type: 'string' },
          description: FOOD_PAIRING_PAIRING_TAGS_DESCRIPTION,
          maxItems: FOOD_PAIRING_MAX_PAIRING_TAGS,
        },
      },
      required: ['food'],
    },
  },
  {
    name: 'check_drinking_window',
    description: DRINKING_WINDOW_TOOL_DESCRIPTION,
    input_schema: {
      type: 'object' as const,
      properties: {
        entity_id: {
          type: 'string',
          description: DRINKING_WINDOW_ENTITY_ID_DESCRIPTION,
        },
        target_year: {
          type: 'number',
          description: DRINKING_WINDOW_TARGET_YEAR_DESCRIPTION,
        },
      },
      required: ['entity_id'],
    },
  },
  {
    name: 'compare_wines',
    description: COMPARE_WINES_TOOL_DESCRIPTION,
    input_schema: {
      type: 'object' as const,
      properties: {
        query_a: {
          type: 'string',
          description: COMPARE_WINES_QUERY_A_DESCRIPTION,
        },
        query_b: {
          type: 'string',
          description: COMPARE_WINES_QUERY_B_DESCRIPTION,
        },
        exclude_grapes: {
          type: 'array',
          items: { type: 'string' },
          description: SEARCH_TOOL_EXCLUDE_GRAPES_DESCRIPTION,
          maxItems: SEARCH_TOOL_MAX_EXCLUDE_FILTERS,
        },
        exclude_regions: {
          type: 'array',
          items: { type: 'string' },
          description: SEARCH_TOOL_EXCLUDE_REGIONS_DESCRIPTION,
          maxItems: SEARCH_TOOL_MAX_EXCLUDE_FILTERS,
        },
        min_price_krw: {
          type: 'number',
          description: SEARCH_TOOL_MIN_PRICE_KRW_DESCRIPTION,
          minimum: 1,
        },
        max_price_krw: {
          type: 'number',
          description: SEARCH_TOOL_MAX_PRICE_KRW_DESCRIPTION,
          minimum: 1,
        },
        max_alcohol_pct: {
          type: 'number',
          description: SEARCH_TOOL_MAX_ALCOHOL_PCT_DESCRIPTION,
          minimum: 0.1,
          maximum: 100,
        },
        grape_primary: {
          type: 'string',
          description: SEARCH_TOOL_GRAPE_PRIMARY_DESCRIPTION,
        },
        wine_type: {
          type: 'string',
          enum: [...SEARCH_TOOL_WINE_TYPES],
          description: SEARCH_TOOL_WINE_TYPE_DESCRIPTION,
        },
        country: {
          type: 'string',
          description: SEARCH_TOOL_COUNTRY_DESCRIPTION,
        },
        region: {
          type: 'string',
          description: SEARCH_TOOL_REGION_DESCRIPTION,
        },
        country_a: {
          type: 'string',
          description: 'Optional side-A exact country constraint. Use when the two sides differ by country.',
        },
        country_b: {
          type: 'string',
          description: 'Optional side-B exact country constraint. Use when the two sides differ by country.',
        },
        region_a: {
          type: 'string',
          description: 'Optional side-A exact region constraint. Use when the two sides differ by region.',
        },
        region_b: {
          type: 'string',
          description: 'Optional side-B exact region constraint. Use when the two sides differ by region.',
        },
        appellation_a: {
          type: 'string',
          description: 'Optional side-A exact appellation constraint. Use when the two sides differ by appellation.',
        },
        appellation_b: {
          type: 'string',
          description: 'Optional side-B exact appellation constraint. Use when the two sides differ by appellation.',
        },
        grape_primary_a: {
          type: 'string',
          description: 'Optional side-A exact primary-grape constraint. Use when the two sides differ by grape.',
        },
        grape_primary_b: {
          type: 'string',
          description: 'Optional side-B exact primary-grape constraint. Use when the two sides differ by grape.',
        },
        wine_type_a: {
          type: 'string',
          enum: [...SEARCH_TOOL_WINE_TYPES],
          description: 'Optional side-A exact wine-type constraint.',
        },
        wine_type_b: {
          type: 'string',
          enum: [...SEARCH_TOOL_WINE_TYPES],
          description: 'Optional side-B exact wine-type constraint.',
        },
        vintage_min_a: {
          type: 'number',
          description: 'Optional side-A minimum vintage year (inclusive).',
          minimum: SEARCH_TOOL_VINTAGE_MIN,
          maximum: SEARCH_TOOL_VINTAGE_MAX,
        },
        vintage_min_b: {
          type: 'number',
          description: 'Optional side-B minimum vintage year (inclusive).',
          minimum: SEARCH_TOOL_VINTAGE_MIN,
          maximum: SEARCH_TOOL_VINTAGE_MAX,
        },
        vintage_max_a: {
          type: 'number',
          description: 'Optional side-A maximum vintage year (inclusive).',
          minimum: SEARCH_TOOL_VINTAGE_MIN,
          maximum: SEARCH_TOOL_VINTAGE_MAX,
        },
        vintage_max_b: {
          type: 'number',
          description: 'Optional side-B maximum vintage year (inclusive).',
          minimum: SEARCH_TOOL_VINTAGE_MIN,
          maximum: SEARCH_TOOL_VINTAGE_MAX,
        },
        vintage_min: {
          type: 'number',
          description: SEARCH_TOOL_VINTAGE_MIN_DESCRIPTION,
          minimum: SEARCH_TOOL_VINTAGE_MIN,
          maximum: SEARCH_TOOL_VINTAGE_MAX,
        },
        vintage_max: {
          type: 'number',
          description: SEARCH_TOOL_VINTAGE_MAX_DESCRIPTION,
          minimum: SEARCH_TOOL_VINTAGE_MIN,
          maximum: SEARCH_TOOL_VINTAGE_MAX,
        },
        appellation: {
          type: 'string',
          description: SEARCH_TOOL_APPELLATION_DESCRIPTION,
        },
        style: {
          type: 'string',
          description: SEARCH_TOOL_STYLE_DESCRIPTION,
        },
        styles: {
          type: 'array',
          items: { type: 'string' },
          description: SEARCH_TOOL_STYLES_DESCRIPTION,
          maxItems: SEARCH_TOOL_MAX_STYLES,
        },
        certification: {
          type: 'string',
          description: SEARCH_TOOL_CERTIFICATION_DESCRIPTION,
        },
        occasion: {
          type: 'array',
          items: { type: 'string' },
          description: SEARCH_TOOL_OCCASION_DESCRIPTION,
          maxItems: SEARCH_TOOL_MAX_STYLES,
        },
        gift_suitability_min: {
          type: 'number',
          description: SEARCH_TOOL_GIFT_SUITABILITY_MIN_DESCRIPTION,
          minimum: 0,
          maximum: 1,
        },
        beginner_suitability_min: {
          type: 'number',
          description: SEARCH_TOOL_BEGINNER_SUITABILITY_MIN_DESCRIPTION,
          minimum: 0,
          maximum: 1,
        },
        producer_prestige_min: {
          type: 'number',
          description: SEARCH_TOOL_PRODUCER_PRESTIGE_MIN_DESCRIPTION,
          minimum: 0,
          maximum: 1,
        },
        popularity_min: {
          type: 'number',
          description: SEARCH_TOOL_POPULARITY_MIN_DESCRIPTION,
          minimum: 0,
          maximum: 1,
        },
        recipient_profile: {
          type: 'string',
          enum: [...RECIPIENT_PROFILE_VALUES],
          description: SEARCH_TOOL_RECIPIENT_PROFILE_DESCRIPTION,
        },
        sweetness_min: {
          type: 'number',
          description: SEARCH_TOOL_SWEETNESS_MIN_DESCRIPTION,
          minimum: FOOD_PAIRING_SWEETNESS_TARGET_MIN,
          maximum: FOOD_PAIRING_SWEETNESS_TARGET_MAX,
        },
        sweetness_max: {
          type: 'number',
          description: SEARCH_TOOL_SWEETNESS_MAX_DESCRIPTION,
          minimum: FOOD_PAIRING_SWEETNESS_TARGET_MIN,
          maximum: FOOD_PAIRING_SWEETNESS_TARGET_MAX,
        },
        acidity_min: {
          type: 'number',
          description: SEARCH_TOOL_ACIDITY_MIN_DESCRIPTION,
          minimum: FOOD_PAIRING_SWEETNESS_TARGET_MIN,
          maximum: FOOD_PAIRING_SWEETNESS_TARGET_MAX,
        },
        acidity_max: {
          type: 'number',
          description: SEARCH_TOOL_ACIDITY_MAX_DESCRIPTION,
          minimum: FOOD_PAIRING_SWEETNESS_TARGET_MIN,
          maximum: FOOD_PAIRING_SWEETNESS_TARGET_MAX,
        },
        tannin_max: {
          type: 'number',
          description: SEARCH_TOOL_TANNIN_MAX_DESCRIPTION,
          minimum: FOOD_PAIRING_SWEETNESS_TARGET_MIN,
          maximum: FOOD_PAIRING_SWEETNESS_TARGET_MAX,
        },
        drinking_window: {
          type: 'string',
          enum: [...SEARCH_TOOL_DRINKING_WINDOW_VALUES],
          description: SEARCH_TOOL_DRINKING_WINDOW_DESCRIPTION,
        },
        drinking_window_target_year: {
          type: 'number',
          description: SEARCH_TOOL_DRINKING_WINDOW_TARGET_YEAR_DESCRIPTION,
          minimum: SEARCH_TOOL_VINTAGE_MIN,
          maximum: SEARCH_TOOL_VINTAGE_MAX,
        },
      },
      required: ['query_a', 'query_b'],
    },
  },
] as const satisfies readonly ClaudeToolDefinition[];
