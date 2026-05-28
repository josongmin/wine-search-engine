import { describe, expect, it, vi } from 'vitest';
import { PgEvalBenchmarkRunStore } from '../pg-eval-benchmark-run-store.js';
import { EVAL_BENCHMARK_LEDGER_BOOTSTRAP_STATEMENTS } from '../../db/eval-benchmark-ledger-bootstrap.js';

function makeProvenance(overrides: Partial<{
  corpusId: string;
  corpusHash: string;
  runtimeTarget: string;
  usesLiveApi: boolean;
  smokeSynthesized: boolean;
  thresholdSource: string;
  gateEligible: boolean;
  suiteGatePassed: boolean;
  searchSnapshotId?: string;
  runtimeActivationStatus?: 'activated' | 'shadow_only';
  readinessPassed?: boolean;
  activeLtrModels?: number;
}> = {}) {
  return {
    provenanceSchemaVersion: 1 as const,
    corpusId: 'fixture.v1',
    corpusHash: 'corpus-hash',
    runtimeTarget: 'search_api_http',
    usesLiveApi: true,
    smokeSynthesized: false,
    thresholdSource: 'external_fixture_thresholds',
    gateEligible: true,
    suiteGatePassed: true,
    searchSnapshotId: 'snapshot-a',
    runtimeActivationStatus: 'activated' as const,
    readinessPassed: true,
    activeLtrModels: 2,
    ...overrides,
  };
}

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  const provenance = makeProvenance();
  return {
    run_id: 'run-1',
    benchmark_kind: 'noisy_entity',
    search_snapshot_id: provenance.searchSnapshotId ?? null,
    eval_dataset_version: provenance.corpusId,
    feature_schema_hash: 'feature-hash',
    query_count: 10,
    recall_at_1: 1,
    recall_at_3: 1,
    mrr: 1,
    false_exact_rate: null,
    release_gate_passed: provenance.gateEligible && provenance.suiteGatePassed,
    activation_status: provenance.runtimeActivationStatus ?? null,
    provenance_schema_version: provenance.provenanceSchemaVersion,
    corpus_id: provenance.corpusId,
    corpus_hash: provenance.corpusHash,
    runtime_target: provenance.runtimeTarget,
    uses_live_api: provenance.usesLiveApi,
    smoke_synthesized: provenance.smokeSynthesized,
    threshold_source: provenance.thresholdSource,
    gate_eligible: provenance.gateEligible,
    suite_gate_passed: provenance.suiteGatePassed,
    readiness_passed: provenance.readinessPassed,
    active_ltr_models: provenance.activeLtrModels,
    label_tier_mix: null,
    slice_mix: null,
    query_class_mix: null,
    runtime_activation_status: provenance.runtimeActivationStatus ?? null,
    report_json: { benchmark: 'default-report' },
    metrics: null,
    created_at: new Date('2026-04-17T00:00:00.000Z'),
    ...overrides,
  };
}

