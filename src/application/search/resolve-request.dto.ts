import type {
  SearchQueryBudget,
  SearchRequestContext,
  SearchSessionContext,
} from './search-request.dto.js';

export interface ResolveRequest {
  readonly query: string;
  readonly requestId?: string | undefined;
  readonly context?: SearchRequestContext | undefined;
  readonly sessionContext?: SearchSessionContext | undefined;
  readonly queryBudget?: SearchQueryBudget | undefined;
}
