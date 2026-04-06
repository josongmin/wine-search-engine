import type { SearchResponseV1 } from '../../../domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../../domain/response/model/comparison-response.js';
import type { SearchRequest } from '../search-request.dto.js';

export type SearchExecutorResult = SearchResponseV1 | ComparisonSearchResponse;

export interface SearchExecutorPort {
  execute(request: SearchRequest, requestId: string): Promise<SearchExecutorResult>;
}
