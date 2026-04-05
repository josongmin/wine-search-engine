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
import type { ResolveRequest } from '../resolve-request.dto.js';
import type { ResolveResponse } from '../resolve-response.dto.js';
import type { HybridSearchRequest } from '../hybrid-request.dto.js';

export interface DecomposedSearchUseCasePort {
  execute(
    subQueries: [string, string],
    comparisonIntent: 'compare' | 'recommend_one' | 'list_both',
    originalQuery: string,
    requestId: string,
    startTime: number,
  ): Promise<ComparisonSearchResponse>;
}

export interface BatchSearchUseCasePort {
  execute(
    requests: readonly BatchSearchRequestItem[],
    options?: BatchSearchOptions,
    batchId?: string,
  ): Promise<BatchSearchResponse>;
}

export interface ReplayUseCasePort {
  execute(request: ReplayRequest, requestId: string): Promise<SearchResponseV1>;
}

export interface InterpretUseCasePort {
  execute(request: InterpretRequest): Promise<QueryPlanV1>;
}

export interface ResolveUseCasePort {
  execute(request: ResolveRequest): Promise<ResolveResponse>;
}

export interface HybridUseCasePort {
  execute(request: HybridSearchRequest, requestId: string): Promise<SearchResponseV1>;
}
