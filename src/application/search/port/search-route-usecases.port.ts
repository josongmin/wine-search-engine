import type { SearchResponseV1 } from '../../../domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../../domain/response/model/comparison-response.js';
import type { QueryPlanV1 } from '../../../domain/query/model/query-plan.js';
import type {
  BatchSearchExecutionContext,
  BatchSearchOptions,
  BatchSearchRequestItem,
  BatchSearchResponse,
} from '../batch-search.dto.js';
import type { ReplayRequest } from '../replay-request.dto.js';
import type { InterpretRequest } from '../interpret-request.dto.js';
import type { InterpretResultWithV2 } from '../interpret.usecase.js';
import type { ResolveRequest } from '../resolve-request.dto.js';
import type { ResolveResponse } from '../resolve-response.dto.js';
import type { RequestExecutionContext } from '../../../domain/shared/request-execution-context.js';
import type { HybridSearchRequest } from '../hybrid-request.dto.js';
import type { SearchQueryBudget, SearchRequestContext, SearchSessionContext } from '../search-request.dto.js';
import type { NormalizedConstraint } from '../../../domain/shared/types/constraint-bundle.js';
import type {
  ComparisonDecompositionLegs,
  ComparisonIntent,
} from '../../../domain/query/model/query-decomposition.js';

export interface DecomposedSearchParentContext {
  readonly context?: SearchRequestContext | undefined;
  readonly sessionContext?: SearchSessionContext | undefined;
  readonly queryBudget?: SearchQueryBudget | undefined;
  readonly filters?: readonly NormalizedConstraint[] | undefined;
  readonly preferences?: readonly NormalizedConstraint[] | undefined;
  /**
   * Forwards the parent search request's `options.explain` to each sub-search
   * so that explain=true on a comparison query produces counterfactuals on
   * both legs.
   */
  readonly explain?: boolean | undefined;
}

export type DecomposedSearchExecutionOptions = RequestExecutionContext;

export interface DecomposedSearchUseCasePort {
  execute(
    subQueries: [string, string],
    comparisonLegs: ComparisonDecompositionLegs,
    comparisonIntent: ComparisonIntent,
    originalQuery: string,
    requestId: string,
    startTime: number,
    parentContext?: DecomposedSearchParentContext,
    options?: DecomposedSearchExecutionOptions,
  ): Promise<ComparisonSearchResponse>;
}

export interface BatchSearchUseCasePort {
  execute(
    requests: readonly BatchSearchRequestItem[],
    options?: BatchSearchOptions,
    batchId?: string,
    executionContext?: BatchSearchExecutionContext,
  ): Promise<BatchSearchResponse>;
}

export type ReplayExecutionOptions = RequestExecutionContext;

export interface ReplayUseCasePort {
  execute(request: ReplayRequest, requestId: string, options?: ReplayExecutionOptions): Promise<SearchResponseV1>;
}

export type InterpretExecutionOptions = RequestExecutionContext;

export interface InterpretUseCasePort {
  execute(
    request: InterpretRequest & { readonly buildV2: true; readonly requestId?: string | undefined },
    options?: InterpretExecutionOptions,
  ): Promise<InterpretResultWithV2>;
  execute(
    request: InterpretRequest & { readonly buildV2?: boolean | undefined; readonly requestId?: string | undefined },
    options?: InterpretExecutionOptions,
  ): Promise<QueryPlanV1 | InterpretResultWithV2>;
}

export type ResolveExecutionOptions = RequestExecutionContext;

export interface ResolveUseCasePort {
  execute(request: ResolveRequest, options?: ResolveExecutionOptions): Promise<ResolveResponse>;
}

export type HybridExecutionOptions = RequestExecutionContext;

export interface HybridUseCasePort {
  execute(
    request: HybridSearchRequest,
    requestId: string,
    options?: HybridExecutionOptions,
  ): Promise<SearchResponseV1 | ComparisonSearchResponse>;
}
