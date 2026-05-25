#!/usr/bin/env node
/**
 * Fusion-weight sweep — CLI entrypoint (framework scaffold).
 *
 * This script is the **harness** for calibrating per-class RRF fusion
 * weights. It defines the contract that a future eval-lane wiring must
 * satisfy, but it **does not** yet drive a real evaluation:
 *
 *   - The grid + record schema (this directory) are landed.
 *   - Wiring to `test/benchmark/wine-search/runner.ts` and an actual
 *     eval corpus (gold-set-v2 / silver-korean) is intentionally out of
 *     scope — see TODOs below.
 *
 * Running this CLI today validates flags, prints the grid plan, and
 * exits 0 without contacting Vespa. That is by design: framework PRs
 * land before sweep-runs are reproducible, and the regression tests in
 * this directory exercise the schema + grid math directly.
 *
 * Usage:
 *   tsx scripts/eval/fusion-weight-sweep/index.ts \
 *     --class browse \
 *     --metric ndcgAt10 \
 *     --output data/calibration/sweep-browse.ndjson
 *
 * Flags:
 *   --class <SweepQueryClass>   queryClass to calibrate (required for a real run)
 *   --metric <metric>           primary selection metric (default: ndcgAt10)
 *   --output <path>             NDJSON sink for CalibrationRecord rows
 *   --dry-run                   (default in framework mode) — print plan, exit 0
 *   --help
 */

import process from 'node:process';
import {
  SWEEP_WEIGHT_GRID,
  enumerateGrid,
  gridPointCount,
} from './weight-grid.js';
import {
  SWEEP_QUERY_CLASSES,
  type SweepQueryClass,
} from './calibration-record.js';

const PRIMARY_METRIC_DEFAULT = 'ndcgAt10' as const;
const SUPPORTED_METRICS = ['ndcgAt5', 'ndcgAt10', 'recallAt20', 'mrr'] as const;
type SupportedMetric = (typeof SUPPORTED_METRICS)[number];

interface CliArgs {
  readonly queryClass?: SweepQueryClass;
  readonly metric: SupportedMetric;
  readonly output?: string;
  readonly dryRun: boolean;
  readonly help: boolean;
}

function isSweepQueryClass(s: string): s is SweepQueryClass {
  return (SWEEP_QUERY_CLASSES as readonly string[]).includes(s);
}

function isSupportedMetric(s: string): s is SupportedMetric {
  return (SUPPORTED_METRICS as readonly string[]).includes(s);
}

export function parseArgs(argv: readonly string[]): CliArgs {
  let queryClass: SweepQueryClass | undefined;
  let metric: SupportedMetric = PRIMARY_METRIC_DEFAULT;
  let output: string | undefined;
  let dryRun = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--class': {
        const v = argv[++i];
        if (v != null && isSweepQueryClass(v)) {
          queryClass = v;
        } else {
          throw new Error(
            `--class must be one of ${SWEEP_QUERY_CLASSES.join('|')}; got ${String(v)}`,
          );
        }
        break;
      }
      case '--metric': {
        const v = argv[++i];
        if (v != null && isSupportedMetric(v)) {
          metric = v;
        } else {
          throw new Error(
            `--metric must be one of ${SUPPORTED_METRICS.join('|')}; got ${String(v)}`,
          );
        }
        break;
      }
      case '--output': {
        const v = argv[++i];
        if (v == null || v.length === 0) {
          throw new Error('--output requires a path');
        }
        output = v;
        break;
      }
      case '--dry-run':
        dryRun = true;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        // Skip unknown flags rather than fail — keeps the door open for
        // forward-compatible flags added by the eval-lane wiring PR.
        break;
    }
  }

  return {
    ...(queryClass !== undefined ? { queryClass } : {}),
    metric,
    ...(output !== undefined ? { output } : {}),
    dryRun,
    help,
  };
}

const HELP_TEXT = `\
fusion-weight-sweep — framework scaffold (no live eval yet)

Flags:
  --class <${SWEEP_QUERY_CLASSES.join('|')}>
  --metric <${SUPPORTED_METRICS.join('|')}>   (default: ${PRIMARY_METRIC_DEFAULT})
  --output <path>                              NDJSON sink for CalibrationRecord rows
  --dry-run                                    Print plan and exit (current default)
  --help

This script currently prints the sweep plan and exits 0. The eval-lane
wiring (calling test/benchmark/wine-search/runner.ts under each grid
point) is a separate follow-up PR.
`;

interface SweepPlan {
  readonly queryClass: SweepQueryClass | undefined;
  readonly metric: SupportedMetric;
  readonly output: string | undefined;
  readonly gridPoints: number;
  readonly axes: Record<string, readonly number[]>;
}

export function buildSweepPlan(args: CliArgs): SweepPlan {
  return {
    queryClass: args.queryClass,
    metric: args.metric,
    output: args.output,
    gridPoints: gridPointCount(SWEEP_WEIGHT_GRID),
    axes: {
      sparseWeight: SWEEP_WEIGHT_GRID.sparseWeight,
      denseWeight: SWEEP_WEIGHT_GRID.denseWeight,
      anchorWeight: SWEEP_WEIGHT_GRID.anchorWeight,
      learnedSparseWeight: SWEEP_WEIGHT_GRID.learnedSparseWeight,
    },
  };
}

// TODO(eval): wire this scaffold into a real evaluation lane.
//   1. Import `BenchmarkRunner` from `test/benchmark/wine-search/runner.ts`
//      and a fixed eval corpus (gold-set-v2 or silver-korean-v1).
//   2. For each `WeightPoint` from `enumerateGrid(SWEEP_WEIGHT_GRID)`,
//      override the per-class FusionConfig via a config injection seam
//      (does NOT exist yet — needs `PerClassFusionOverride` port).
//   3. Execute the corpus, compute ndcgAt5 / ndcgAt10 / recallAt20 / mrr,
//      assemble a `CalibrationRecord`, append to `--output` NDJSON.
//   4. After the sweep completes, a separate `select-best.ts` tool
//      picks the argmax-by-metric per queryClass and emits a patch file
//      for `per-class-fusion-config.ts` (no in-place mutation here).
async function runSweep(_args: CliArgs): Promise<never> {
  throw new Error(
    'fusion-weight-sweep: live eval is not yet wired. Run with --dry-run. ' +
      'See TODO(eval) in scripts/eval/fusion-weight-sweep/index.ts.',
  );
}

async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const plan = buildSweepPlan(args);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);

  // Framework mode: --dry-run (or default with no --output) just prints
  // the plan and exits. Any future "live" run path goes through
  // `runSweep`.
  if (args.dryRun || args.output === undefined) {
    process.stdout.write(
      '[fusion-weight-sweep] framework mode — no eval executed.\n',
    );
    return;
  }

  await runSweep(args);
}

// Compute Cartesian product up-front so the imported helper is exercised
// at module load and dead-code elimination cannot drop it in a tree-shake.
// (`enumerateGrid` is also re-exported below for downstream wiring.)
void enumerateGrid;

export { enumerateGrid, SWEEP_WEIGHT_GRID } from './weight-grid.js';
export {
  CalibrationRecordSchema,
  type CalibrationRecord,
  SWEEP_QUERY_CLASSES,
} from './calibration-record.js';

// Top-level invocation guard — only run when executed directly via tsx.
const invokedDirectly =
  process.argv[1] !== undefined &&
  /scripts\/eval\/fusion-weight-sweep\/index\.[jt]s$/u.test(process.argv[1]);

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(
      `[fusion-weight-sweep] ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
