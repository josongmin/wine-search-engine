import { describe, it, expect, vi } from 'vitest';
import {
  ReplayUseCase,
  SnapshotMismatchError,
  UnexpectedReplayResponseError,
} from '../../../src/application/search/replay.usecase.js';
import type { ReplayRequest } from '../../../src/application/search/replay.usecase.js';
import type { SearchUseCase } from '../../../src/application/search/search.usecase.js';
import { buildDecisionSnapshotFromRuntimeVersions } from '../../../src/application/search/search-usecase-decision-snapshot.js';
import type { SearchResponseV1 } from '../../../src/domain/response/model/search-response.js';
import type { DecisionSnapshot } from '../../../src/domain/shared/types/index.js';

// ── Fixtures ───────────────────────────────────────────────────────────────────

/** The canonical runtime snapshot shape ReplayUseCase should compare against. */
const VALID_SNAPSHOT: DecisionSnapshot = buildDecisionSnapshotFromRuntimeVersions();

/** A minimal valid SearchResponseV1 stub. */
const STUB_RESPONSE: SearchResponseV1 = {
  queryType: 'search',
  engineDecision: {
    decisionStatus: 'resolved',
    nextAction: 'return_results',
    route: 'entity',
    decisionConfidence: 0.9,
    confidenceSemantics: 'calibrated_decision_confidence',
    decisionTraceRef: 'trace-stub',
    decisionSnapshot: VALID_SNAPSHOT,
  },
  results: [],
  meta: {
    queryTimeMs: 10,
    route: 'entity',
    version: '1',
    engine_schema_version: 'search_response_v1',
  },
};

/** Creates a mock SearchUseCase whose execute() returns STUB_RESPONSE. */
function makeSearchUseCase(): SearchUseCase {
  return {
    execute: vi.fn().mockResolvedValue(STUB_RESPONSE),
  } as unknown as SearchUseCase;
}

/** Builds a ReplayUseCase backed by the provided inner searchUseCase. */
function makeReplayUseCase(searchUseCase: SearchUseCase): ReplayUseCase {
  return new ReplayUseCase({ searchUseCase });
}

function makeReplayUseCaseWithVersions(searchUseCase: SearchUseCase): ReplayUseCase {
  return new ReplayUseCase({
    searchUseCase,
    snapshotVersions: {
      modelVersions: { embedding: 'bge-m3-v1.2' },
      indexVersions: { wine_content: '2026-04-01' },
    },
  });
}

