/**
 * Epic 17.2: Wine Tool Executor
 *
 * Type-safe executor for Claude tool calls. Dispatches calls to appropriate
 * use cases with validated input and proper requestId propagation.
 */

import type { z } from 'zod';
import type { SearchExecutorPort, SearchExecutorResult } from '../../application/search/port/search-executor.port.js';
import type { SearchRequest } from '../../application/search/search-request.dto.js';
import type { DecomposedSearchUseCasePort } from '../../application/search/port/search-route-usecases.port.js';
import type { DrinkingWindowUseCasePort } from '../../application/drinking-window/port/drinking-window-usecase.port.js';
import type { EntityDocumentLookupPort } from '../../application/search/port/search-pipeline-deps.port.js';
import {
  buildSearchToolStructuredFilters as buildContractSearchToolStructuredFilters,
  buildSearchToolStructuredPreferences as buildContractSearchToolStructuredPreferences,
  sanitizeOptionalToolNulls,
} from '../../application/search/search-tool-contract.js';
import { normalizeLookupWineInput } from '../../application/search/lookup-wine-execution.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../domain/response/model/comparison-response.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { DrinkingWindowBlock } from '../../domain/response/model/result-item.js';
import type { SearchResponseV2Machine } from '../../interface/http/schemas/search-response-v2.schema.js';
import { buildMachineResponseV2 } from '../../interface/http/response-builders/machine-response-builder-v2.js';
import {
  appendStructuredQueryClauses,
  buildSearchToolSoftClauses,
} from '../../application/search/search-tool-query-policy.js';
import { buildSearchToolRetrievalCoreQuery } from '../../application/search/search-tool-retrieval-core.js';
import {
  applySearchToolAlcoholResultPolicy,
  applySearchToolBudgetResultPolicy,
  applySearchToolNegationResultPolicy,
  collectSearchToolNegationTerms,
} from '../../application/search/search-tool-result-policy.js';
import {
  buildCompareWinesExecutionRequest,
  buildDrinkingWindowRequest,
  buildFoodPairingFilters,
  buildFoodPairingPreferences,
  buildFoodPairingQuery,
} from '../../application/search/tool-execution-support.js';
import { KRW_PER_USD_APPROXIMATE } from '../../domain/shared/constants.js';
import {
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
import {
  createCanonicalEntityId,
  type NormalizedConstraint,
} from '../../domain/shared/types/index.js';

const CLAUDE_TOOL_FILTER_MAPPING_VERSION = 'claude_tool_v1' as const;
const CLAUDE_TOOL_DIVERSITY_MAPPING_VERSION = 'claude_tool_diversity_v1' as const;
const FOOD_PAIRING_RETRIEVAL_MODE = 'hybrid' as const;
const DEFAULT_SEARCH_LIMIT = 10;

type SearchToolInput = z.infer<typeof SearchToolInputSchema>;

type StructuredFilterInput = Parameters<typeof buildContractSearchToolStructuredFilters>[0];
type StructuredPreferenceInput = Parameters<typeof buildContractSearchToolStructuredPreferences>[0];
type SearchToolQueryInput = Parameters<typeof buildSearchToolRetrievalCoreQuery>[0];

function formatValidationError(toolName: string, error: z.ZodError): { error: string } {
  return {
    error: `Invalid input for ${toolName}: ${error.issues.map((issue) => issue.message).join(', ')}`,
  };
}

export type WineToolExecutorResult =
  | SearchResponseV1
  | SearchResponseV2Machine
  | ComparisonSearchResponse
  | DrinkingWindowBlock
  | { error: string };

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
    data: validation.data as z.output<T>,
  };
}

function buildSearchToolStructuredFilters(input: StructuredFilterInput): readonly NormalizedConstraint[] {
  return buildContractSearchToolStructuredFilters(input, CLAUDE_TOOL_FILTER_MAPPING_VERSION);
}

function buildSearchToolStructuredPreferences(input: StructuredPreferenceInput): readonly NormalizedConstraint[] {
  return buildContractSearchToolStructuredPreferences(input, CLAUDE_TOOL_FILTER_MAPPING_VERSION);
}

function buildSearchToolQuery(input: SearchToolQueryInput): string {
  const clauses = buildSearchToolSoftClauses({
    ...input,
    grape_primary: undefined,
  });
  const retrievalCoreQuery = buildSearchToolRetrievalCoreQuery(input);
  if (clauses.length === 0) {
    return retrievalCoreQuery;
  }
  return appendStructuredQueryClauses(retrievalCoreQuery, clauses);
}

