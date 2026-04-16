/**
 * Thin error-safe helper for persisting an eval benchmark run to the ledger.
 *
 * Designed for use by multiple eval runners — wraps PgEvalBenchmarkRunStore.saveRun()
 * with logging and swallowed errors so that eval pipelines never fail because of
 * the ledger write.
 */

import type { Pool } from 'pg';
import type { EvalBenchmarkRunInput } from '../../src/domain/evaluation/model/eval-benchmark-run.js';
import { PgEvalBenchmarkRunStore } from '../../src/infrastructure/adapter/pg-eval-benchmark-run-store.js';

/**
 * Persist a benchmark run to eval_benchmark_runs.
 *
 * @returns The generated run_id on success, or null if the write failed.
 *          Never throws — eval must not fail because of ledger persistence.
 */
export async function writeBenchmarkRun(
  pool: Pool,
  input: EvalBenchmarkRunInput,
): Promise<string | null> {
  try {
    const store = new PgEvalBenchmarkRunStore(pool);
    const runId = await store.saveRun(input);
    console.log(`  [benchmark-ledger] Saved ${input.benchmarkKind} run: ${runId}`);
    return runId;
  } catch (err: unknown) {
    console.error(
      `  [benchmark-ledger] Failed to save ${input.benchmarkKind} run:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
