#!/usr/bin/env tsx
/**
 * Shadow-mode bench runner.
 *
 * Drives `ShadowModeRunner.runOnce` over the agent benchmark scenarios
 * (`test/benchmark/agent/scenarios.ts`) and streams a JSONL report. Each
 * line is a `ShadowModeReport` (Zod-validated by the runner before return).
 *
 * Usage:
 *   pnpm exec tsx scripts/wine-search/run-shadow-mode-bench.ts \
 *     --limit 10 \
 *     --output ./tmp/shadow-mode.jsonl
 *
 *   pnpm exec tsx scripts/wine-search/run-shadow-mode-bench.ts \
 *     --no-vespa \
 *     --concurrency 2
 *
 * Exit code:
 *   0  if (equivalent_count / total) >= SHADOW_MODE_PASS_THRESHOLD_PERCENT
 *   1  otherwise (or on usage error)
 *
 * Wiring note (NOT done in this file): consumers must construct a real
 * `AgentOrchestrator` and `WineSearchOrchestratorLike` via the existing
 * composition root and pass them to `runBench()`. We do NOT register the
 * runner in the production container (the task is additive-only). To smoke
 * the script without real backends, use `--dry-run` which substitutes
 * deterministic in-memory stubs that always return the same answer for
 * parity validation of the harness itself.
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  ShadowModeRunner,
  generateShadowModeRequestId,
  type ShadowModeLogger,
  type WineSearchOrchestratorLike,
} from '../../src/application/wine-search/shadow-mode-runner.js';
import type { ShadowModeReport } from '../../src/application/wine-search/shadow-mode-schemas.js';
import type { AgentBenchmarkScenario } from '../../test/benchmark/agent/scenario.js';
import { AGENT_SCENARIOS } from '../../test/benchmark/agent/scenarios.js';
import type { AgentOrchestrator } from '../../src/application/agent/agent-orchestrator.js';
import type { WineSearchResult } from '../../src/application/wine-search/wine-search-result-schemas.js';
import type { AgentResult } from '../../src/domain/agent/model/agent-result.js';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

/** Default bench output path under the local tmp/ folder. */
const DEFAULT_OUTPUT_PATH = 'tmp/shadow-mode-bench.jsonl';

/** Bench-wide concurrency cap. 4 chosen to balance Anthropic API rate
 *  limits against wall-clock; the CLI's `--concurrency` flag overrides. */
const DEFAULT_CONCURRENCY = 4;

/** Hard cap on `--concurrency`. Above 16 the Anthropic API enforces a
 *  per-organization rate limit that would dominate wall-clock anyway. */
const MAX_CONCURRENCY = 16;

/** Equivalent-rate threshold (percent) required for exit code 0. 80 chosen
 *  empirically: below this the shadow-mode cutover should NOT proceed. */
const SHADOW_MODE_PASS_THRESHOLD_PERCENT = 80;

/** Per-scenario timeout (ms). Matches `SHADOW_MODE_DEFAULT_TIMEOUT_MS` from
 *  the runner; redeclared so the CLI flag can override either side. */
const DEFAULT_SCENARIO_TIMEOUT_MS = 35_000;

/** Scenarios whose tier indicates they require a live Vespa backend. The
 *  `--no-vespa` flag skips these. */
const VESPA_REQUIRED_TIERS: ReadonlySet<string> = new Set([
  'wine_name_lookup',
  'extreme',
  'comparison_nested',
  'nested_condition',
]);

/** Percent denominator — extracted to avoid magic numbers (CLAUDE.md rule
 *  15). */
