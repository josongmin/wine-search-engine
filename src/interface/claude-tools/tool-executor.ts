/**
 * Epic 17.2: Wine Tool Executor
 *
 * Type-safe executor for Claude tool calls. Dispatches calls to appropriate
 * use cases with validated input and proper requestId propagation.
 */

import { z } from 'zod';
import type { SearchUseCase, SearchRequest } from '../../application/search/search.usecase.js';
import type { DecomposedSearchUseCase } from '../../application/search/decomposed-search.usecase.js';
import type { DrinkingWindowUseCase } from '../../application/drinking-window/drinking-window.usecase.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../domain/response/model/comparison-response.js';
import type { DrinkingWindowBlock } from '../../domain/response/model/result-item.js';

/**
 * Zod schema for search_wines tool input.
 * Validates: query (required, string), limit (1-50), retrieval_mode (auto/entity/hybrid/mixed)
 */
const SearchToolInputSchema = z.object({
  query: z.string().min(1, 'Query must not be empty'),
  limit: z.number().int().min(1).max(50).optional().default(10),
  retrieval_mode: z.enum(['auto', 'entity', 'hybrid', 'mixed']).optional().default('auto'),
});

export type SearchToolInput = z.infer<typeof SearchToolInputSchema>;

/**
 * Zod schema for get_food_pairings tool input.
 * Validates: food (required), max_price (optional), color (optional)
 */
const FoodPairingInputSchema = z.object({
  food: z.string().min(1, 'Food must not be empty'),
  max_price: z.number().positive().optional(),
  color: z.enum(['red', 'white', 'rosé', 'sparkling']).optional(),
});

export type FoodPairingInput = z.infer<typeof FoodPairingInputSchema>;

/**
 * Zod schema for check_drinking_window tool input.
 * Validates: entity_id (required), target_year (optional, defaults to current year)
 */
const DrinkingWindowInputSchema = z.object({
  entity_id: z.string().min(1, 'Entity ID must not be empty'),
  target_year: z.number().int().min(1900).max(2100).optional(),
});

export type DrinkingWindowInput = z.infer<typeof DrinkingWindowInputSchema>;

/**
 * Zod schema for compare_wines tool input.
 * Validates: query_a and query_b (both required, non-empty)
 */
const CompareWinesInputSchema = z.object({
  query_a: z.string().min(1, 'Query A must not be empty'),
  query_b: z.string().min(1, 'Query B must not be empty'),
});

export type CompareWinesInput = z.infer<typeof CompareWinesInputSchema>;

/**
 * Union of all tool inputs for type-safe dispatch.
 */
export type WineToolInput =
  | ({ toolName: 'search_wines' } & SearchToolInput)
  | ({ toolName: 'get_food_pairings' } & FoodPairingInput)
  | ({ toolName: 'check_drinking_window' } & DrinkingWindowInput)
  | ({ toolName: 'compare_wines' } & CompareWinesInput);

/**
 * Dependencies for WineToolExecutor.
 */
export interface WineToolExecutorDeps {
  /** Main search use case for wine queries */
  readonly searchUseCase: SearchUseCase;
  /** Decomposed search for comparison queries */
  readonly decomposedSearchUseCase: DecomposedSearchUseCase;
  /** Drinking window predictor */
  readonly drinkingWindowUseCase: DrinkingWindowUseCase;
}

/**
 * Tool executor for wine search engine.
 *
 * Dispatches Claude tool calls to appropriate use cases:
 * - search_wines → SearchUseCase.execute(request, requestId)
 * - get_food_pairings → SearchUseCase with dynamic query
 * - check_drinking_window → DrinkingWindowUseCase.check()
 * - compare_wines → DecomposedSearchUseCase.execute([queryA, queryB], 'compare', ...)
 *
 * All operations propagate requestId for request tracking.
 */
export class WineToolExecutor {
  constructor(private readonly deps: WineToolExecutorDeps) {}

