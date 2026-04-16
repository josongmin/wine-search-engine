/**
 * Epic 17.2: Claude Tool Schemas for Wine Search Engine
 *
 * Defines 4 wine-specific tools in Claude API format:
 * 1. search_wines - Query wine inventory with mode selection
 * 2. get_food_pairings - Find wines that pair with foods
 * 3. check_drinking_window - Predict wine drinkability
 * 4. compare_wines - Compare two wines side-by-side
 */

import { z } from 'zod';
import {
  COMPARE_WINES_QUERY_A_DESCRIPTION,
  COMPARE_WINES_QUERY_B_DESCRIPTION,
  COMPARE_WINES_TOOL_DESCRIPTION,
  DRINKING_WINDOW_ENTITY_ID_DESCRIPTION,
  DRINKING_WINDOW_TARGET_YEAR_DESCRIPTION,
  DRINKING_WINDOW_TOOL_DESCRIPTION,
  FOOD_PAIRING_COLORS,
  FOOD_PAIRING_FOOD_DESCRIPTION,
  FOOD_PAIRING_MAX_PRICE_KRW_DESCRIPTION,
  FOOD_PAIRING_MAX_PRICE_USD_DESCRIPTION,
  FOOD_PAIRINGS_TOOL_DESCRIPTION,
  SEARCH_TOOL_APPELLATION_DESCRIPTION,
  SEARCH_TOOL_CERTIFICATION_DESCRIPTION,
  SEARCH_TOOL_COUNTRY_DESCRIPTION,
  SEARCH_TOOL_DESCRIPTION,
  SEARCH_TOOL_EXCLUDE_GRAPES_DESCRIPTION,
  SEARCH_TOOL_EXCLUDE_REGIONS_DESCRIPTION,
  SEARCH_TOOL_LIMIT_DESCRIPTION,
  SEARCH_TOOL_MAX_EXCLUDE_FILTERS,
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

export const ClaudeToolInputSchemaPropertySchema = z.union([
  ClaudeToolStringPropertySchema,
  ClaudeToolNumberPropertySchema,
  ClaudeToolBooleanPropertySchema,
  ClaudeToolStringArrayPropertySchema,
]);

export const ClaudeToolInputSchemaSchema = z.object({
  type: z.literal('object'),
  properties: z.record(ClaudeToolInputSchemaPropertySchema),
  required: z.array(z.string().min(1)),
}).strict();

export const ClaudeToolDefinitionSchema = z.object({
  name: ClaudeToolNameSchema,
  description: z.string().min(1),
  input_schema: ClaudeToolInputSchemaSchema,
}).strict();

export type ClaudeToolDefinition = z.infer<typeof ClaudeToolDefinitionSchema>;

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
}).strict();

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
        max_price_krw: {
          type: 'number',
          description: SEARCH_TOOL_MAX_PRICE_KRW_DESCRIPTION,
          minimum: 1,
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
      },
      required: ['query_a', 'query_b'],
    },
  },
] as const satisfies readonly ClaudeToolDefinition[];
