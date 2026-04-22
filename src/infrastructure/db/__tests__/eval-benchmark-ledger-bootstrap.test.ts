import { describe, expect, it, vi } from 'vitest';
import {
  EVAL_BENCHMARK_LEDGER_BOOTSTRAP_STATEMENTS,
  ensureEvalBenchmarkLedgerBootstrap,
} from '../eval-benchmark-ledger-bootstrap.js';

describe('ensureEvalBenchmarkLedgerBootstrap', () => {
  it('applies the targeted 017/018/019 final schema contract once per queryable', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const queryable = { query };

    await ensureEvalBenchmarkLedgerBootstrap(queryable);
    await ensureEvalBenchmarkLedgerBootstrap(queryable);

    expect(query).toHaveBeenCalledTimes(EVAL_BENCHMARK_LEDGER_BOOTSTRAP_STATEMENTS.length);
    expect(query.mock.calls[0]?.[0]).toContain('CREATE TABLE IF NOT EXISTS eval_benchmark_runs');
    expect(query.mock.calls[1]?.[0]).toContain('ALTER COLUMN search_snapshot_id DROP NOT NULL');
    expect(query.mock.calls[2]?.[0]).toContain('ADD COLUMN IF NOT EXISTS metrics JSONB');
    expect(query.mock.calls.at(-2)?.[0]).toContain('CREATE OR REPLACE VIEW eval_benchmark_run_metrics_v');
    expect(query.mock.calls.at(-1)?.[0]).toContain('CREATE OR REPLACE VIEW eval_benchmark_run_trends_v');
  });

  it('clears the cache when bootstrap fails so the next attempt can retry', async () => {
    const query = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ rows: [] });
    const queryable = { query };

    await expect(ensureEvalBenchmarkLedgerBootstrap(queryable)).rejects.toThrow('boom');
    await expect(ensureEvalBenchmarkLedgerBootstrap(queryable)).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledTimes(1 + EVAL_BENCHMARK_LEDGER_BOOTSTRAP_STATEMENTS.length);
  });
});
