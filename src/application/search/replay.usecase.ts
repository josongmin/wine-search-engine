import type { DecisionSnapshot } from '../../domain/shared/types/index.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import { DomainError } from '../../domain/shared/error/domain-error.js';
import type { SearchUseCase, SearchRequest } from './search.usecase.js';

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
 * Replay request: the search request plus a required decision snapshot.
 */
export interface ReplayRequest {
  readonly query: string;
  readonly decision_snapshot: DecisionSnapshot;
  readonly context?: {
    readonly locale: string;
    readonly currency: string;
  } | undefined;
  readonly sessionContext?: {
    readonly sessionId: string;
    readonly previousEntities: string[];
  } | undefined;
  readonly queryBudget?: {
    readonly maxLatencyMs: number;
    readonly maxCandidates: number;
    readonly rerankLimit: number;
  } | undefined;
  readonly options?: {
    readonly mode: 'auto' | 'entity' | 'hybrid' | 'mixed';
    readonly explain: boolean;
    readonly clarification: boolean;
  } | undefined;
}

/**
 * Dependencies injected into the ReplayUseCase.
 */
export interface ReplayUseCaseDeps {
  readonly searchUseCase: SearchUseCase;
  /** Version strings for RFC-015 snapshot population. */
  readonly snapshotVersions?: import('./search.usecase.js').SnapshotVersions | undefined;
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
    // Step 1: Validate decision_snapshot is provided
    if (!request.decision_snapshot) {
      throw new DomainError(
        'MISSING_SNAPSHOT',
        'decision_snapshot is required for replay requests.',
      );
    }

    // Step 2: Build current runtime snapshot for comparison
    const currentSnapshot = this.buildCurrentSnapshot();

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

    return this.deps.searchUseCase.execute(searchRequest, requestId);
  }

  /**
   * Builds the current runtime decision snapshot for comparison.
   * Populates model_versions and index_versions from injected snapshotVersions
   * per RFC-015, which requires actual version strings (not empty objects).
   */
  private buildCurrentSnapshot(): DecisionSnapshot {
    return {
      model_versions: this.deps.snapshotVersions?.modelVersions ?? {},
      index_versions: this.deps.snapshotVersions?.indexVersions ?? {},
      policy_rule_version: '1.0.0',
      threshold_profile_id: 'default',
      planner_version: '1.0.0',
      feature_flags: {},
    };
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
      const ak = aKeys[i]!;
      const bk = bKeys[i]!;
      if (ak !== bk) return false;
      if (a[ak] !== b[bk]) return false;
    }
    return true;
  }
}