describe('PgEvalBenchmarkRunStore', () => {
  it('persists and lists noisy benchmark runs with newest-first ordering', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          makeRow({
            run_id: 'run-2',
            search_snapshot_id: 'snapshot-b',
            eval_dataset_version: 'pg_gold_set_store.v1',
            corpus_id: 'pg_gold_set_store.v1',
            query_count: 20,
            recall_at_1: 0.95,
            recall_at_3: 1,
            mrr: 0.98,
            false_exact_rate: 0,
            report_json: { benchmark: 'noisy-entity-benchmark', query_count: 20 },
            created_at: new Date('2026-04-17T01:00:00.000Z'),
          }),
          makeRow({
            run_id: 'run-1',
            search_snapshot_id: 'snapshot-a',
            eval_dataset_version: 'pg_gold_set_store.v1',
            corpus_id: 'pg_gold_set_store.v1',
            release_gate_passed: false,
            activation_status: 'shadow_only',
            suite_gate_passed: false,
            runtime_activation_status: 'shadow_only',
            report_json: { benchmark: 'noisy-entity-benchmark', query_count: 10 },
            created_at: new Date('2026-04-17T00:00:00.000Z'),
          }),
        ],
      });
    const store = new PgEvalBenchmarkRunStore({ query } as never);

    await store.saveRun({
      benchmarkKind: 'noisy_entity',
      evalDatasetVersion: 'pg_gold_set_store.v1',
      featureSchemaHash: 'feature-hash',
      queryCount: 20,
      recallAt1: 0.95,
      recallAt3: 1,
      mrr: 0.98,
      falseExactRate: 0,
      provenance: makeProvenance({
        corpusId: 'pg_gold_set_store.v1',
        searchSnapshotId: 'snapshot-b',
        runtimeActivationStatus: 'activated',
      }),
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
        runtimeActivationStatus: 'activated',
        releaseGatePassed: true,
        recallAt3: 1,
      }),
      expect.objectContaining({
        runId: 'run-1',
        snapshotId: 'snapshot-a',
        runtimeActivationStatus: 'shadow_only',
        releaseGatePassed: false,
      }),
    ]);
  });

  it('roundtrips offline_eval row with snapshotId', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          makeRow({
            run_id: 'run-offline-1',
            benchmark_kind: 'offline_eval_live_runtime',
            search_snapshot_id: 'snap-offline',
            eval_dataset_version: 'pg_gold_set_store.v2',
            corpus_id: 'pg_gold_set_store.v2',
            feature_schema_hash: 'hash-offline',
            query_count: 50,
            recall_at_1: 0.9,
            recall_at_3: 0.97,
            mrr: 0.93,
            false_exact_rate: 0.02,
            report_json: { benchmark: 'offline-eval' },
            created_at: new Date('2026-04-17T02:00:00.000Z'),
          }),
        ],
      });
    const store = new PgEvalBenchmarkRunStore({ query } as never);

    await store.saveRun({
      benchmarkKind: 'offline_eval_live_runtime',
      evalDatasetVersion: 'pg_gold_set_store.v2',
      featureSchemaHash: 'hash-offline',
      queryCount: 50,
      recallAt1: 0.9,
      recallAt3: 0.97,
      mrr: 0.93,
      falseExactRate: 0.02,
      provenance: makeProvenance({
        corpusId: 'pg_gold_set_store.v2',
        searchSnapshotId: 'snap-offline',
      }),
      report: { benchmark: 'offline-eval' },
      createdAt: new Date('2026-04-17T02:00:00.000Z'),
    });

    const runs = await store.listRuns({ benchmarkKind: 'offline_eval_live_runtime' });

    // saveRun INSERT에 snapshotId가 올바르게 전달되었는지 확인
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('INSERT INTO eval_benchmark_runs'),
      expect.arrayContaining(['offline_eval_live_runtime', 'snap-offline']),
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual(expect.objectContaining({
      runId: 'run-offline-1',
      benchmarkKind: 'offline_eval_live_runtime',
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
          makeRow({
            run_id: 'run-fixture-1',
            benchmark_kind: 'entity_retrieval_fixture',
            search_snapshot_id: null,
            corpus_id: 'fixture.v1',
            eval_dataset_version: 'fixture.v1',
            feature_schema_hash: 'hash-fixture',
            query_count: 15,
            recall_at_1: null,
            recall_at_3: null,
            mrr: null,
            false_exact_rate: null,
            release_gate_passed: false,
            activation_status: null,
            runtime_target: 'prediction_file',
            uses_live_api: false,
            threshold_source: 'external_fixture_thresholds',
            gate_eligible: false,
            suite_gate_passed: false,
            readiness_passed: null,
            active_ltr_models: null,
            runtime_activation_status: null,
            report_json: { benchmark: 'entity-retrieval-fixture', cases: 15 },
            created_at: new Date('2026-04-17T03:00:00.000Z'),
          }),
        ],
      });
    const store = new PgEvalBenchmarkRunStore({ query } as never);

    // snapshotId 생략 — fixture eval은 snapshot 없이 실행 가능
    await store.saveRun({
      benchmarkKind: 'entity_retrieval_fixture',
      evalDatasetVersion: 'fixture.v1',
      featureSchemaHash: 'hash-fixture',
      queryCount: 15,
      provenance: makeProvenance({
        corpusId: 'fixture.v1',
        searchSnapshotId: undefined,
        runtimeTarget: 'prediction_file',
        usesLiveApi: false,
        gateEligible: false,
        suiteGatePassed: false,
        runtimeActivationStatus: undefined,
        readinessPassed: undefined,
        activeLtrModels: undefined,
      }),
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
    }));
  });

  it('throws on invalid benchmark_kind from DB', async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        makeRow({
          run_id: 'run-bad',
          benchmark_kind: 'unknown_kind',
          search_snapshot_id: null,
          eval_dataset_version: 'v1',
          corpus_id: 'v1',
          feature_schema_hash: 'hash',
          query_count: 1,
          recall_at_1: null,
          recall_at_3: null,
          mrr: null,
          false_exact_rate: null,
          release_gate_passed: false,
          activation_status: null,
          runtime_target: 'prediction_file',
          uses_live_api: false,
          smoke_synthesized: false,
          gate_eligible: false,
          suite_gate_passed: false,
          readiness_passed: null,
          active_ltr_models: null,
          runtime_activation_status: null,
          report_json: {},
          created_at: new Date(),
        }),
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
          makeRow({
            run_id: 'run-metrics-1',
            benchmark_kind: 'search_feature_behavior_live',
            search_snapshot_id: 'snap-metrics',
            eval_dataset_version: 'fixture.v1',
            corpus_id: 'fixture.v1',
            feature_schema_hash: 'hash-metrics',
            query_count: 30,
            recall_at_1: null,
            recall_at_3: null,
            mrr: null,
            false_exact_rate: null,
            report_json: { benchmark: 'feature-behavior' },
            metrics: { ndcg_at_10: 0.85, decision_utility: 0.72 },
            created_at: new Date('2026-04-17T04:00:00.000Z'),
          }),
        ],
      });
    const store = new PgEvalBenchmarkRunStore({ query } as never);

    await store.saveRun({
      benchmarkKind: 'search_feature_behavior_live',
      evalDatasetVersion: 'fixture.v1',
      featureSchemaHash: 'hash-metrics',
      queryCount: 30,
      provenance: makeProvenance({
        corpusId: 'fixture.v1',
        searchSnapshotId: 'snap-metrics',
      }),
      report: { benchmark: 'feature-behavior' },
      metrics: inputMetrics,
      createdAt: new Date('2026-04-17T04:00:00.000Z'),
    });

    // INSERT에 metrics JSON이 직렬화되어 전달되었는지 확인
    const insertParams = query.mock.calls[0]![1] as unknown[];
    expect(insertParams).toContain(JSON.stringify(inputMetrics));

    const runs = await store.listRuns({ benchmarkKind: 'search_feature_behavior_live' });

    expect(runs).toHaveLength(1);
    expect(runs[0]!.metrics).toEqual({ ndcg_at_10: 0.85, decision_utility: 0.72 });
  });

  it('bootstraps the targeted ledger schema and retries saveRun on 42P01', async () => {
    const missingTable = new Error('relation "eval_benchmark_runs" does not exist') as Error & { code: string };
    missingTable.code = '42P01';
    const query = vi.fn()
      .mockRejectedValueOnce(missingTable)
      .mockImplementation(async () => ({ rows: [] }));
    const store = new PgEvalBenchmarkRunStore({ query } as never);

    await store.saveRun({
      benchmarkKind: 'agentic_tool_use_fixture',
      evalDatasetVersion: 'fixture.v1',
      featureSchemaHash: 'hash-fixture',
      queryCount: 6,
      provenance: makeProvenance({
        corpusId: 'fixture.v1',
        runtimeTarget: 'fixture_structural_predictions',
        usesLiveApi: false,
        smokeSynthesized: true,
        gateEligible: false,
        suiteGatePassed: true,
        searchSnapshotId: undefined,
        runtimeActivationStatus: undefined,
        readinessPassed: undefined,
        activeLtrModels: undefined,
      }),
      report: { benchmark: 'agentic-tool-use-fixture' },
      metrics: { tool_selection_accuracy: 1 },
      createdAt: new Date('2026-04-22T00:00:00.000Z'),
    });

    expect(query).toHaveBeenCalledTimes(2 + EVAL_BENCHMARK_LEDGER_BOOTSTRAP_STATEMENTS.length);
    expect(query.mock.calls[1]?.[0]).toContain('CREATE TABLE IF NOT EXISTS eval_benchmark_runs');
    expect(query.mock.calls.at(-1)?.[0]).toContain('INSERT INTO eval_benchmark_runs');
  });

  it('bootstraps the targeted ledger schema and retries saveRun on legacy 017 metrics-column miss', async () => {
    const missingColumn = new Error('column "metrics" of relation "eval_benchmark_runs" does not exist') as Error & {
      code: string;
    };
    missingColumn.code = '42703';
    const query = vi.fn()
      .mockRejectedValueOnce(missingColumn)
      .mockImplementation(async () => ({ rows: [] }));
    const store = new PgEvalBenchmarkRunStore({ query } as never);

    await store.saveRun({
      benchmarkKind: 'search_feature_behavior_live',
      evalDatasetVersion: 'fixture.v1',
      featureSchemaHash: 'hash-metrics',
      queryCount: 30,
      provenance: makeProvenance({
        corpusId: 'fixture.v1',
        searchSnapshotId: 'snap-metrics',
      }),
      report: { benchmark: 'feature-behavior' },
      metrics: { ndcg_at_10: 0.85 },
      createdAt: new Date('2026-04-22T00:00:00.000Z'),
    });

    expect(query).toHaveBeenCalledTimes(2 + EVAL_BENCHMARK_LEDGER_BOOTSTRAP_STATEMENTS.length);
    expect(
      query.mock.calls.some(([sql]) =>
        typeof sql === 'string' && sql.includes('ADD COLUMN IF NOT EXISTS metrics JSONB')),
    ).toBe(true);
    expect(query.mock.calls.at(-1)?.[0]).toContain('INSERT INTO eval_benchmark_runs');
  });
});
