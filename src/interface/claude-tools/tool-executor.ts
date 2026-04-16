/**
 * Epic 17.2: Wine Tool Executor
 *
 * Type-safe executor for Claude tool calls. Dispatches calls to appropriate
 * use cases with validated input and proper requestId propagation.
 */

import { z } from 'zod';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import type { DrinkingWindowUseCasePort } from '../../application/drinking-window/port/drinking-window-usecase.port.js';
import { DRINKING_WINDOW_SENSORY_ORDINAL_SCALE } from '../../domain/drinking-window/port/drinking-window-predictor.port.js';
import type { DecomposedSearchUseCasePort } from '../../application/search/port/search-route-usecases.port.js';
import type { SearchExecutorPort } from '../../application/search/port/search-executor.port.js';
import type { SearchRequest } from '../../application/search/search-request.dto.js';
import {
  sanitizeOptionalToolNulls,
} from '../../application/search/search-tool-contract.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../domain/response/model/comparison-response.js';
import type { DrinkingWindowBlock } from '../../domain/response/model/result-item.js';
import { createCanonicalEntityId, type CanonicalEntityId } from '../../domain/shared/types/index.js';
import type { RetrievalDocument } from '../../domain/retrieval/model/retrieval-document.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { SearchResponseV2Machine } from '../../domain/response/model/result-item-v2.js';
import { buildMachineResponseV2 } from '../../domain/response/service/machine-response-builder-v2.js';
import {
  buildFoodPairingColorClause,
  resolveFoodPairingBudgetKrw,
} from '../../application/search/food-pairing-tool-policy.js';
import {
  appendStructuredQueryClauses,
  buildSearchToolSoftClauses,
} from '../../application/search/search-tool-query-policy.js';
import { buildSearchToolRetrievalCoreQuery } from '../../application/search/search-tool-retrieval-core.js';
import {
  applySearchToolBudgetResultPolicy,
  applySearchToolNegationResultPolicy,
  collectSearchToolNegationTerms,
} from '../../application/search/search-tool-result-policy.js';
import {
  KRW_PER_USD_APPROXIMATE,
} from '../../domain/shared/constants.js';
import {
  SEARCH_TOOL_DIVERSITY_LIMIT_PER_TYPE,
  SEARCH_TOOL_DIVERSITY_MIN_LIMIT,
  SEARCH_TOOL_WANTS_DIVERSITY_RE,
  executeSearchWithTypedWineDiversityDiscovery,
  shouldRunTypedWineDiversityDiscovery,
  withWineTypeFilter,
} from '../../application/search/search-tool-diversity.js';
import {
  CompareWinesInputSchema,
  DrinkingWindowInputSchema,
  FoodPairingInputSchema,
  SearchToolInputSchema,
} from './tool-schemas.js';
import type { NormalizedConstraint } from '../../domain/shared/types/index.js';

/** criticScoreNormalized is 0–1; predictor wants 0–100 proxy points. */
const DRINKING_WINDOW_CRITIC_PROXY_PERCENT_SCALE = 100;
const CLAUDE_TOOL_FILTER_MAPPING_VERSION = 'claude_tool_v1' as const;
const CLAUDE_TOOL_DIVERSITY_MAPPING_VERSION = 'claude_tool_diversity_v1' as const;

type SearchToolInput = z.infer<typeof SearchToolInputSchema>;

const toolLog = bootstrapLogger.child({ component: 'WineToolExecutor' });

function formatValidationError(toolName: string, error: z.ZodError): { error: string } {
  return {
    error: `Invalid input for ${toolName}: ${error.issues.map((issue) => issue.message).join(', ')}`,
  };
}

function parseToolInput<T extends z.ZodTypeAny>(
  toolName: string,
  schema: T,
  input: unknown,
): { success: true; data: z.output<T> } | { success: false; result: { error: string } } {
  const validation = schema.safeParse(sanitizeOptionalToolNulls(input));
  if (!validation.success) {
    return {
      success: false,
      result: formatValidationError(toolName, validation.error),
    };
  }
  return {
    success: true,
    data: validation.data,
  };
}

function pushSearchToolStructuredFilter(
  filters: NormalizedConstraint[],
  attribute: string,
  operator: NormalizedConstraint['operator'],
  value: NormalizedConstraint['value'],
  sourcePhrase: string,
): void {
  filters.push({
    attribute,
    operator,
    value,
    source_phrase: sourcePhrase,
    confidence: 1.0,
    mapping_version: CLAUDE_TOOL_FILTER_MAPPING_VERSION,
  });
}

