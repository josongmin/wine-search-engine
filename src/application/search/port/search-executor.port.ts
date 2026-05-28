import type { SearchResponseV1 } from '../../../domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../../domain/response/model/comparison-response.js';
import type { EvalProvenanceSlice } from '../../../domain/retrieval/model/provenance.js';
import type { FunnelMetrics } from '../../../domain/ranking/model/ranking-stage.js';
import type { RequestExecutionContext } from '../../../domain/shared/request-execution-context.js';
import type { QueryClass } from '../../../domain/shared/types/query-class.js';
import type { QueryIntent } from '../../../domain/query/model/query-intent.js';
import type { QueryRoute } from '../../../domain/query/model/query-route.js';
import type { ExecutionRetrievalMode } from '../../../domain/query/model/engine-execution-contract.js';
import type { SearchRequest } from '../search-request.dto.js';

export type SearchExecutorResult = SearchResponseV1 | ComparisonSearchResponse;

export interface SearchExecutorRuntimeClassification {
  readonly queryClass: QueryClass;
  readonly intent: QueryIntent;
  readonly route: QueryRoute;
  readonly retrievalMode: ExecutionRetrievalMode;
}

export interface SearchExecutorEvaluationResult {
  readonly response: SearchExecutorResult;
  readonly retrievalProvenanceSlices?: readonly EvalProvenanceSlice[] | undefined;
  readonly funnelMetrics?: FunnelMetrics | undefined;
  readonly runtimeClassification?: SearchExecutorRuntimeClassification | undefined;
}

export type SearchExecutionOptions = RequestExecutionContext;

export interface SearchExecutorPort {
  execute(
    request: SearchRequest,
    requestId: string,
    options?: SearchExecutionOptions,
  ): Promise<SearchExecutorResult>;
  executeForEvaluation?(
    request: SearchRequest,
    requestId: string,
    options?: SearchExecutionOptions,
  ): Promise<SearchExecutorEvaluationResult>;
}
