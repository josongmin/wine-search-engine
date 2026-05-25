/**
 * Epic 17.2: Wine Tool Executor
 *
 * Type-safe executor for Claude tool calls. Dispatches calls to appropriate
 * use cases with validated input and proper requestId propagation.
 */

import type { z } from 'zod';
import type { SearchExecutorPort } from '../../application/search/port/search-executor.port.js';
import type { SearchRequest } from '../../application/search/search-request.dto.js';
import {
  buildSearchToolStructuredPreferences as buildContractSearchToolStructuredPreferences,
  sanitizeOptionalToolNulls,
} from '../../application/search/search-tool-contract.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../domain/response/model/comparison-response.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
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
import { SearchToolInputSchema } from './tool-schemas.js';
import type { NormalizedConstraint } from '../../domain/shared/types/index.js';

const CLAUDE_TOOL_FILTER_MAPPING_VERSION = 'claude_tool_v1' as const;
const CLAUDE_TOOL_DIVERSITY_MAPPING_VERSION = 'claude_tool_diversity_v1' as const;

type SearchToolInput = z.infer<typeof SearchToolInputSchema>;
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
    data: validation.data as z.output<T>,
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
  for (const wineType of input.exclude_wine_types ?? []) {
    pushSearchToolStructuredFilter(filters, 'wine_type', 'exclude', wineType, wineType);
  }
  if (input.wine_type !== undefined) {
    pushSearchToolStructuredFilter(filters, 'wine_type', '=', input.wine_type, input.wine_type);
  }
  if (input.grape_primary !== undefined) {
    pushSearchToolStructuredFilter(filters, 'grape_primary', '=', input.grape_primary, input.grape_primary);
  }
  if (input.country !== undefined) {
    pushSearchToolStructuredFilter(filters, 'country', '=', input.country, input.country);
  }
  if (input.region !== undefined) {
    pushSearchToolStructuredFilter(filters, 'region', '=', input.region, input.region);
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

function buildSearchToolStructuredPreferences(input: SearchToolInput): readonly NormalizedConstraint[] {
  return buildContractSearchToolStructuredPreferences(input, CLAUDE_TOOL_FILTER_MAPPING_VERSION);
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
  const preferences = buildSearchToolStructuredPreferences(input);
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
    ...(preferences.length > 0 ? { preferences } : {}),
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
}

/**
 * Tool executor for wine search engine.
 *
 * Dispatches Claude tool calls to the wine search use case:
 * - search_wines -> SearchUseCase.execute(request, requestId)
 * - lookup_wine -> SearchUseCase with retrievalMode=entity
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
  ): Promise<SearchResponseV1 | SearchResponseV2Machine | ComparisonSearchResponse | { error: string }> {
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
    const budgetFiltered = applySearchToolBudgetResultPolicy(
      negationFiltered.response,
      {
        minKrw: validated.min_price_krw,
        maxKrw: validated.max_price_krw,
      },
      { krwPerUsd: KRW_PER_USD_APPROXIMATE },
    ).response;
    return applySearchToolAlcoholResultPolicy(
      budgetFiltered,
      validated.max_alcohol_pct,
    ).response;
  }



}
