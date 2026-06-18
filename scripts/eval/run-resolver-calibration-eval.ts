/**
 * Minimal eval-only run that populates `eval_results` (including the
 * newly-plumbed `top1_raw_score`) so the resolver calibration trainer has
 * (top1RawScore, isCorrectResolve) pairs to fit.
 *
 * Unlike `run-eval-and-train-ltr.ts`, this script does NOT train an LTR model,
 * run the noisy-entity benchmark, or stage/publish any snapshot — its only
 * prod write is `eval_results` rows via `PgEvalResultStore`. It reuses the
 * proven live bootstrap (`createContainer(config)`, same as the shadow runner).
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/eval/run-resolver-calibration-eval.ts \
 *     [--limit N] [--label-tier gold|silver|bronze] [--query-class <class>]
 *
 * Requires the live stack (PG with SSL via PG_SSL, Vespa, OpenAI embeddings).
 */
import 'dotenv/config';
import process from 'node:process';

import { loadConfig } from '../../src/config/env.js';
import { createContainer } from '../../src/config/container.js';
import { getPgPool } from '../../src/infrastructure/db/pg-pool.js';
import { PgGoldSetStore } from '../../src/infrastructure/adapter/pg-gold-set-store.js';
import { PgEvalResultStore } from '../../src/infrastructure/adapter/pg-eval-result-store.js';
import { SearchPipelineEvaluator } from '../../src/infrastructure/adapter/search-pipeline-evaluator.js';
import { EvalRunner } from '../../src/domain/evaluation/service/eval-runner.js';
import type { GoldSetFilter } from '../../src/domain/evaluation/port/gold-set-store.port.js';
import type { EvalCase } from '../../src/domain/evaluation/model/eval-case.js';
import { isQueryClass } from '../../src/domain/shared/types/query-class.js';

/** Default case cap for a quick validation run. */
const DEFAULT_LIMIT = 60;

interface CliArgs {
  readonly limit: number;
  readonly filter: GoldSetFilter;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let limit = DEFAULT_LIMIT;
  const filter: { -readonly [K in keyof GoldSetFilter]: GoldSetFilter[K] } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--limit') {
      const parsed = Number.parseInt(argv[i + 1] ?? '', 10);
      if (Number.isFinite(parsed) && parsed > 0) limit = parsed;
      i += 1;
    } else if (arg === '--label-tier') {
      const v = argv[i + 1];
      if (v === 'gold' || v === 'silver' || v === 'bronze') filter.labelTier = v;
      i += 1;
    } else if (arg === '--query-class') {
      const v = argv[i + 1];
      if (v !== undefined && isQueryClass(v)) filter.queryClass = v;
      i += 1;
    }
  }
  return { limit, filter };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  // Pass the live RDS pool into the container so the PG-backed alias substrate,
  // blocker, calibration store, and eval infrastructure are all available.
  // createContainer(config) with no pool silently degrades (PG unavailable) —
  // that is what understated the earlier shadow run (blocker=0 / untrusted).
  const pool = getPgPool();
  const container = await createContainer(config, pool);

  const goldSetStore = new PgGoldSetStore(pool);
  const allCases = await goldSetStore.getCases(args.filter);
  const cases: readonly EvalCase[] = allCases.slice(0, args.limit);
  process.stderr.write(
    `[resolver-calibration-eval] running ${String(cases.length)} / ${String(allCases.length)} cases ` +
      `(filter=${JSON.stringify(args.filter)})\n`,
  );

  const evalResultStore = new PgEvalResultStore(pool);
  const searchPipeline = new SearchPipelineEvaluator(container.searchUseCase);
  const selectedCaseStore = {
    async getCases() {
      return cases;
    },
    async addCase(): Promise<never> {
      throw new Error('selectedCaseStore is read-only');
    },
    async getIAAScore(sliceTag?: string) {
      return goldSetStore.getIAAScore(sliceTag);
    },
  };

  const runner = new EvalRunner(selectedCaseStore, evalResultStore, searchPipeline);
  const report = await runner.run();

  process.stderr.write(
    `[resolver-calibration-eval] done: ${String(report.caseCount)} cases; ` +
      `correctResolveRate=${report.overallMetrics.correctResolveRate.toFixed(3)} ` +
      `wrongResolveRate=${report.overallMetrics.wrongResolveRate.toFixed(3)}\n`,
  );

  await pool.end();
}

main().catch((err: unknown) => {
  process.stderr.write(`[resolver-calibration-eval] failed: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
