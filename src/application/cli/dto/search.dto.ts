import type {
  SearchQueryBudget,
  SearchRequestContext,
  SearchSessionContext,
  SearchOptions,
  RepresentativeConceptSearchContext,
} from '../../search/search-request.dto.js';
import type { HybridSearchOptions } from '../../search/hybrid-request.dto.js';
import type { NormalizedConstraint } from '../../../domain/shared/types/constraint-bundle.js';

export interface SearchRunInput {
  readonly query: string;
  readonly context?: SearchRequestContext | undefined;
  readonly sessionContext?: SearchSessionContext | undefined;
  readonly queryBudget?: SearchQueryBudget | undefined;
  readonly options?: SearchOptions | undefined;
  readonly retrievalMode?: 'auto' | 'entity' | 'hybrid' | 'mixed' | undefined;
  readonly limit?: number | undefined;
  readonly filters?: readonly NormalizedConstraint[] | undefined;
  readonly preferences?: readonly NormalizedConstraint[] | undefined;
  readonly representativeConcept?: RepresentativeConceptSearchContext | undefined;
}

export interface SearchHybridInput {
  readonly query: string;
  readonly context?: SearchRequestContext | undefined;
  readonly sessionContext?: SearchSessionContext | undefined;
  readonly queryBudget?: SearchQueryBudget | undefined;
  readonly options?: HybridSearchOptions | undefined;
}

export type SearchRunResult = unknown;
export type SearchHybridResult = unknown;
