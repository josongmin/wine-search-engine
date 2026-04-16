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
interface ClaudeToolDefinition {
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
        exclude_grapes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional grape varieties to exclude via exact index-level NOT filters.',
          maxItems: 10,
        },
        exclude_regions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional countries or regions to exclude via exact index-level NOT filters.',
          maxItems: 10,
        },
        max_price_krw: {
          type: 'number',
          description: 'Optional maximum price in KRW (e.g. 50000 for 5만원).',
          minimum: 1,
        },
        wine_type: {
          type: 'string',
          enum: ['red', 'white', 'rosé', 'sparkling', 'fortified', 'dessert', 'orange', 'natural'],
          description: 'Optional exact wine-type constraint.',
        },
        country: {
          type: 'string',
          description: 'Optional exact country constraint using English canonical country names.',
        },
        vintage_min: {
          type: 'number',
          description: 'Optional minimum vintage year (inclusive).',
          minimum: 1600,
          maximum: 2100,
        },
        vintage_max: {
          type: 'number',
          description: 'Optional maximum vintage year (inclusive).',
          minimum: 1600,
          maximum: 2100,
        },
        appellation: {
          type: 'string',
          description: 'Optional exact appellation constraint.',
        },
        style: {
          type: 'string',
          description: 'Optional semantic style hint. Preserve user meaning losslessly; examples: dry, sweet, oaked, light, chillable, screw_cap, approachable, crowd_pleasing.',
        },
        styles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional multiple semantic style hints. Use when the query carries more than one style meaning at once, e.g. ["approachable","crowd_pleasing"].',
          maxItems: 5,
        },
        certification: {
          type: 'string',
          description: 'Optional certification hint such as organic or biodynamic.',
        },
        want_diversity: {
          type: 'boolean',
          description: 'When true, prefer varied grapes, regions, or styles rather than near-duplicates.',
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
        max_price_krw: {
          type: 'number',
          description: 'Optional maximum wine price in KRW (preferred over USD).',
          minimum: 1,
        },
        color: {
          type: 'string',
          enum: ['red', 'white', 'rosé', 'sparkling', 'both'],
          description: 'Optional wine color filter. Use "both" when red and white are both acceptable.',
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
