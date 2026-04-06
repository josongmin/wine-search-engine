import { describe, it, expect, vi } from 'vitest';
import { ReplayUseCase, SnapshotMismatchError } from '../../../src/application/search/replay.usecase.js';
import type { ReplayRequest } from '../../../src/application/search/replay.usecase.js';
import type { SearchUseCase } from '../../../src/application/search/search.usecase.js';
import type { SearchResponseV1 } from '../../../src/domain/response/model/search-response.js';
import type { DecisionSnapshot } from '../../../src/domain/shared/types/index.js';

// ── Fixtures ───────────────────────────────────────────────────────────────────

/** The snapshot that ReplayUseCase.buildCurrentSnapshot() produces internally. */
const VALID_SNAPSHOT: DecisionSnapshot = {
  model_versions: {},
  index_versions: {},
  policy_rule_version: '1.0.0',
  threshold_profile_id: 'default',
  planner_version: '1.0.0',
  feature_flags: {},
};

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
