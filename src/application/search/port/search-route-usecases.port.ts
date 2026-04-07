import type { SearchResponseV1 } from '../../../domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../../domain/response/model/comparison-response.js';
import type { QueryPlanV1 } from '../../../domain/query/model/query-plan.js';
import type {
  BatchSearchOptions,
  BatchSearchRequestItem,
  BatchSearchResponse,
} from '../batch-search.dto.js';
import type { ReplayRequest } from '../replay-request.dto.js';
import type { InterpretRequest } from '../interpret-request.dto.js';
import type { InterpretResultWithV2 } from '../interpret.usecase.js';
import type { ResolveRequest } from '../resolve-request.dto.js';
import type { ResolveResponse } from '../resolve-response.dto.js';
import type { HybridSearchRequest } from '../hybrid-request.dto.js';
import type { SearchQueryBudget, SearchRequestContext, SearchSessionContext } from '../search-request.dto.js';

export interface DecomposedSearchParentContext {
  readonly context?: SearchRequestContext | undefined;
  readonly sessionContext?: SearchSessionContext | undefined;
  readonly queryBudget?: SearchQueryBudget | undefined;
}

export interface DecomposedSearchExecutionOptions {
  readonly abortSignal?: AbortSignal | undefined;
}

export interface DecomposedSearchUseCasePort {
  execute(
    subQueries: [string, string],
    comparisonIntent: 'compare' | 'recommend_one' | 'list_both',
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
  ): Promise<BatchSearchResponse>;
}

export interface ReplayExecutionOptions {
  readonly abortSignal?: AbortSignal | undefined;
}

export interface ReplayUseCasePort {
  execute(request: ReplayRequest, requestId: string, options?: ReplayExecutionOptions): Promise<SearchResponseV1>;
}

export interface InterpretExecutionOptions {
  readonly abortSignal?: AbortSignal | undefined;
}

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

export interface ResolveExecutionOptions {
  readonly abortSignal?: AbortSignal | undefined;
}

export interface ResolveUseCasePort {
  execute(request: ResolveRequest, options?: ResolveExecutionOptions): Promise<ResolveResponse>;
}

export interface HybridUseCasePort {
  execute(
    request: HybridSearchRequest,
    requestId: string,
  ): Promise<SearchResponseV1 | ComparisonSearchResponse>;
}