function buildSearchToolStructuredFilters(input: SearchToolInput): readonly NormalizedConstraint[] {
  const filters: NormalizedConstraint[] = [];

  for (const grape of input.exclude_grapes ?? []) {
    pushSearchToolStructuredFilter(filters, 'grape_primary', 'exclude', grape, grape);
  }
  for (const region of input.exclude_regions ?? []) {
    pushSearchToolStructuredFilter(filters, 'region', 'exclude', region, region);
  }
  if (input.wine_type !== undefined) {
    pushSearchToolStructuredFilter(filters, 'wine_type', '=', input.wine_type, input.wine_type);
  }
  if (input.country !== undefined) {
    pushSearchToolStructuredFilter(filters, 'country', '=', input.country, input.country);
  }
  if (input.vintage_min !== undefined) {
    pushSearchToolStructuredFilter(filters, 'vintage_year', '>=', input.vintage_min, `${input.vintage_min}년 이후`);
  }
  if (input.vintage_max !== undefined) {
    pushSearchToolStructuredFilter(filters, 'vintage_year', '<=', input.vintage_max, `${input.vintage_max}년 이전`);
  }
  if (input.appellation !== undefined) {
    pushSearchToolStructuredFilter(filters, 'appellation', '=', input.appellation, input.appellation);
  }

  return filters;
}

function buildSearchToolQuery(input: SearchToolInput): string {
  const clauses = buildSearchToolSoftClauses(input);
  const retrievalCoreQuery = buildSearchToolRetrievalCoreQuery(input);
  if (clauses.length === 0) {
    return retrievalCoreQuery;
  }
  return appendStructuredQueryClauses(retrievalCoreQuery, clauses);
}

