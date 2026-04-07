import type { DecisionSnapshot } from '../../domain/shared/types/index.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import { DomainError } from '../../domain/shared/error/domain-error.js';
import type { SnapshotVersions } from './search.usecase.js';
import type { ReplayRequest } from './replay-request.dto.js';
import type { SearchRequest } from './search-request.dto.js';
import type { SearchExecutorPort } from './port/search-executor.port.js';
import {
  buildDecisionSnapshotFromRuntimeVersions,
  decisionSnapshotsMatch,
  readDecisionSnapshotFromSearchResponse,
} from './search-usecase-decision-snapshot.js';

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

export class MissingSnapshotError extends DomainError {
  constructor() {
    super(
      'MISSING_SNAPSHOT',
      'Replay requires a decision snapshot for fail-closed execution.',
    );
    this.name = 'MissingSnapshotError';
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
    // Runtime guard: tests cast null through unknown to exercise MissingSnapshotError.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see replay-usecase.test.ts
    if (request.decision_snapshot == null) {
      throw new MissingSnapshotError();
    }

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
    const currentSnapshot = readDecisionSnapshotFromSearchResponse(response);
    const legacyRuntimeSnapshot = buildDecisionSnapshotFromRuntimeVersions(
      this.deps.snapshotVersions,
    );

    if (
      !this.snapshotsMatch(request.decision_snapshot, currentSnapshot)
      && !this.snapshotsMatch(request.decision_snapshot, legacyRuntimeSnapshot)
    ) {
      throw new SnapshotMismatchError(request.decision_snapshot, currentSnapshot);
    }

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

    return applyPreflightHonestyFloor(response, request.preflight_honesty_contract);
  }

  /**
   * Compares two snapshots for structural equality.
   * Fail-closed: any mismatch is a rejection.
   */
  private snapshotsMatch(
    expected: DecisionSnapshot,
    actual: DecisionSnapshot,
  ): boolean {
    return decisionSnapshotsMatch(expected, actual);
  }
}

const EXECUTION_MODE_SEVERITY: Record<
  NonNullable<SearchResponseV1['meta']['executionMode']>,
  number
> = {
  authoritative: 0,
  advisory: 1,
  heuristic: 2,
  degraded: 3,
};

function chooseStricterExecutionMode(
  actual: SearchResponseV1['meta']['executionMode'] | SearchResponseV1['engineDecision']['executionMode'],
  floor: NonNullable<ReplayRequest['preflight_honesty_contract']>['execution_mode'],
): NonNullable<SearchResponseV1['meta']['executionMode']> {
  const normalizedActual = actual ?? 'authoritative';
  return EXECUTION_MODE_SEVERITY[normalizedActual] >= EXECUTION_MODE_SEVERITY[floor]
    ? normalizedActual
    : floor;
}

function applyPreflightHonestyFloor(
  response: SearchResponseV1,
  preflightHonestyContract: ReplayRequest['preflight_honesty_contract'],
): SearchResponseV1 {
  if (preflightHonestyContract === undefined) {
    return response;
  }

  const actualExecutionMode = response.engineDecision.executionMode ?? response.meta.executionMode;
  const mergedExecutionMode = chooseStricterExecutionMode(
    actualExecutionMode,
    preflightHonestyContract.execution_mode,
  );
  const actualReasons = new Set([
    ...(response.engineDecision.degradationReasons ?? response.meta.degradationReasons ?? []),
  ]);
  for (const reason of preflightHonestyContract.degradation_reasons) {
    actualReasons.add(reason);
  }

  const mergedBlockingEligible = (
    response.engineDecision.blockingEligible
    ?? response.meta.blockingEligible
    ?? true
  )
    && (preflightHonestyContract.blocking_eligible ?? true)
    && mergedExecutionMode !== 'heuristic'
    && mergedExecutionMode !== 'advisory';

  return {
    ...response,
    engineDecision: {
      ...response.engineDecision,
      executionMode: mergedExecutionMode,
      blockingEligible: mergedBlockingEligible,
      ...(actualReasons.size > 0 ? { degradationReasons: [...actualReasons] } : {}),
    },
    meta: {
      ...response.meta,
      executionMode: mergedExecutionMode,
      blockingEligible: mergedBlockingEligible,
      ...(actualReasons.size > 0 ? { degradationReasons: [...actualReasons] } : {}),
    },
  };
}
