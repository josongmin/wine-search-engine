import type {
  SearchQueryBudget,
  SearchRequestContext,
  SearchSessionContext,
} from '../../search/search-request.dto.js';
import type { AutocompleteResponse } from '../../search/autocomplete-response.dto.js';
import type { ResolveResponse } from '../../search/resolve-response.dto.js';

export interface EntityResolveInput {
  readonly query: string;
  readonly context?: SearchRequestContext | undefined;
  readonly sessionContext?: SearchSessionContext | undefined;
  readonly queryBudget?: SearchQueryBudget | undefined;
}

export interface EntityAutocompleteInput {
  readonly query: string;
  readonly context?: SearchRequestContext | undefined;
  readonly sessionContext?: SearchSessionContext | undefined;
  readonly queryBudget?: SearchQueryBudget | undefined;
}

export type EntityResolveResult = ResolveResponse;
export type EntityAutocompleteResult = AutocompleteResponse;