function buildSearchToolRequest(input: SearchToolInput): SearchRequest {
  const filters = buildSearchToolStructuredFilters(input);
  const limit = input.limit ?? 10;
  const retrievalMode = input.retrieval_mode ?? 'auto';
  return {
    query: buildSearchToolQuery(input),
    limit,
    options: {
      mode: retrievalMode,
      explain: false,
      clarification: false,
    },
    ...(filters.length > 0 ? { filters } : {}),
  };
}

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
interface EntityDocumentLookupPort {
  getDocument(entityId: CanonicalEntityId): Promise<RetrievalDocument | null>;
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
   * Input is validated using Zod schemas before execution. Validation failures
   * are returned as in-band `{ error }` tool results so HTTP/adapter callers
   * keep a single success-shaped tool envelope instead of mixing throw vs return.
   *
   * @param toolName - Name of the tool to execute
   * @param input - Raw input (will be validated against schema)
   * @param requestId - Parent request ID for tracking
   * @param v2Options - Optional V2 machine format migration seam (T6.3)
   * @returns Tool result
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
          const validation = parseToolInput('search_wines', SearchToolInputSchema, input);
          if (!validation.success) {
            return validation.result;
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
   * @returns SearchResponseV1 or an in-band `{ error }` tool result on validation failure
   */
  private async executeSearchWines(input: unknown, requestId: string): Promise<SearchResponseV1 | ComparisonSearchResponse | { error: string }> {
    const validation = parseToolInput('search_wines', SearchToolInputSchema, input);
    if (!validation.success) {
      return validation.result;
    }
    const validated = validation.data;
    const normalizedLimit = validated.limit ?? 10;
    const wantsDiversity =
      validated.want_diversity === true || SEARCH_TOOL_WANTS_DIVERSITY_RE.test(validated.query);
    const effectiveLimit = wantsDiversity
      ? Math.max(normalizedLimit, SEARCH_TOOL_DIVERSITY_MIN_LIMIT)
      : normalizedLimit;
    const structuredFilters = buildSearchToolStructuredFilters(validated);
    const fallbackRequest = buildSearchToolRequest({
      ...validated,
      limit: effectiveLimit,
    });

    const response = await executeSearchWithTypedWineDiversityDiscovery({
      searchUseCase: this.deps.searchUseCase,
      requestId,
      fallbackRequest,
      effectiveLimit,
      shouldRun: shouldRunTypedWineDiversityDiscovery({
        query: validated.query,
        wantsDiversity,
        wineType: validated.wine_type,
      }),
      buildTypedRequest: (wineType) => ({
        ...fallbackRequest,
        limit: SEARCH_TOOL_DIVERSITY_LIMIT_PER_TYPE,
        filters: withWineTypeFilter(
          structuredFilters,
          wineType,
          CLAUDE_TOOL_DIVERSITY_MAPPING_VERSION,
        ),
      }),
    });
    if (response.queryType !== 'search') {
      return response;
    }
    const negationFiltered = applySearchToolNegationResultPolicy(
      response,
      collectSearchToolNegationTerms(validated),
    );
    return applySearchToolBudgetResultPolicy(
      negationFiltered.response,
      validated.max_price_krw,
      { krwPerUsd: KRW_PER_USD_APPROXIMATE },
    ).response;
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
   * @returns SearchResponseV1 with paired wines, or an in-band `{ error }` result on validation failure
   */
  private async executeFoodPairings(input: unknown, requestId: string): Promise<SearchResponseV1 | ComparisonSearchResponse | { error: string }> {
    const validation = parseToolInput('get_food_pairings', FoodPairingInputSchema, input);
    if (!validation.success) {
      return validation.result;
    }
    const validated = validation.data;

    const budgetKrw = resolveFoodPairingBudgetKrw(validated, {
      krwPerUsd: KRW_PER_USD_APPROXIMATE,
      maxPriceKrwCap: Number.MAX_SAFE_INTEGER,
    });
    const query = appendStructuredQueryClauses(
      `wines for ${validated.food}${buildFoodPairingColorClause(validated)}`,
      budgetKrw !== undefined ? [`${budgetKrw}원 이하`] : [],
    );

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
   * Calls DrinkingWindowUseCase.check() with entity attributes pulled from
   * the search index. Refuses to call the predictor with hardcoded defaults
   * — every required ML feature must come from the indexed document.
   *
   * @param input - Raw input (validated against DrinkingWindowInputSchema)
   * @param requestId - Parent request ID
   * @returns DrinkingWindowBlock (or error if entity not found / incomplete)
   */
  private async executeDrinkingWindow(
    input: unknown,
    requestId: string,
  ): Promise<DrinkingWindowBlock | { error: string }> {
    const validation = parseToolInput('check_drinking_window', DrinkingWindowInputSchema, input);
    if (!validation.success) {
      return validation.result;
    }
    const validated = validation.data;
    const targetYear = validated.target_year ?? new Date().getFullYear();

    if (!this.deps.entityLookup) {
      return { error: 'Entity lookup not available. Use search_wines first to get drinking window from results.' };
    }

    const entityId = createCanonicalEntityId(validated.entity_id);
    const doc = await this.deps.entityLookup.getDocument(entityId);

    if (!doc) {
      return { error: `Entity ${validated.entity_id} not found in search index.` };
    }

    if (!doc.vintageYear) {
      return { error: `Entity ${validated.entity_id} has no vintage year — cannot predict drinking window.` };
    }

    // Strict feature gating: refuse to call the predictor with fabricated
    // defaults. The previous implementation passed hardcoded 0.5/0.85 and
    // zero encodings, which fed garbage to the ONNX model and produced
    // misleading "predictions".
    const missing: string[] = [];
    if (doc.tannin === undefined) missing.push('tannin');
    if (doc.acidity === undefined) missing.push('acidity');
    if (doc.criticScoreNormalized === undefined) missing.push('criticScoreNormalized');
    if (doc.grapePrimaryEnc === undefined) missing.push('grapePrimaryEnc');
    if (doc.regionEnc === undefined) missing.push('regionEnc');
    if (doc.countryEnc === undefined) missing.push('countryEnc');
    if (missing.length > 0) {
      return {
        error:
          `Entity ${validated.entity_id} is missing ML features required for drinking-window prediction: ${missing.join(', ')}. ` +
          `Reindex the entity or use search_wines for a heuristic estimate.`,
      };
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

    return this.deps.drinkingWindowUseCase.check({
      vintage: doc.vintageYear,
      grapePrimaryEnc: doc.grapePrimaryEnc!,
      regionEnc: doc.regionEnc!,
      countryEnc: doc.countryEnc!,
      // body/tannin/acidity/sweetness are stored as [0,1] normalised floats.
      // The predictor expects [1–5 ordinal] scale, so we expand here.
      body: doc.body != null ? doc.body * DRINKING_WINDOW_SENSORY_ORDINAL_SCALE : undefined,
      tannin: doc.tannin! * DRINKING_WINDOW_SENSORY_ORDINAL_SCALE,
      acidity: doc.acidity! * DRINKING_WINDOW_SENSORY_ORDINAL_SCALE,
      sweetness: doc.sweetness != null ? doc.sweetness * DRINKING_WINDOW_SENSORY_ORDINAL_SCALE : undefined,
      // criticScoreNormalized is [0,1]; convert to the [0,100] proxy score
      // expected by the predictor.
      avgCriticProxyScore: doc.criticScoreNormalized! * DRINKING_WINDOW_CRITIC_PROXY_PERCENT_SCALE,
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
   * @returns ComparisonSearchResponse, or an in-band `{ error }` result on validation failure
   */
  private async executeCompareWines(input: unknown, requestId: string): Promise<ComparisonSearchResponse | { error: string }> {
    const validation = parseToolInput('compare_wines', CompareWinesInputSchema, input);
    if (!validation.success) {
      return validation.result;
    }
    const validated = validation.data;
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
