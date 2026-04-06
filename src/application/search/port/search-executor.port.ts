import type { SearchResponseV1 } from '../../../domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../../domain/response/model/comparison-response.js';
import type { EvalProvenanceSlice } from '../../../domain/retrieval/model/provenance.js';
import type { SearchRequest } from '../search-request.dto.js';

export type SearchExecutorResult = SearchResponseV1 | ComparisonSearchResponse;

export interface SearchExecutorEvaluationResult {
  readonly response: SearchExecutorResult;
  readonly retrievalProvenanceSlices?: readonly EvalProvenanceSlice[] | undefined;
}

export interface SearchExecutorPort {
  execute(request: SearchRequest, requestId: string): Promise<SearchExecutorResult>;
  executeForEvaluation?(
    request: SearchRequest,
    requestId: string,
  ): Promise<SearchExecutorEvaluationResult>;
}
