/**
 * Regression: per-channel retrieval telemetry on RrfFusionTrace.
 *
 * Wave 2 introduced `RrfFusionTrace.perChannel` so operators can see,
 * for a single request, which channels actually fired vs. went dormant
 * vs. failed (and how much each contributed to the final ordering).
 *
 * Locks:
 *  - The trace shape carries one row per considered channel
 *    (sparse_bm25, learned_sparse, dense_semantic, anchor_similarity).
 *  - `hitCount` reports the raw hits returned by each channel.
 *  - `firingState` reports `'active'` when the channel ran and
 *    produced ≥ 0 hits, `'dormant'` when the channel was not selected
 *    (e.g. learned_sparse with `killSwitchLearning=true`,
 *    anchor_similarity with no anchor present), `'timeout'` on
 *    AbortError, `'circuit_breaker_open'` on CircuitBreakerOpenError,
 *    and `'error'` on any other infra failure.
 *  - `fusionContribution` for a dormant / failed channel is 0.
 *
 * Append-only per CLAUDE.md regression-test discipline.
 */
import { describe, expect, it, vi } from 'vitest';
import { CandidatePoolService } from '../../src/domain/retrieval/service/candidate-pool.js';
import { FusionService } from '../../src/domain/retrieval/service/fusion.js';
import { CircuitBreakerOpenError } from '../../src/domain/shared/error/circuit-breaker-open-error.js';
import type { QueryPlanV1 } from '../../src/domain/query/model/query-plan.js';
import type { HybridRetrievalInput } from '../../src/domain/retrieval/model/retrieval-input.js';
import type { SearchIndexPort, SparseHit, DenseHit } from '../../src/domain/retrieval/port/search-index.port.js';
import type { EmbeddingServicePort } from '../../src/domain/retrieval/port/embedding-service.port.js';

function minimalPlan(overrides: Partial<QueryPlanV1> = {}): QueryPlanV1 {
  return {
    rawQuery: 'q',
    normalizedQuery: 'q',
    intent: 'semantic_discovery',
    route: 'hybrid',
    retrievalMode: 'semantic_hybrid',
    queryClass: 'pure_constraint',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: ['red wine'], semantic: ['red wine'] },
    policy: {} as QueryPlanV1['policy'],
    uncertainty: {} as QueryPlanV1['uncertainty'],
    plannerVersion: '1',
    policyRuleVersion: '1',
    thresholdProfileId: 'default',
    ...overrides,
  } as QueryPlanV1;
}

function makeInput(): HybridRetrievalInput {
  return {
    queryPlan: minimalPlan(),
    route: 'hybrid',
    compiledRetrievalMode: 'semantic_hybrid',
    lexicalQueries: ['red wine'],
    semanticQueries: ['red wine'],
    hardConstraints: [],
    softConstraints: [],
  };
}

function makeSparseHit(entityId: string, rank: number, score: number): SparseHit {
  return {
    entityId,
    score,
    rank,
    matchedFields: ['canonical_label'],
    summary: { canonicalLabel: `wine ${entityId}`, style: 'red', wineType: 'red' },
  };
}

function makeDenseHit(entityId: string, rank: number, similarity: number): DenseHit {
  return {
    entityId,
    score: similarity,
    rank,
    similarity,
    summary: { canonicalLabel: `wine ${entityId}`, style: 'red', wineType: 'red' },
  };
}

const EMBED_SERVICE: EmbeddingServicePort = {
  embed: vi.fn(async (): Promise<readonly number[]> => [0.1, 0.2]),
  embedBatch: vi.fn(
    async (texts: readonly string[]): Promise<readonly (readonly number[])[]> =>
      texts.map((): readonly number[] => [0.1, 0.2]),
  ),
};

