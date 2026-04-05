/**
 * Epic 17.2: Claude Tool Schemas for Wine Search Engine
 *
 * Defines 4 wine-specific tools in Claude API format:
 * 1. search_wines - Query wine inventory with mode selection
 * 2. get_food_pairings - Find wines that pair with foods
 * 3. check_drinking_window - Predict wine drinkability
 * 4. compare_wines - Compare two wines side-by-side
 */

/**
 * Tool definition for Claude API's tools parameter.
 * Each tool includes name, description, and input_schema (JSON Schema).
 */
export interface ClaudeToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input_schema: {
    readonly type: 'object';
    readonly properties: Record<string, unknown>;
    readonly required: readonly string[];
  };
}

/**
 * WINE_SEARCH_TOOLS: 4 wine-specific tools for Claude integration.
 *
 * Format: Claude API tools parameter specification (compatible with
 * claude-3-5-sonnet and later models).
 */
export const WINE_SEARCH_TOOLS: readonly ClaudeToolDefinition[] = [
  {
    name: 'search_wines',
    description:
      'Search for wines by query. Returns matching wines with scores, attributes, and drinking windows.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Wine search query (e.g., "Bordeaux under $50", "Pinot Noir 2020", "dry red wine")',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (1-50, default: 10)',
          minimum: 1,
          maximum: 50,
        },
        retrieval_mode: {
          type: 'string',
          enum: ['auto', 'entity', 'hybrid', 'mixed'],
          description:
            'Search mode: auto (planner decides), entity (exact entity matching), hybrid (semantic+lexical), mixed (advanced reasoning)',
        },
      },
      required: ['query'],
    },
  },

  {
    name: 'get_food_pairings',
    description:
      'Find wines that pair well with a specific food. Optionally filter by price and wine color.',
    input_schema: {
      type: 'object' as const,
      properties: {
        food: {
          type: 'string',
          description: 'Food item or dish (e.g., "grilled salmon", "pasta carbonara", "cheese platter")',
        },
        max_price: {
          type: 'number',
          description: 'Optional maximum wine price in USD (e.g., 50)',
        },
        color: {
          type: 'string',
          enum: ['red', 'white', 'rosé', 'sparkling'],
          description: 'Optional wine color filter',
        },
      },
      required: ['food'],
    },
  },

  {
    name: 'check_drinking_window',
    description:
      'Check if a wine is currently drinkable or predict its drinking window based on vintage and attributes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        entity_id: {
          type: 'string',
          description: 'Wine entity ID (from previous search results)',
        },
        target_year: {
          type: 'number',
          description:
            'Optional year to check drinkability for (defaults to current year). Use for age predictions (e.g., 2030).',
        },
      },
      required: ['entity_id'],
    },
  },

  {
    name: 'compare_wines',
    description: 'Compare two wines side-by-side with rankings and attributes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query_a: {
          type: 'string',
          description: 'First wine query (e.g., "Château Margaux 2015")',
        },
        query_b: {
          type: 'string',
          description: 'Second wine query (e.g., "Caymus Cabernet 2018")',
        },
      },
      required: ['query_a', 'query_b'],
    },
  },
] as const;
