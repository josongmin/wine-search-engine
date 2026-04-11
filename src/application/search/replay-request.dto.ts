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
  /**
   * Optional expected determinism fingerprint for configuration-drift validation.
   *
   * Omit to perform snapshot/hash-only replay without fingerprint validation.
   */
  readonly expected_determinism_fingerprint?: string | undefined;
  /**
   * Optional honesty floor observed during live-snapshot preflight.
   *
   * When present, replay must not surface a more optimistic execution contract
   * than the preflight search that produced the snapshot.
   */
  readonly preflight_honesty_contract?: {
    readonly execution_mode: 'authoritative' | 'degraded' | 'heuristic' | 'advisory';
    readonly degradation_reasons: readonly string[];
    readonly blocking_eligible?: boolean | undefined;
  } | undefined;
}