describe('retrieval channel telemetry', () => {
  it('emits perChannel rows for sparse, learned_sparse, dense, anchor with correct hit counts', async () => {
    const sparseHits: readonly SparseHit[] = Array.from({ length: 10 }, (_, i) =>
      makeSparseHit(`wine-s${i}`, i + 1, 10 - i),
    );
    const denseHits: readonly DenseHit[] = Array.from({ length: 5 }, (_, i) =>
      makeDenseHit(`wine-d${i}`, i + 1, 0.9 - i * 0.05),
    );

    const searchIndex: SearchIndexPort = {
      sparseSearch: vi.fn(async () => sparseHits),
      denseSearch: vi.fn(async () => denseHits),
      // Empty learned_sparse hits emulates "wired but no production
      // signal" — channel is ACTIVE but contributes zero rows.
      searchLearnedSparse: vi.fn(async () => []),
      getDocument: vi.fn(async () => null),
      upsertDocument: vi.fn(async () => {}),
      bulkUpsert: vi.fn(async () => {}),
    };

    const pool = new CandidatePoolService(
      searchIndex,
      EMBED_SERVICE,
      new FusionService(),
      // No cacheService
      undefined,
      'bge-m3',
      // killSwitchLearning=false → learned_sparse channel is ACTIVE
      // (it just happens to return empty hits in this test).
      false,
    );

    const result = await pool.execute(makeInput());

    expect(result.fusionTrace).toBeDefined();
    const perChannel = result.fusionTrace!.perChannel;
    expect(perChannel).toBeDefined();

    const byChannel = new Map(perChannel.map((row) => [row.channel, row]));
    expect(byChannel.size).toBeGreaterThanOrEqual(3);

    // Sparse channel: 10 hits, active.
    const sparseRow = byChannel.get('sparse_bm25');
    expect(sparseRow).toBeDefined();
    expect(sparseRow!.firingState).toBe('active');
    expect(sparseRow!.hitCount).toBe(10);
    expect(sparseRow!.topKInput).toBeGreaterThan(0);

    // Dense channel: 5 hits, active.
    const denseRow = byChannel.get('dense_semantic');
    expect(denseRow).toBeDefined();
    expect(denseRow!.firingState).toBe('active');
    expect(denseRow!.hitCount).toBe(5);

    // Learned-sparse: wired but empty → active with 0 hits.
    const learnedRow = byChannel.get('learned_sparse');
    expect(learnedRow).toBeDefined();
    expect(learnedRow!.firingState).toBe('active');
    expect(learnedRow!.hitCount).toBe(0);
    // No hits ⇒ no fusion contribution from this channel.
    expect(learnedRow!.fusionContribution).toBe(0);

    // Anchor channel: no anchorProfile in this query plan → DORMANT.
    const anchorRow = byChannel.get('anchor_similarity');
    expect(anchorRow).toBeDefined();
    expect(anchorRow!.firingState).toBe('dormant');
    expect(anchorRow!.hitCount).toBe(0);
    expect(anchorRow!.fusionContribution).toBe(0);
  });

  it('marks a channel as `timeout` when its task throws AbortError', async () => {
    // Throw a DOMException with name='AbortError' to mimic the
    // AbortSignal contract used by Vespa's per-channel deadline.
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';

    const searchIndex: SearchIndexPort = {
      sparseSearch: vi.fn(async () => [makeSparseHit('wine-1', 1, 5)]),
      denseSearch: vi.fn(async () => {
        throw abortErr;
      }),
      searchLearnedSparse: vi.fn(async () => []),
      getDocument: vi.fn(async () => null),
      upsertDocument: vi.fn(async () => {}),
      bulkUpsert: vi.fn(async () => {}),
    };

    const pool = new CandidatePoolService(
      searchIndex,
      EMBED_SERVICE,
      new FusionService(),
      undefined,
      'bge-m3',
      false,
    );
    const result = await pool.execute(makeInput());
    expect(result.fusionTrace).toBeDefined();

    const byChannel = new Map(result.fusionTrace!.perChannel.map((row) => [row.channel, row]));
    const denseRow = byChannel.get('dense_semantic');
    expect(denseRow).toBeDefined();
    expect(denseRow!.firingState).toBe('timeout');
    expect(denseRow!.hitCount).toBe(0);
    expect(denseRow!.fusionContribution).toBe(0);
  });

  it('marks a channel as `circuit_breaker_open` when its task throws CircuitBreakerOpenError', async () => {
    const searchIndex: SearchIndexPort = {
      sparseSearch: vi.fn(async () => {
        throw new CircuitBreakerOpenError('vespa-sparse');
      }),
      denseSearch: vi.fn(async () => [makeDenseHit('wine-1', 1, 0.9)]),
      searchLearnedSparse: vi.fn(async () => []),
      getDocument: vi.fn(async () => null),
      upsertDocument: vi.fn(async () => {}),
      bulkUpsert: vi.fn(async () => {}),
    };

    const pool = new CandidatePoolService(
      searchIndex,
      EMBED_SERVICE,
      new FusionService(),
      undefined,
      'bge-m3',
      false,
    );
    const result = await pool.execute(makeInput());
    expect(result.fusionTrace).toBeDefined();

    const byChannel = new Map(result.fusionTrace!.perChannel.map((row) => [row.channel, row]));
    const sparseRow = byChannel.get('sparse_bm25');
    expect(sparseRow).toBeDefined();
    expect(sparseRow!.firingState).toBe('circuit_breaker_open');
    expect(sparseRow!.hitCount).toBe(0);
  });

  it('marks learned_sparse as `dormant` when killSwitchLearning is true', async () => {
    const searchIndex: SearchIndexPort = {
      sparseSearch: vi.fn(async () => [makeSparseHit('wine-1', 1, 5)]),
      denseSearch: vi.fn(async () => []),
      searchLearnedSparse: vi.fn(async () => {
        // Should never be invoked when the kill switch is on.
        throw new Error('learned-sparse should not be called when killSwitchLearning=true');
      }),
      getDocument: vi.fn(async () => null),
      upsertDocument: vi.fn(async () => {}),
      bulkUpsert: vi.fn(async () => {}),
    };

    const pool = new CandidatePoolService(
      searchIndex,
      EMBED_SERVICE,
      new FusionService(),
      undefined,
      'bge-m3',
      // killSwitchLearning=true → learned_sparse is GATED OFF at active-channel resolution
      true,
    );
    const result = await pool.execute(makeInput());
    expect(result.fusionTrace).toBeDefined();

    const byChannel = new Map(result.fusionTrace!.perChannel.map((row) => [row.channel, row]));
    const learnedRow = byChannel.get('learned_sparse');
    expect(learnedRow).toBeDefined();
    expect(learnedRow!.firingState).toBe('dormant');
    expect(learnedRow!.hitCount).toBe(0);
    expect(learnedRow!.fusionContribution).toBe(0);
    expect(learnedRow!.topKInput).toBe(0);
  });
});
