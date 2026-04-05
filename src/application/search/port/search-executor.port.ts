import type { SearchResponseV1 } from '../../../domain/response/model/search-response.js';
import type { SearchRequest } from '../search-request.dto.js';

export interface SearchExecutorPort {
  execute(request: SearchRequest, requestId: string): Promise<SearchResponseV1>;
}
