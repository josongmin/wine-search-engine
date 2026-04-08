/**
 * Epic 17.2: Wine Tool Executor
 *
 * Type-safe executor for Claude tool calls. Dispatches calls to appropriate
 * use cases with validated input and proper requestId propagation.
 */

import { z } from 'zod';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import type { DrinkingWindowUseCasePort } from '../../application/drinking-window/port/drinking-window-usecase.port.js';
import type { DecomposedSearchUseCasePort } from '../../application/search/port/search-route-usecases.port.js';
import type { SearchExecutorPort } from '../../application/search/port/search-executor.port.js';
import type { SearchRequest } from '../../application/search/search-request.dto.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../domain/response/model/comparison-response.js';
import type { DrinkingWindowBlock } from '../../domain/response/model/result-item.js';
import { createEntityId, type EntityId } from '../../domain/shared/types/index.js';
import type { RetrievalDocument } from '../../domain/retrieval/model/retrieval-document.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { SearchResponseV2Machine } from '../../domain/response/model/result-item-v2.js';
import { buildMachineResponseV2 } from '../../domain/response/service/machine-response-builder-v2.js';

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

const toolLog = bootstrapLogger.child({ component: 'WineToolExecutor' });

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
 * T6.3: Options for machine V2 response format migration seam.
 *
 * When useV2MachineFormat is true, the executor returns a
 * SearchResponseV2Machine envelope (structured provenance/evidence)
 * instead of the V1 format. The caller must supply rankedResults —
 * the pre-ranked result list from the search pipeline — so the V2 builder
 * can access ComponentScores and retrievalProvenance that are not present
 * in the V1 ResultItem model.
 *
 * queryId identifies the query for the V2 envelope (defaults to requestId).
 */
export interface ToolExecutionV2Options {
  /** When true, format search_wines results as SearchResponseV2Machine. */
  readonly useV2MachineFormat: true;
  /** Pre-ranked results from the search pipeline. */
  readonly rankedResults: readonly RankedResult[];
  /** Query identifier for the V2 envelope. Falls back to requestId when omitted. */
  readonly queryId?: string | undefined;
}

/**
 * Dependencies for WineToolExecutor.
 */
/**
 * Port for fetching a single entity's document from the search index.
 * Used by check_drinking_window to look up wine attributes by entity_id.
 */
export interface EntityDocumentLookupPort {
  getDocument(entityId: EntityId): Promise<RetrievalDocument | null>;
}

export interface WineToolExecutorDeps {
  /** Main search use case for wine queries */
  readonly searchUseCase: SearchExecutorPort;
  /** Decomposed search for comparison queries */
  readonly decomposedSearchUseCase: DecomposedSearchUseCasePort;
  /** Drinking window predictor */
  readonly drinkingWindowUseCase: DrinkingWindowUseCasePort;
  /** Entity lookup for drinking window tool (optional — degrades gracefully) */
  readonly entityLookup?: EntityDocumentLookupPort | undefined;
}

/**
 * Tool executor for wine search engine.
 *
 * Dispatches Claude tool calls to appropriate use cases:
 * - search_wines -> SearchUseCase.execute(request, requestId)
 * - get_food_pairings -> SearchUseCase with dynamic query
 * - check_drinking_window -> DrinkingWindowUseCase.check()
 * - compare_wines -> DecomposedSearchUseCase.execute([queryA, queryB], 'compare', ...)
 *
 * All operations propagate requestId for request tracking.
 *
 * T6.3: The execute method accepts an optional ToolExecutionV2Options argument.
 * When useV2MachineFormat: true, the search_wines result is projected to
 * SearchResponseV2Machine via buildMachineResponseV2. V1 behaviour is
 * unchanged when the option is absent.
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
   * @param v2Options - Optional V2 machine format migration seam (T6.3)
   * @returns Tool result
   * @throws ZodError if input validation fails
   * @throws Error if tool execution fails
   */
  async execute(
    toolName: string,
    input: unknown,
    requestId: string,
    v2Options?: ToolExecutionV2Options,
  ): Promise<SearchResponseV1 | SearchResponseV2Machine | ComparisonSearchResponse | DrinkingWindowBlock | { error: string }> {
    switch (toolName) {
      case 'search_wines': {
        // T6.3: When useV2MachineFormat is explicitly true, bypass the V1
        // use case and build the V2 machine response directly from the
        // caller-supplied ranked results. V1 path is unchanged otherwise.
        // Guard on the flag value itself (not just presence) so an accidental
        // falsy v2Options does not silently fall through to V2 projection.
        if (v2Options !== undefined) {
          // Always validate the raw input even on the V2 path so that
          // malformed query metadata is rejected, not silently dropped.
          const validation = SearchToolInputSchema.safeParse(input);
          if (!validation.success) {
            return { error: `Invalid input for search_wines: ${validation.error.issues.map((i) => i.message).join(', ')}` };
          }
          const queryId = v2Options.queryId ?? requestId;
          return buildMachineResponseV2({
            queryId,
            results: v2Options.rankedResults,
          });
        }
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
  private async executeSearchWines(input: unknown, requestId: string): Promise<SearchResponseV1 | ComparisonSearchResponse> {
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
  private async executeFoodPairings(input: unknown, requestId: string): Promise<SearchResponseV1 | ComparisonSearchResponse> {
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
  private async executeDrinkingWindow(
    input: unknown,
    requestId: string,
  ): Promise<DrinkingWindowBlock | { error: string }> {
    const validated = DrinkingWindowInputSchema.parse(input);
    const targetYear = validated.target_year ?? new Date().getFullYear();

    if (!this.deps.entityLookup) {
      return { error: 'Entity lookup not available. Use search_wines first to get drinking window from results.' };
    }

    const entityId = createEntityId(validated.entity_id);
    const doc = await this.deps.entityLookup.getDocument(entityId);

    if (!doc) {
      return { error: `Entity ${validated.entity_id} not found in search index.` };
    }

    if (!doc.vintageYear) {
      return { error: `Entity ${validated.entity_id} has no vintage year — cannot predict drinking window.` };
    }

    toolLog.debug(
      {
        entityId: validated.entity_id,
        vintage: doc.vintageYear,
        targetYear,
        requestId,
      },
      'check_drinking_window',
    );

    const tannin01 = doc.tannin !== undefined ? doc.tannin : 0.5;
    const acidity01 = doc.acidity !== undefined ? doc.acidity : 0.5;
    const critic01 = doc.criticScoreNormalized !== undefined ? doc.criticScoreNormalized : 0.85;

    return this.deps.drinkingWindowUseCase.check({
      vintage: doc.vintageYear,
      grapePrimaryEnc: 0,
      regionEnc: 0,
      countryEnc: 0,
      body: doc.body,
      tannin: tannin01 * 5,
      acidity: acidity01 * 5,
      sweetness: doc.sweetness,
      avgCriticProxyScore: critic01 * 100,
      targetYear,
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
