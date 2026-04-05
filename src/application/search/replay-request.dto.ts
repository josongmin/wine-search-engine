import type { DecisionSnapshot } from '../../domain/shared/types/index.js';
import type {
  SearchOptions,
  SearchQueryBudget,
  SearchRequestContext,
  SearchSessionContext,
} from './search-request.dto.js';

export interface ReplayRequest {
  readonly query: string;
  readonly decision_snapshot: DecisionSnapshot;
  readonly context?: SearchRequestContext | undefined;
  readonly sessionContext?: SearchSessionContext | undefined;
  readonly queryBudget?: SearchQueryBudget | undefined;
  readonly options?: SearchOptions | undefined;
  /**
   * Optional expected response hash for determinism validation (RFC-009 §8).
   *
   * Omit this field to perform a snapshot-only replay without hash validation.
   */
  readonly expected_response_hash?: string | undefined;
}
