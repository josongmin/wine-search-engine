import { describe, expect, it, vi } from 'vitest';

import {
  bootstrapBenchmarkLedgerPersistence,
  type BenchmarkLedgerRunInput,
} from '../../../scripts/eval/benchmark-ledger-bootstrap.ts';

function makeRunInput(): BenchmarkLedgerRunInput {
  return {
    benchmarkKind: 'agentic_answer_quality_fixture',
    evalDatasetVersion: 'v1',
    featureSchemaHash: 'feature-hash',
    queryCount: 3,
    provenance: {
      provenanceSchemaVersion: 1,
      corpusId: 'fixture:agentic_answer_quality',
      corpusHash: 'corpus-hash',
      runtimeTarget: 'fixture_structural_predictions',
      usesLiveApi: false,
      smokeSynthesized: true,
      thresholdSource: 'external_fixture_thresholds',
      gateEligible: false,
      suiteGatePassed: true,
    },
    report: { benchmark: 'agentic-answer-quality-fixture', query_count: 3 },
    metrics: {
      rubric_pass_rate: 1,
      pass_rate: 1,
    },
    createdAt: new Date('2026-04-22T00:00:00.000Z'),
  };
}

describe('benchmark ledger bootstrap helper', () => {
  it('skips persistence when eval_benchmark_runs is absent from the schema search path', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const end = vi.fn().mockResolvedValue(undefined);

    const ledger = await bootstrapBenchmarkLedgerPersistence({
      createPool: async () => ({ query, end }),
    });

    expect(ledger).toEqual(expect.objectContaining({
      status: 'skipped',
      reason: 'table_missing',
    }));
    await ledger.close();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('persists fixture runs against the expanded ledger schema with nullable snapshot and metrics', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [
          { table_schema: 'public', column_name: 'run_id', is_nullable: 'NO' },
          { table_schema: 'public', column_name: 'search_snapshot_id', is_nullable: 'YES' },
          { table_schema: 'public', column_name: 'metrics', is_nullable: 'YES' },
          { table_schema: 'public', column_name: 'provenance_schema_version', is_nullable: 'NO' },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const end = vi.fn().mockResolvedValue(undefined);

    const ledger = await bootstrapBenchmarkLedgerPersistence({
      createPool: async () => ({ query, end }),
    });
    expect(ledger.status).toBe('ready');
    if (ledger.status !== 'ready') {
      throw new Error('expected ready bootstrap');
    }

    const result = await ledger.persistRun(makeRunInput());

    expect(result.status).toBe('persisted');
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO eval_benchmark_runs'),
      expect.arrayContaining([
        'agentic_answer_quality_fixture',
        null,
        'v1',
        'feature-hash',
      ]),
    );
    const insertSql = query.mock.calls[1]?.[0];
    expect(typeof insertSql).toBe('string');
    expect(insertSql).toContain('metrics');
    await ledger.close();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('fails closed on legacy schema when snapshot_id remains NOT NULL', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { table_schema: 'public', column_name: 'run_id', is_nullable: 'NO' },
        { table_schema: 'public', column_name: 'search_snapshot_id', is_nullable: 'NO' },
      ],
    });
    const end = vi.fn().mockResolvedValue(undefined);

    const ledger = await bootstrapBenchmarkLedgerPersistence({
      createPool: async () => ({ query, end }),
    });
    expect(ledger.status).toBe('ready');
    if (ledger.status !== 'ready') {
      throw new Error('expected ready bootstrap');
    }

    const result = await ledger.persistRun(makeRunInput());

    expect(result).toEqual(expect.objectContaining({
      status: 'skipped',
      reason: 'snapshot_required',
    }));
    expect(query).toHaveBeenCalledTimes(1);
    await ledger.close();
    expect(end).toHaveBeenCalledTimes(1);
  });
});
