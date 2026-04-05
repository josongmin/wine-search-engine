import type {
  SearchQueryBudget,
  SearchRequestContext,
  SearchSessionContext,
} from './search-request.dto.js';

export interface HybridSearchOptions {
  readonly explain: boolean;
  readonly clarification: boolean;
}

export interface HybridSearchRequest {
  readonly query: string;
  readonly context?: SearchRequestContext | undefined;
  readonly sessionContext?: SearchSessionContext | undefined;
  readonly queryBudget?: SearchQueryBudget | undefined;
  readonly options?: HybridSearchOptions | undefined;
}
