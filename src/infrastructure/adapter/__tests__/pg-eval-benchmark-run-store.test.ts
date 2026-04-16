import { describe, expect, it, vi } from 'vitest';
import { PgEvalBenchmarkRunStore } from '../pg-eval-benchmark-run-store.js';

describe('PgEvalBenchmarkRunStore', () => {
  it('persists and lists noisy benchmark runs with newest-first ordering', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            run_id: 'run-2',
            benchmark_kind: 'noisy_entity',
            search_snapshot_id: 'snapshot-b',
            eval_dataset_version: 'pg_gold_set_store.v1',
            feature_schema_hash: 'feature-hash',
            query_count: 20,
            recall_at_1: 0.95,
            recall_at_3: 1,
            mrr: 0.98,
            false_exact_rate: 0,
            release_gate_passed: true,
            activation_status: 'activated',
            report_json: { benchmark: 'noisy-entity-benchmark', query_count: 20 },
            metrics: null,
            created_at: new Date('2026-04-17T01:00:00.000Z'),
          },
          {
            run_id: 'run-1',
            benchmark_kind: 'noisy_entity',
            search_snapshot_id: 'snapshot-a',
            eval_dataset_version: 'pg_gold_set_store.v1',
            feature_schema_hash: 'feature-hash',
            query_count: 10,
            recall_at_1: 1,
            recall_at_3: 1,
            mrr: 1,
            false_exact_rate: null,
            release_gate_passed: false,
            activation_status: 'shadow_only',
            report_json: { benchmark: 'noisy-entity-benchmark', query_count: 10 },
            metrics: null,
            created_at: new Date('2026-04-17T00:00:00.000Z'),
          },
        ],
      });
    const store = new PgEvalBenchmarkRunStore({ query } as never);

    await store.saveRun({
      benchmarkKind: 'noisy_entity',
      snapshotId: 'snapshot-b',
      evalDatasetVersion: 'pg_gold_set_store.v1',
      featureSchemaHash: 'feature-hash',
      queryCount: 20,
      recallAt1: 0.95,
      recallAt3: 1,
      mrr: 0.98,
      falseExactRate: 0,
      releaseGatePassed: true,
      activationStatus: 'activated',
      report: { benchmark: 'noisy-entity-benchmark', query_count: 20 },
      createdAt: new Date('2026-04-17T01:00:00.000Z'),
    });

    const runs = await store.listRuns({
      benchmarkKind: 'noisy_entity',
      limit: 5,
    });

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('INSERT INTO eval_benchmark_runs'),
      expect.arrayContaining([
        'noisy_entity',
        'snapshot-b',
        'pg_gold_set_store.v1',
        'feature-hash',
        20,
      ]),
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('FROM eval_benchmark_runs'),
      ['noisy_entity', 5],
    );
    expect(runs).toEqual([
      expect.objectContaining({
        runId: 'run-2',
        snapshotId: 'snapshot-b',
        activationStatus: 'activated',
        releaseGatePassed: true,
        recallAt3: 1,
      }),
      expect.objectContaining({
        runId: 'run-1',
        snapshotId: 'snapshot-a',
        activationStatus: 'shadow_only',
        releaseGatePassed: false,
      }),
    ]);
  });

  it('roundtrips offline_eval row with snapshotId', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            run_id: 'run-offline-1',
            benchmark_kind: 'offline_eval',
            search_snapshot_id: 'snap-offline',
            eval_dataset_version: 'pg_gold_set_store.v2',
            feature_schema_hash: 'hash-offline',
            query_count: 50,
            recall_at_1: 0.9,
            recall_at_3: 0.97,
            mrr: 0.93,
            false_exact_rate: 0.02,
            release_gate_passed: true,
            activation_status: 'activated',
            report_json: { benchmark: 'offline-eval' },
            metrics: null,
            created_at: new Date('2026-04-17T02:00:00.000Z'),
          },
        ],
      });
    const store = new PgEvalBenchmarkRunStore({ query } as never);

    await store.saveRun({
      benchmarkKind: 'offline_eval',
      snapshotId: 'snap-offline',
      evalDatasetVersion: 'pg_gold_set_store.v2',
      featureSchemaHash: 'hash-offline',
      queryCount: 50,
      recallAt1: 0.9,
      recallAt3: 0.97,
      mrr: 0.93,
      falseExactRate: 0.02,
      releaseGatePassed: true,
      activationStatus: 'activated',
      report: { benchmark: 'offline-eval' },
      createdAt: new Date('2026-04-17T02:00:00.000Z'),
    });

    const runs = await store.listRuns({ benchmarkKind: 'offline_eval' });

    // saveRun INSERT에 snapshotId가 올바르게 전달되었는지 확인
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('INSERT INTO eval_benchmark_runs'),
      expect.arrayContaining(['offline_eval', 'snap-offline']),
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual(expect.objectContaining({
      runId: 'run-offline-1',
      benchmarkKind: 'offline_eval',
      snapshotId: 'snap-offline',
      recallAt1: 0.9,
      releaseGatePassed: true,
    }));
  });

  it('roundtrips entity_retrieval_fixture row WITHOUT snapshotId (null)', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            run_id: 'run-fixture-1',
            benchmark_kind: 'entity_retrieval_fixture',
            search_snapshot_id: null,
            eval_dataset_version: 'fixture.v1',
            feature_schema_hash: 'hash-fixture',
            query_count: 15,
            recall_at_1: null,
            recall_at_3: null,
            mrr: null,
            false_exact_rate: null,
            release_gate_passed: false,
            activation_status: 'shadow_only',
            report_json: { benchmark: 'entity-retrieval-fixture', cases: 15 },
            metrics: null,
            created_at: new Date('2026-04-17T03:00:00.000Z'),
          },
        ],
      });
    const store = new PgEvalBenchmarkRunStore({ query } as never);

    // snapshotId 생략 — fixture eval은 snapshot 없이 실행 가능
    await store.saveRun({
      benchmarkKind: 'entity_retrieval_fixture',
      evalDatasetVersion: 'fixture.v1',
      featureSchemaHash: 'hash-fixture',
      queryCount: 15,
      releaseGatePassed: false,
      activationStatus: 'shadow_only',
      report: { benchmark: 'entity-retrieval-fixture', cases: 15 },
      createdAt: new Date('2026-04-17T03:00:00.000Z'),
    });

    // INSERT 파라미터에서 snapshotId 자리에 null이 들어가는지 확인
    const insertParams = query.mock.calls[0]![1] as unknown[];
    // param index 2 = search_snapshot_id
    expect(insertParams[2]).toBeNull();

    const runs = await store.listRuns({ benchmarkKind: 'entity_retrieval_fixture' });

    expect(runs).toHaveLength(1);
    // snapshotId 키가 아예 없어야 함 (exactOptionalPropertyTypes 패턴)
    expect(runs[0]).not.toHaveProperty('snapshotId');
    expect(runs[0]).toEqual(expect.objectContaining({
      runId: 'run-fixture-1',
      benchmarkKind: 'entity_retrieval_fixture',
      queryCount: 15,
      releaseGatePassed: false,
      activationStatus: 'shadow_only',
    }));
  });

  it('throws on invalid benchmark_kind from DB', async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          run_id: 'run-bad',
          benchmark_kind: 'unknown_kind',
          search_snapshot_id: null,
          eval_dataset_version: 'v1',
          feature_schema_hash: 'hash',
          query_count: 1,
          recall_at_1: null,
          recall_at_3: null,
          mrr: null,
          false_exact_rate: null,
          release_gate_passed: false,
          activation_status: 'shadow_only',
          report_json: {},
          metrics: null,
          created_at: new Date(),
        },
      ],
    });
    const store = new PgEvalBenchmarkRunStore({ query } as never);

    await expect(store.listRuns()).rejects.toThrow('Invalid benchmark_kind from DB: unknown_kind');
  });

  it('ignores NaN limit (does not interpolate NaN into SQL)', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    const store = new PgEvalBenchmarkRunStore({ query } as never);

    await store.listRuns({ limit: NaN });

    const sql = query.mock.calls[0]![0] as string;
    expect(sql).not.toContain('LIMIT');
    expect(query).toHaveBeenCalledWith(expect.any(String), []);
  });

  it('parameterizes LIMIT instead of interpolating it', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    const store = new PgEvalBenchmarkRunStore({ query } as never);

    await store.listRuns({ limit: 10 });

    const sql = query.mock.calls[0]![0] as string;
    expect(sql).toContain('LIMIT $1');
    expect(query).toHaveBeenCalledWith(expect.any(String), [10]);
  });

  it('roundtrips metrics JSONB (save and read back numeric key-value pairs)', async () => {
    const inputMetrics = { ndcg_at_10: 0.85, decision_utility: 0.72 };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            run_id: 'run-metrics-1',
            benchmark_kind: 'search_feature_behavior_fixture',
            search_snapshot_id: 'snap-metrics',
            eval_dataset_version: 'fixture.v1',
            feature_schema_hash: 'hash-metrics',
            query_count: 30,
            recall_at_1: null,
            recall_at_3: null,
            mrr: null,
            false_exact_rate: null,
            release_gate_passed: true,
            activation_status: 'activated',
            report_json: { benchmark: 'feature-behavior' },
            metrics: { ndcg_at_10: 0.85, decision_utility: 0.72 },
            created_at: new Date('2026-04-17T04:00:00.000Z'),
          },
        ],
      });
    const store = new PgEvalBenchmarkRunStore({ query } as never);

    await store.saveRun({
      benchmarkKind: 'search_feature_behavior_fixture',
      snapshotId: 'snap-metrics',
      evalDatasetVersion: 'fixture.v1',
      featureSchemaHash: 'hash-metrics',
      queryCount: 30,
      releaseGatePassed: true,
      activationStatus: 'activated',
      report: { benchmark: 'feature-behavior' },
      metrics: inputMetrics,
      createdAt: new Date('2026-04-17T04:00:00.000Z'),
    });

    // INSERT에 metrics JSON이 직렬화되어 전달되었는지 확인
    const insertParams = query.mock.calls[0]![1] as unknown[];
    // param index 13 = metrics
    expect(insertParams[13]).toBe(JSON.stringify(inputMetrics));

    const runs = await store.listRuns({ benchmarkKind: 'search_feature_behavior_fixture' });

    expect(runs).toHaveLength(1);
    expect(runs[0]!.metrics).toEqual({ ndcg_at_10: 0.85, decision_utility: 0.72 });
  });
});
