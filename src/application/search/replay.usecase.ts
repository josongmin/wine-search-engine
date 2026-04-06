import type { DecisionSnapshot } from '../../domain/shared/types/index.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import { DomainError } from '../../domain/shared/error/domain-error.js';
import type { SnapshotVersions } from './search.usecase.js';
import type { ReplayRequest } from './replay-request.dto.js';
import type { SearchRequest } from './search-request.dto.js';
import type { SearchExecutorPort } from './port/search-executor.port.js';
import { buildDecisionSnapshotFromRuntimeVersions } from './search-usecase-decision-snapshot.js';

export type { ReplayRequest } from './replay-request.dto.js';

/**
 * Error thrown when a replay snapshot does not match the current runtime snapshot.
 */
export class SnapshotMismatchError extends DomainError {
  public readonly expected: DecisionSnapshot;
  public readonly actual: DecisionSnapshot;

  constructor(expected: DecisionSnapshot, actual: DecisionSnapshot) {
    super(
      'SNAPSHOT_MISMATCH',
      'Decision snapshot does not match current runtime; replay rejected (fail-closed per RFC-014 §4.3).',
    );
    this.name = 'SnapshotMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Error thrown when a replay response hash does not match the expected hash.
 *
 * This indicates that the engine produced a different decision for the same
 * query + snapshot — a determinism violation per RFC-009 §8 / RFC-015.
 */
export class DeterminismViolationError extends DomainError {
  public readonly expectedHash: string;
  public readonly actualHash: string;

  constructor(expectedHash: string, actualHash: string) {
    super(
      'DETERMINISM_VIOLATION',
      `Replay response hash mismatch: expected=${expectedHash}, actual=${actualHash}. ` +
        'The engine produced a different decision for the same query and snapshot (RFC-009 §8).',
    );
    this.name = 'DeterminismViolationError';
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

/**
 * Error thrown when replay delegates to a non-search response shape.
 */
export class UnexpectedReplayResponseError extends DomainError {
  constructor() {
    super(
      'UNEXPECTED_REPLAY_RESPONSE',
      'Replay expected a standard search response but received a comparison response.',
    );
    this.name = 'UnexpectedReplayResponseError';
  }
}

/**
 * Dependencies injected into the ReplayUseCase.
 */
export interface ReplayUseCaseDeps {
  readonly searchUseCase: SearchExecutorPort;
  /** Version strings for RFC-015 snapshot population. */
  readonly snapshotVersions?: SnapshotVersions | undefined;
}

/**
 * Replay use case — re-executes a search with a pinned decision snapshot.
 *
 * If the provided snapshot does not match the current runtime snapshot,
 * the replay is rejected with a SNAPSHOT_MISMATCH error (fail-closed
 * per RFC-014 §4.3).
 */
export class ReplayUseCase {
  constructor(private readonly deps: ReplayUseCaseDeps) {}

  async execute(
    request: ReplayRequest,
    requestId: string,
  ): Promise<SearchResponseV1> {
    // Step 2: Build current runtime snapshot for comparison
    const currentSnapshot = buildDecisionSnapshotFromRuntimeVersions(this.deps.snapshotVersions);

    // Step 3: Compare snapshot with current runtime snapshot
    if (!this.snapshotsMatch(request.decision_snapshot, currentSnapshot)) {
      throw new SnapshotMismatchError(request.decision_snapshot, currentSnapshot);
    }

    // Step 4: Execute search with pinned versions
    const searchRequest: SearchRequest = {
      query: request.query,
      context: request.context,
      sessionContext: request.sessionContext,
      queryBudget: request.queryBudget,
      options: request.options,
    };

    const rawResponse = await this.deps.searchUseCase.execute(searchRequest, requestId);

    // Replay always targets a standard search, never a comparison
    if (rawResponse.queryType !== 'search') {
      throw new UnexpectedReplayResponseError();
    }
    const response = rawResponse;

    // Step 5: Determinism gate (RFC-009 §8 / RFC-015)
    // If the caller supplied an expected_response_hash, validate it against
    // the hash embedded in the freshly-produced response. A mismatch indicates
    // the engine reached a different decision — a determinism violation.
    if (request.expected_response_hash !== undefined) {
      const actualHash = response.meta.response_hash;
      if (actualHash === undefined || actualHash !== request.expected_response_hash) {
        throw new DeterminismViolationError(
          request.expected_response_hash,
          actualHash ?? '(missing)',
        );
      }
    }

    return response;
  }

  /**
   * Compares two snapshots for structural equality.
   * Fail-closed: any mismatch is a rejection.
   */
  private snapshotsMatch(
    expected: DecisionSnapshot,
    actual: DecisionSnapshot,
  ): boolean {
    return (
      expected.policy_rule_version === actual.policy_rule_version &&
      expected.threshold_profile_id === actual.threshold_profile_id &&
      expected.planner_version === actual.planner_version &&
      this.recordsMatch(expected.model_versions, actual.model_versions) &&
      this.recordsMatch(expected.index_versions, actual.index_versions) &&
      this.recordsMatch(
        expected.feature_flags as Readonly<Record<string, unknown>>,
        actual.feature_flags as Readonly<Record<string, unknown>>,
      )
    );
  }

  /**
   * Shallow-compares two string-keyed records.
   */
  private recordsMatch(
    a: Readonly<Record<string, unknown>>,
    b: Readonly<Record<string, unknown>>,
  ): boolean {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i++) {
      const ak = aKeys[i];
      const bk = bKeys[i];
      if (ak === undefined || bk === undefined) return false;
      if (ak !== bk) return false;
      if (a[ak] !== b[bk]) return false;
    }
    return true;
  }
}
