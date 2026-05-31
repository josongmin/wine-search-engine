import type {
  SearchQueryBudget,
  SearchRequestContext,
} from '../../search/search-request.dto.js';
import type { NormalizedConstraint } from '../../../domain/shared/types/constraint-bundle.js';

export interface PrimitiveSearchInput {
  readonly query: string;
  readonly context?: SearchRequestContext | undefined;
  readonly queryBudget?: SearchQueryBudget | undefined;
  readonly limit?: number | undefined;
  readonly filters?: readonly NormalizedConstraint[] | undefined;
  readonly preferences?: readonly NormalizedConstraint[] | undefined;
}

export type PrimitiveSearchResult = unknown;
