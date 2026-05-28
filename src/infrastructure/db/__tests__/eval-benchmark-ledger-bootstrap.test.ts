import { describe, expect, it, vi } from 'vitest';
import {
  EVAL_BENCHMARK_LEDGER_BOOTSTRAP_STATEMENTS,
  ensureEvalBenchmarkLedgerBootstrap,
} from '../eval-benchmark-ledger-bootstrap.js';

/**
 * Shape-matched mock signature for {@link PgQueryable.query}. Declaring the
 * argument tuple explicitly lets `mock.calls[N][0]` narrow to `string` without
 * collapsing to the empty-tuple inferred from `vi.fn(async () => ...)`.
 */
type MockQueryFn = (text: string, values?: readonly unknown[]) => Promise<{
  rows: readonly unknown[];
  rowCount?: number | null;
}>;

describe('ensureEvalBenchmarkLedgerBootstrap', () => {
  it('applies the targeted 017/018/019 final schema contract once per queryable', async () => {
    const query = vi.fn<MockQueryFn>(async () => Promise.resolve({ rows: [] }));
    const queryable = { query };

    await ensureEvalBenchmarkLedgerBootstrap(queryable);
    await ensureEvalBenchmarkLedgerBootstrap(queryable);

    expect(query).toHaveBeenCalledTimes(EVAL_BENCHMARK_LEDGER_BOOTSTRAP_STATEMENTS.length);
    expect(query.mock.calls[0]?.[0]).toContain('CREATE TABLE IF NOT EXISTS eval_benchmark_runs');
    expect(query.mock.calls[1]?.[0]).toContain('ALTER COLUMN search_snapshot_id DROP NOT NULL');
    expect(query.mock.calls.some(([sql]) => sql.includes('ADD COLUMN IF NOT EXISTS metrics JSONB'))).toBe(true);
    expect(query.mock.calls.at(-4)?.[0]).toContain('DROP VIEW IF EXISTS eval_benchmark_run_trends_v');
    expect(query.mock.calls.at(-3)?.[0]).toContain('DROP VIEW IF EXISTS eval_benchmark_run_metrics_v');
    expect(query.mock.calls.at(-2)?.[0]).toContain('CREATE OR REPLACE VIEW eval_benchmark_run_metrics_v');
    expect(query.mock.calls.at(-1)?.[0]).toContain('CREATE OR REPLACE VIEW eval_benchmark_run_trends_v');
  });

  it('clears the cache when bootstrap fails so the next attempt can retry', async () => {
    const query = vi.fn<MockQueryFn>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ rows: [] });
    const queryable = { query };

    await expect(ensureEvalBenchmarkLedgerBootstrap(queryable)).rejects.toThrow('boom');
    await expect(ensureEvalBenchmarkLedgerBootstrap(queryable)).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledTimes(1 + EVAL_BENCHMARK_LEDGER_BOOTSTRAP_STATEMENTS.length);
  });
});