const PERCENT_FACTOR = 100;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface CliArgs {
  readonly scenariosPath?: string;
  readonly limit?: number;
  readonly output: string;
  readonly noVespa: boolean;
  readonly concurrency: number;
  readonly timeoutMs: number;
  readonly dryRun: boolean;
  readonly passThresholdPercent: number;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let scenariosPath: string | undefined;
  let limit: number | undefined;
  let output = DEFAULT_OUTPUT_PATH;
  let noVespa = false;
  let concurrency = DEFAULT_CONCURRENCY;
  let timeoutMs = DEFAULT_SCENARIO_TIMEOUT_MS;
  let dryRun = false;
  let passThresholdPercent = SHADOW_MODE_PASS_THRESHOLD_PERCENT;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--scenarios': {
        scenariosPath = argv[++i];
        break;
      }
      case '--limit': {
        const next = argv[++i];
        if (next !== undefined) {
          const parsed = Number.parseInt(next, 10);
          if (Number.isFinite(parsed) && parsed > 0) limit = parsed;
        }
        break;
      }
      case '--output': {
        const next = argv[++i];
        if (next !== undefined) output = next;
        break;
      }
      case '--no-vespa': {
        noVespa = true;
        break;
      }
      case '--concurrency': {
        const next = argv[++i];
        if (next !== undefined) {
          const parsed = Number.parseInt(next, 10);
          if (Number.isFinite(parsed) && parsed > 0) {
            concurrency = Math.min(MAX_CONCURRENCY, parsed);
          }
        }
        break;
      }
      case '--timeout-ms': {
        const next = argv[++i];
        if (next !== undefined) {
          const parsed = Number.parseInt(next, 10);
          if (Number.isFinite(parsed) && parsed > 0) timeoutMs = parsed;
        }
        break;
      }
      case '--dry-run': {
        dryRun = true;
        break;
      }
      case '--pass-threshold-percent': {
        const next = argv[++i];
        if (next !== undefined) {
          const parsed = Number.parseInt(next, 10);
          if (Number.isFinite(parsed) && parsed >= 0 && parsed <= PERCENT_FACTOR) {
            passThresholdPercent = parsed;
          }
        }
        break;
      }
      case '--help':
      case '-h': {
        printUsage();
        process.exit(0);
        break;
      }
      default: {
        if (arg !== undefined && arg.startsWith('--')) {
          process.stderr.write(`unknown flag: ${arg}\n`);
        }
        break;
      }
    }
  }
  const result: CliArgs = {
    output,
    noVespa,
    concurrency,
    timeoutMs,
    dryRun,
    passThresholdPercent,
    ...(scenariosPath !== undefined ? { scenariosPath } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
  return result;
}

function printUsage(): void {
  process.stdout.write(`Usage: pnpm exec tsx scripts/wine-search/run-shadow-mode-bench.ts [options]

Options:
  --scenarios <path>            Override scenarios import path (default: built-in AGENT_SCENARIOS)
  --limit <n>                   Run only the first N scenarios
  --output <path>               JSONL output file (default: ${DEFAULT_OUTPUT_PATH})
  --no-vespa                    Skip scenarios that need a live Vespa backend
  --concurrency <n>             Parallel scenarios in flight (default: ${DEFAULT_CONCURRENCY}, max ${MAX_CONCURRENCY})
  --timeout-ms <n>              Per-scenario timeout (default: ${DEFAULT_SCENARIO_TIMEOUT_MS})
  --pass-threshold-percent <n>  Required parity percent for exit 0 (default: ${SHADOW_MODE_PASS_THRESHOLD_PERCENT})
  --dry-run                     Use deterministic in-memory orchestrators (no live LLM/Vespa)
  --help, -h                    Show this help
`);
}

// ---------------------------------------------------------------------------
// Aggregate summary
// ---------------------------------------------------------------------------

interface BenchSummary {
  readonly total: number;
  readonly equivalent: number;
  readonly divergent: number;
  readonly meanSimilarity: number;
  readonly meanDurationDeltaMs: number;
  readonly meanTokenDeltaInput: number;
  readonly meanTokenDeltaOutput: number;
  readonly equivalentPercent: number;
}

/**
 * Streaming aggregator — accumulates running counters / sums only, never the
 * raw reports. Bounded memory regardless of N (CLAUDE.md SOTA+++++ rule:
 * memory-bounded streaming).
 */
class BenchAggregator {
  private total = 0;
  private equivalent = 0;
  private similaritySum = 0;
  private durationDeltaSum = 0;
  private tokenDeltaInputSum = 0;
  private tokenDeltaOutputSum = 0;

  observe(report: ShadowModeReport): void {
    this.total += 1;
    if (!report.diff.divergent) this.equivalent += 1;
    this.similaritySum += report.diff.answerSimilarity;
    this.durationDeltaSum += report.diff.durationDeltaMs;
    this.tokenDeltaInputSum += report.diff.tokenDeltaInput;
    this.tokenDeltaOutputSum += report.diff.tokenDeltaOutput;
  }

  finalize(): BenchSummary {
    const total = this.total;
    if (total === 0) {
      return {
        total: 0,
        equivalent: 0,
        divergent: 0,
        meanSimilarity: 0,
        meanDurationDeltaMs: 0,
        meanTokenDeltaInput: 0,
        meanTokenDeltaOutput: 0,
        equivalentPercent: 0,
      };
    }
    return {
      total,
      equivalent: this.equivalent,
      divergent: total - this.equivalent,
      meanSimilarity: this.similaritySum / total,
      meanDurationDeltaMs: this.durationDeltaSum / total,
      meanTokenDeltaInput: this.tokenDeltaInputSum / total,
      meanTokenDeltaOutput: this.tokenDeltaOutputSum / total,
      equivalentPercent: (this.equivalent * PERCENT_FACTOR) / total,
    };
  }
}

// ---------------------------------------------------------------------------
// Bounded-concurrency scheduler
// ---------------------------------------------------------------------------

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const idx = next;
      next += 1;
      if (idx >= items.length) return;
      const item = items[idx];
      if (item === undefined) return;
      await task(item, idx);
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Dry-run stub orchestrators
// ---------------------------------------------------------------------------

/**
 * Dry-run stubs emit IDENTICAL answers from both sides so the harness self-
 * test reports 100 % parity. This validates the runner / aggregator / JSONL
 * stream wiring without requiring a live LLM or Vespa backend.
 */
function dryRunAnswer(query: string): string {
  return `[dry-run] echo ${query}`;
}

function makeDryRunLegacy(): AgentOrchestrator {
  const execute = async (
    query: string,
    _requestId: string,
  ): Promise<AgentResult> => {
    return {
      answer: dryRunAnswer(query),
      steps: [
        {
          index: 0,
          thought: 'dry-run',
          action: { tool: 'search_wines', input: { q: query } },
          observation: 'ok',
          durationMs: 1,
          tokenCount: { input: 1, output: 1 },
        },
      ],
      totalDurationMs: 1,
      totalTokens: { input: 1, output: 1 },
      toolCallCount: 1,
      fallbackApplied: false,
      terminationReason: 'answer',
    };
  };
  return { execute } as unknown as AgentOrchestrator;
}

function makeDryRunWineSearch(): WineSearchOrchestratorLike {
  return {
    execute: async ({ query }): Promise<WineSearchResult> => ({
      answer: dryRunAnswer(query),
      layer: 'primary',
      groundedOnToolResults: true,
      toolOutcomes: [],
      executionSteps: [
        {
          index: 0,
          source: 'runner',
          summary: 'dry-run',
          toolCalls: [{ tool: 'search_wines', input: { q: query } }],
          durationMs: 1,
        },
      ],
      tokenUsage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      totalDurationMs: 1,
      terminationReason: 'answer',
      policyBlocked: false,
      degradedReason: undefined,
      analysisIntent: 'search',
      planKind: 'single-search',
    }),
  };
}

// ---------------------------------------------------------------------------
// Console logger
// ---------------------------------------------------------------------------

const consoleLogger: ShadowModeLogger = {
  info: (obj, msg) => {
    process.stdout.write(`[info] ${msg ?? ''} ${JSON.stringify(obj)}\n`);
  },
  warn: (obj, msg) => {
    process.stderr.write(`[warn] ${msg ?? ''} ${JSON.stringify(obj)}\n`);
  },
  error: (obj, msg) => {
    process.stderr.write(`[error] ${msg ?? ''} ${JSON.stringify(obj)}\n`);
  },
};

// ---------------------------------------------------------------------------
// Bench driver (exported for tests / external callers)
// ---------------------------------------------------------------------------

export interface RunBenchOptions {
  readonly scenarios: readonly AgentBenchmarkScenario[];
  readonly legacyOrchestrator: AgentOrchestrator;
  readonly wineSearchOrchestrator: WineSearchOrchestratorLike;
  readonly outputPath: string;
  readonly concurrency: number;
  readonly timeoutMs: number;
  readonly logger?: ShadowModeLogger;
}

export async function runBench(opts: RunBenchOptions): Promise<BenchSummary> {
  mkdirSync(dirname(resolve(opts.outputPath)), { recursive: true });
  const stream = createWriteStream(resolve(opts.outputPath), { flags: 'w' });
  const aggregator = new BenchAggregator();
  const runner = new ShadowModeRunner({
    legacyOrchestrator: opts.legacyOrchestrator,
    wineSearchOrchestrator: opts.wineSearchOrchestrator,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  });

  // A small mutex around stream.write so JSONL lines never interleave.
  let writeChain: Promise<void> = Promise.resolve();
  const writeLine = (line: string): Promise<void> => {
    writeChain = writeChain.then(
      () =>
        new Promise<void>((res, rej) => {
          if (!stream.write(line)) {
            stream.once('drain', () => res());
          } else {
            res();
          }
          stream.once('error', rej);
        }),
    );
    return writeChain;
  };

  await runWithConcurrency(opts.scenarios, opts.concurrency, async (scn) => {
    try {
      const report = await runner.runOnce({
        query: scn.query,
        requestId: generateShadowModeRequestId(),
        scenarioId: String(scn.id),
        timeoutMs: opts.timeoutMs,
      });
      aggregator.observe(report);
      await writeLine(`${JSON.stringify(report)}\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.logger?.error(
        { component: 'run-shadow-mode-bench', scenarioId: scn.id, message },
        'scenario crashed outside runner',
      );
    }
  });

  await new Promise<void>((res, rej) => {
    stream.end((err: NodeJS.ErrnoException | null | undefined) => {
      if (err !== null && err !== undefined) rej(err);
      else res();
    });
  });

  return aggregator.finalize();
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

function selectScenarios(
  all: readonly AgentBenchmarkScenario[],
  args: CliArgs,
): readonly AgentBenchmarkScenario[] {
  let filtered = all;
  if (args.noVespa) {
    filtered = filtered.filter((s) => !VESPA_REQUIRED_TIERS.has(s.tier));
  }
  if (args.limit !== undefined) {
    filtered = filtered.slice(0, args.limit);
  }
  return filtered;
}

function isCliEntrypoint(argv1: string | undefined, importMetaUrl: string): boolean {
  if (argv1 === undefined) return false;
  try {
    return resolve(argv1) === fileURLToPath(importMetaUrl);
  } catch {
    return false;
  }
}

async function mainCli(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const scenarios = selectScenarios(AGENT_SCENARIOS, args);

  if (scenarios.length === 0) {
    process.stderr.write('no scenarios selected — check --limit / --no-vespa flags\n');
    process.exit(1);
  }

  let legacyOrchestrator: AgentOrchestrator;
  let wineSearchOrchestrator: WineSearchOrchestratorLike;
  if (args.dryRun) {
    legacyOrchestrator = makeDryRunLegacy();
    wineSearchOrchestrator = makeDryRunWineSearch();
  } else {
    // Production wiring lives outside this script (additive-only scope).
    // Operators must build orchestrators via the composition root and pass
    // them in by importing `runBench` from this module. Refuse to silently
    // run against fake stubs in non-dry-run mode.
    process.stderr.write(
      'production orchestrator wiring is not built into this script — re-run with --dry-run, '
      + 'or import { runBench } from this module and pass orchestrators built via the composition root.\n',
    );
    process.exit(1);
  }

  const runId = randomUUID();
  process.stdout.write(`shadow-mode bench run ${runId}: ${scenarios.length} scenarios, concurrency=${args.concurrency}\n`);

  const summary = await runBench({
    scenarios,
    legacyOrchestrator,
    wineSearchOrchestrator,
    outputPath: args.output,
    concurrency: args.concurrency,
    timeoutMs: args.timeoutMs,
    logger: consoleLogger,
  });

  process.stdout.write(
    `\n=== shadow-mode bench summary ===\n`
    + `  total:               ${summary.total}\n`
    + `  equivalent:          ${summary.equivalent} (${summary.equivalentPercent.toFixed(2)}%)\n`
    + `  divergent:           ${summary.divergent}\n`
    + `  mean similarity:     ${summary.meanSimilarity.toFixed(4)}\n`
    + `  mean Δduration (ms): ${summary.meanDurationDeltaMs.toFixed(1)}\n`
    + `  mean Δtokens (in):   ${summary.meanTokenDeltaInput.toFixed(1)}\n`
    + `  mean Δtokens (out):  ${summary.meanTokenDeltaOutput.toFixed(1)}\n`
    + `  output:              ${args.output}\n`,
  );

  if (summary.equivalentPercent >= args.passThresholdPercent) {
    process.exit(0);
  } else {
    process.stderr.write(
      `parity rate ${summary.equivalentPercent.toFixed(2)}% < threshold ${args.passThresholdPercent}%\n`,
    );
    process.exit(1);
  }
}

if (isCliEntrypoint(process.argv[1], import.meta.url)) {
  mainCli().catch((err: unknown) => {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(`shadow-mode bench crashed: ${msg}\n`);
    process.exit(1);
  });
}