function buildSearchToolRequest(input: SearchToolInput): SearchRequest {
  const filters = buildSearchToolStructuredFilters(input);
  const preferences = buildSearchToolStructuredPreferences(input);
  const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
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
    ...(preferences.length > 0 ? { preferences } : {}),
  };
}

function applySearchWinesResultPolicies(
  response: SearchResponseV1,
  input: SearchToolInput,
): SearchResponseV1 {
  const negationFiltered = applySearchToolNegationResultPolicy(
    response,
    collectSearchToolNegationTerms(input),
  );
  const budgetFiltered = applySearchToolBudgetResultPolicy(
    negationFiltered.response,
    {
      minKrw: input.min_price_krw,
      maxKrw: input.max_price_krw,
    },
    { krwPerUsd: KRW_PER_USD_APPROXIMATE },
  ).response;
  return applySearchToolAlcoholResultPolicy(
    budgetFiltered,
    input.max_alcohol_pct,
  ).response;
}

function requireSearchOnlyToolResult(
  toolName: 'search_wines' | 'lookup_wine' | 'get_food_pairings',
  response: SearchExecutorResult,
): SearchResponseV1 | { error: string } {
  if (response.queryType === 'search') {
    return response;
  }
  return {
    error: `${toolName} received a comparison-style response from the search executor. Use compare_wines for comparison queries.`,
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
export interface WineToolExecutorDeps {
  /** Main search use case for wine queries */
  readonly searchUseCase: SearchExecutorPort;
  /** Optional decomposition use case for compare_wines. */
  readonly decomposedSearchUseCase?: DecomposedSearchUseCasePort | undefined;
  /** Optional drinking-window use case for check_drinking_window. */
  readonly drinkingWindowUseCase?: DrinkingWindowUseCasePort | undefined;
  /** Optional entity lookup used to hydrate check_drinking_window priors. */
  readonly entityLookup?: EntityDocumentLookupPort | undefined;
}

/**
 * Tool executor for wine search engine.
 *
 * Dispatches Claude tool calls to the wine search use case.
 */
export class WineToolExecutor {
  constructor(private readonly deps: WineToolExecutorDeps) {}

  async execute(
    toolName: string,
    input: unknown,
    requestId: string,
    v2Options?: ToolExecutionV2Options,
  ): Promise<WineToolExecutorResult> {
    switch (toolName) {
      case 'search_wines': {
        if (v2Options !== undefined) {
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
      case 'lookup_wine':
        return this.executeLookupWine(input, requestId);
      case 'get_food_pairings':
        return this.executeFoodPairings(input, requestId);
      case 'check_drinking_window':
        return this.executeCheckDrinkingWindow(input);
      case 'compare_wines':
        return this.executeCompareWines(input, requestId);
      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  }

  private async executeSearchWines(input: unknown, requestId: string): Promise<SearchResponseV1 | { error: string }> {
    const validation = parseToolInput('search_wines', SearchToolInputSchema, input);
    if (!validation.success) {
      return validation.result;
    }
    const validated = validation.data;
    const returnLimit = validated.limit ?? DEFAULT_SEARCH_LIMIT;
    const wantsDiversity =
      validated.want_diversity === true || SEARCH_TOOL_WANTS_DIVERSITY_RE.test(validated.query);
    const candidateGatherLimit = wantsDiversity
      ? Math.max(returnLimit, SEARCH_TOOL_DIVERSITY_MIN_LIMIT)
      : returnLimit;
    const structuredFilters = buildSearchToolStructuredFilters(validated);
    const fallbackRequest = buildSearchToolRequest({
      ...validated,
      limit: candidateGatherLimit,
    });

    const response = await executeSearchWithTypedWineDiversityDiscovery({
      searchUseCase: this.deps.searchUseCase,
      requestId,
      fallbackRequest,
      candidateGatherLimit,
      returnLimit,
      shouldRun: shouldRunTypedWineDiversityDiscovery({
        query: validated.query,
        wantsDiversity,
        wineType: validated.wine_type,
      }),
      buildTypedRequest: (wineType) => ({
        ...fallbackRequest,
        limit: candidateGatherLimit,
        filters: withWineTypeFilter(
          structuredFilters,
          wineType,
          CLAUDE_TOOL_DIVERSITY_MAPPING_VERSION,
        ),
      }),
      resultPolicy: (searchResponse) => applySearchWinesResultPolicies(searchResponse, validated),
    });
    const searchResponse = requireSearchOnlyToolResult('search_wines', response);
    if ('error' in searchResponse) {
      return searchResponse;
    }
    return searchResponse;
  }

  private async executeLookupWine(
    input: unknown,
    requestId: string,
  ): Promise<SearchResponseV1 | { error: string }> {
    const normalized = normalizeLookupWineInput(input);
    if (!normalized.ok) {
      return { error: `Invalid input for lookup_wine: ${normalized.message}` };
    }
    const response = await this.deps.searchUseCase.execute({
      query: normalized.query,
      limit: normalized.clampedLimit,
      options: {
        mode: 'entity',
        explain: false,
        clarification: false,
      },
    }, requestId);
    return requireSearchOnlyToolResult('lookup_wine', response);
  }

  private async executeFoodPairings(
    input: unknown,
    requestId: string,
  ): Promise<SearchResponseV1 | { error: string }> {
    const validation = parseToolInput('get_food_pairings', FoodPairingInputSchema, input);
    if (!validation.success) {
      return validation.result;
    }
    const validated = validation.data;
    const request: SearchRequest = {
      query: buildFoodPairingQuery(validated),
      options: {
        mode: FOOD_PAIRING_RETRIEVAL_MODE,
        explain: false,
        clarification: false,
      },
      ...(buildFoodPairingFilters(validated, CLAUDE_TOOL_FILTER_MAPPING_VERSION).length > 0
        ? { filters: buildFoodPairingFilters(validated, CLAUDE_TOOL_FILTER_MAPPING_VERSION) }
        : {}),
      ...(buildFoodPairingPreferences(validated, CLAUDE_TOOL_FILTER_MAPPING_VERSION).length > 0
        ? { preferences: buildFoodPairingPreferences(validated, CLAUDE_TOOL_FILTER_MAPPING_VERSION) }
        : {}),
    };
    const response = await this.deps.searchUseCase.execute(request, requestId);
    return requireSearchOnlyToolResult('get_food_pairings', response);
  }

  private async executeCheckDrinkingWindow(
    input: unknown,
  ): Promise<DrinkingWindowBlock | { error: string }> {
    const validation = parseToolInput('check_drinking_window', DrinkingWindowInputSchema, input);
    if (!validation.success) {
      return validation.result;
    }
    if (this.deps.drinkingWindowUseCase === undefined) {
      return { error: 'Drinking-window predictor not available.' };
    }
    const entityLookup = this.deps.entityLookup;
    if (entityLookup?.getDrinkingWindowDocuments === undefined) {
      return { error: 'Entity lookup not yet implemented or available for check_drinking_window.' };
    }
    const validated = validation.data;
    const entityId = createCanonicalEntityId(validated.entity_id);
    let documentRecord: Record<string, unknown> | undefined;
    const docs = await entityLookup.getDrinkingWindowDocuments([entityId]);
    const projection = docs.get(entityId);
    if (projection !== undefined) {
      documentRecord = projection as unknown as Record<string, unknown>;
    }
    if (documentRecord === undefined) {
      return { error: `Entity lookup not available for entity_id=${validated.entity_id}` };
    }
    const targetYear = validated.target_year ?? new Date().getFullYear();
    const request = buildDrinkingWindowRequest(documentRecord, targetYear);
    if (request === null) {
      return { error: `Entity ${validated.entity_id} is missing required drinking-window features.` };
    }
    return this.deps.drinkingWindowUseCase.check(request);
  }

  private async executeCompareWines(
    input: unknown,
    requestId: string,
  ): Promise<ComparisonSearchResponse | { error: string }> {
    const validation = parseToolInput('compare_wines', CompareWinesInputSchema, input);
    if (!validation.success) {
      return validation.result;
    }
    if (this.deps.decomposedSearchUseCase === undefined) {
      return { error: 'Decomposed comparison use case not available.' };
    }
    const validated = validation.data;
    const executionRequest = buildCompareWinesExecutionRequest(
      validated,
      CLAUDE_TOOL_FILTER_MAPPING_VERSION,
    );
    return this.deps.decomposedSearchUseCase.execute(
      executionRequest.subQueries,
      executionRequest.comparisonLegs,
      executionRequest.comparisonIntent,
      executionRequest.originalQuery,
      requestId,
      Date.now(),
      executionRequest.parentContext,
    );
  }
}