/** Minimal valid replay request using a matching snapshot. */
function makeRequest(snapshot: DecisionSnapshot = VALID_SNAPSHOT): ReplayRequest {
  return {
    query: 'Opus One 2018',
    decision_snapshot: snapshot,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('ReplayUseCase', () => {
  describe('exact snapshot match', () => {
    it('returns SearchResponseV1 when snapshot matches', async () => {
      const inner = makeSearchUseCase();
      const useCase = makeReplayUseCase(inner);
      const result = await useCase.execute(makeRequest(), 'req-001');
      expect(result).toEqual(STUB_RESPONSE);
    });

    it('matches the injected runtime snapshot versions', async () => {
      const inner = makeSearchUseCase();
      const useCase = makeReplayUseCaseWithVersions(inner);
      const requestSnapshot = buildDecisionSnapshotFromRuntimeVersions({
        modelVersions: { embedding: 'bge-m3-v1.2' },
        indexVersions: { wine_content: '2026-04-01' },
      });
      const result = await useCase.execute(makeRequest(requestSnapshot), 'req-001b');
      expect(result).toEqual(STUB_RESPONSE);
    });
  });

  describe('snapshot mismatch', () => {
    it('throws SNAPSHOT_MISMATCH when policy_rule_version differs', async () => {
      const inner = makeSearchUseCase();
      const useCase = makeReplayUseCase(inner);
      const request = makeRequest({ ...VALID_SNAPSHOT, policy_rule_version: '9.9.9' });
      await expect(useCase.execute(request, 'req-002')).rejects.toMatchObject({
        code: 'SNAPSHOT_MISMATCH',
      });
    });

    it('throws SNAPSHOT_MISMATCH when threshold_profile_id differs', async () => {
      const inner = makeSearchUseCase();
      const useCase = makeReplayUseCase(inner);
      const request = makeRequest({ ...VALID_SNAPSHOT, threshold_profile_id: 'aggressive' });
      await expect(useCase.execute(request, 'req-003')).rejects.toMatchObject({
        code: 'SNAPSHOT_MISMATCH',
      });
    });

    it('throws SNAPSHOT_MISMATCH when planner_version differs', async () => {
      const inner = makeSearchUseCase();
      const useCase = makeReplayUseCase(inner);
      const request = makeRequest({ ...VALID_SNAPSHOT, planner_version: '2.0.0' });
      await expect(useCase.execute(request, 'req-004')).rejects.toMatchObject({
        code: 'SNAPSHOT_MISMATCH',
      });
    });

    it('throws SNAPSHOT_MISMATCH when model_versions has an extra key', async () => {
      const inner = makeSearchUseCase();
      const useCase = makeReplayUseCase(inner);
      const request = makeRequest({
        ...VALID_SNAPSHOT,
        model_versions: { embedding: 'bge-m3-v1.2' },
      });
      await expect(useCase.execute(request, 'req-005')).rejects.toMatchObject({
        code: 'SNAPSHOT_MISMATCH',
      });
    });

    it('throws SNAPSHOT_MISMATCH when feature_flags has a different value', async () => {
      const inner = makeSearchUseCase();
      const useCase = makeReplayUseCase(inner);
      const request = makeRequest({
        ...VALID_SNAPSHOT,
        feature_flags: { experimental_reranker: true },
      });
      await expect(useCase.execute(request, 'req-006')).rejects.toMatchObject({
        code: 'SNAPSHOT_MISMATCH',
      });
    });

    it('accepts structurally equal nested feature_flags', () => {
      const inner = makeSearchUseCase();
      const useCase = makeReplayUseCase(inner);
      const expected = {
        ...VALID_SNAPSHOT,
        feature_flags: {
          reranker: {
            enabled: true,
            cohorts: ['control', 'treatment'],
          },
        },
      } satisfies DecisionSnapshot;
      const actual = {
        ...VALID_SNAPSHOT,
        feature_flags: {
          reranker: {
            enabled: true,
            cohorts: ['control', 'treatment'],
          },
        },
      } satisfies DecisionSnapshot;

      expect((useCase as any).snapshotsMatch(expected, actual)).toBe(true);
    });

    it('rejects nested feature_flags mismatches', () => {
      const inner = makeSearchUseCase();
      const useCase = makeReplayUseCase(inner);
      const expected = {
        ...VALID_SNAPSHOT,
        feature_flags: {
          reranker: {
            enabled: true,
            cohorts: ['control', 'treatment'],
          },
        },
      } satisfies DecisionSnapshot;
      const actual = {
        ...VALID_SNAPSHOT,
        feature_flags: {
          reranker: {
            enabled: true,
            cohorts: ['control'],
          },
        },
      } satisfies DecisionSnapshot;

      expect((useCase as any).snapshotsMatch(expected, actual)).toBe(false);
    });
  });

  describe('error properties', () => {
    it('SnapshotMismatchError has code SNAPSHOT_MISMATCH and no retryable flag', async () => {
      const inner = makeSearchUseCase();
      const useCase = makeReplayUseCase(inner);
      const request = makeRequest({ ...VALID_SNAPSHOT, planner_version: '0.0.1' });
      try {
        await useCase.execute(request, 'req-007');
        expect.fail('Expected SnapshotMismatchError to be thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SnapshotMismatchError);
        const e = err as SnapshotMismatchError;
        expect(e.code).toBe('SNAPSHOT_MISMATCH');
        // DomainError / SnapshotMismatchError does not expose a retryable flag.
        // The absence or falsy value of `retryable` means it is not retryable.
        expect((e as Record<string, unknown>)['retryable']).toBeFalsy();
      }
    });

    it('UnexpectedReplayResponseError has code UNEXPECTED_REPLAY_RESPONSE', async () => {
      const inner = {
        execute: vi.fn().mockResolvedValue({
          ...STUB_RESPONSE,
          queryType: 'comparison',
        }),
      } as unknown as SearchUseCase;
      const useCase = makeReplayUseCase(inner);
      try {
        await useCase.execute(makeRequest(), 'req-008');
        expect.fail('Expected UnexpectedReplayResponseError to be thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnexpectedReplayResponseError);
        const e = err as UnexpectedReplayResponseError;
        expect(e.code).toBe('UNEXPECTED_REPLAY_RESPONSE');
      }
    });
  });

  describe('requestId passthrough', () => {
    it('passes requestId through to the inner search call', async () => {
      const inner = makeSearchUseCase();
      const useCase = makeReplayUseCase(inner);
      const requestId = 'my-special-request-id';
      await useCase.execute(makeRequest(), requestId);
       
      expect(inner.execute).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'Opus One 2018' }),
        requestId,
      );
    });
  });
});
