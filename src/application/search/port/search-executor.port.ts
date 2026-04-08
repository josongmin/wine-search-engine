import type { SearchResponseV1 } from '../../../domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../../domain/response/model/comparison-response.js';
import type { EvalProvenanceSlice } from '../../../domain/retrieval/model/provenance.js';
import type { FunnelMetrics } from '../../../domain/ranking/model/ranking-stage.js';
import type { RequestExecutionContext } from '../../../domain/shared/request-execution-context.js';
import type { SearchRequest } from '../search-request.dto.js';

export type SearchExecutorResult = SearchResponseV1 | ComparisonSearchResponse;

export interface SearchExecutorEvaluationResult {
  readonly response: SearchExecutorResult;
  readonly retrievalProvenanceSlices?: readonly EvalProvenanceSlice[] | undefined;
  readonly funnelMetrics?: FunnelMetrics | undefined;
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