  /**
   * Execute a tool call with validated input.
   *
   * Dispatches to the appropriate use case based on toolName.
   * Input is validated using Zod schemas before execution.
   *
   * @param toolName - Name of the tool to execute
   * @param input - Raw input (will be validated against schema)
   * @param requestId - Parent request ID for tracking
   * @returns Tool result (SearchResponseV1, ComparisonSearchResponse, or DrinkingWindowBlock)
   * @throws ZodError if input validation fails
   * @throws Error if tool execution fails
   */
  async execute(
    toolName: string,
    input: unknown,
    requestId: string,
  ): Promise<SearchResponseV1 | ComparisonSearchResponse | DrinkingWindowBlock | { error: string }> {
    switch (toolName) {
      case 'search_wines': {
        return this.executeSearchWines(input, requestId);
      }

      case 'get_food_pairings': {
        return this.executeFoodPairings(input, requestId);
      }

      case 'check_drinking_window': {
        return this.executeDrinkingWindow(input, requestId);
      }

      case 'compare_wines': {
        return this.executeCompareWines(input, requestId);
      }

      default: {
        return { error: `Unknown tool: ${toolName}` };
      }
    }
  }

  /**
   * Execute search_wines tool.
   *
   * Calls SearchUseCase.execute() with validated input.
   * CRITICAL: Always passes requestId as 2nd argument.
   *
   * @param input - Raw input (validated against SearchToolInputSchema)
   * @param requestId - Parent request ID
   * @returns SearchResponseV1
   */
  private async executeSearchWines(input: unknown, requestId: string): Promise<SearchResponseV1> {
    const validated = SearchToolInputSchema.parse(input);

    const request: SearchRequest = {
      query: validated.query,
      options: {
        mode: validated.retrieval_mode,
        explain: false,
        clarification: false,
      },
    };

    return this.deps.searchUseCase.execute(request, requestId);
  }

  /**
   * Execute get_food_pairings tool.
   *
   * Transforms food + optional filters into a search query,
   * then calls SearchUseCase.execute().
   *
   * Query format: "wine pairing for [food]" + optional color + price filters
   *
   * @param input - Raw input (validated against FoodPairingInputSchema)
   * @param requestId - Parent request ID
   * @returns SearchResponseV1 with paired wines
   */
  private async executeFoodPairings(input: unknown, requestId: string): Promise<SearchResponseV1> {
    const validated = FoodPairingInputSchema.parse(input);

    // Build dynamic query from food + optional color + price
    let query = `wine pairing for ${validated.food}`;
    if (validated.color) {
      query += ` ${validated.color} wine`;
    }
    if (validated.max_price !== undefined) {
      query += ` under $${validated.max_price}`;
    }

    const request: SearchRequest = {
      query,
      options: {
        mode: 'auto',
        explain: false,
        clarification: false,
      },
    };

    return this.deps.searchUseCase.execute(request, requestId);
  }

  /**
   * Execute check_drinking_window tool.
   *
   * Calls DrinkingWindowUseCase.check() with entity attributes.
   *
   * NOTE: This is a simplified version that returns a drinking window block.
   * In a full implementation, we'd fetch the entity from the search index
   * first to get its vintage and attributes, then check drinkability.
   *
   * For now, we return a placeholder that indicates entity_id-based lookup
   * would be needed.
   *
   * @param input - Raw input (validated against DrinkingWindowInputSchema)
   * @param requestId - Parent request ID
   * @returns DrinkingWindowBlock (or error if entity not found)
   */
  private executeDrinkingWindow(
    input: unknown,
    requestId: string,
  ): Promise<DrinkingWindowBlock | { error: string }> {
    const validated = DrinkingWindowInputSchema.parse(input);
    const targetYear = validated.target_year ?? new Date().getFullYear();

    // In a full implementation, fetch entity from search index using entity_id
    // For now, return a placeholder error indicating this requires entity context
    console.warn(
      `[WineToolExecutor] check_drinking_window: entity_id=${validated.entity_id}, target_year=${targetYear}, requestId=${requestId}`,
    );

    return Promise.resolve({
      error: `Entity lookup for ${validated.entity_id} not yet implemented in tool executor. Use search_wines to get entity_id from results first.`,
    });
  }

  /**
   * Execute compare_wines tool.
   *
   * Calls DecomposedSearchUseCase.execute() with [query_a, query_b].
   * Sets comparisonIntent to 'compare' and uses current time as startTime.
   *
   * @param input - Raw input (validated against CompareWinesInputSchema)
   * @param requestId - Parent request ID
   * @returns ComparisonSearchResponse
   */
  private async executeCompareWines(input: unknown, requestId: string): Promise<ComparisonSearchResponse> {
    const validated = CompareWinesInputSchema.parse(input);
    const startTime = Date.now();

    return this.deps.decomposedSearchUseCase.execute(
      [validated.query_a, validated.query_b],
      'compare',
      `${validated.query_a} vs ${validated.query_b}`,
      requestId,
      startTime,
    );
  }
}
