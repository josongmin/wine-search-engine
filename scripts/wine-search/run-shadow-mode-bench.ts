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

import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
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
import {
  ShadowModeScorer,
  type ShadowModeScoringReport,
  type ShadowModeScoringVerdict,
  type BenchScorerFn,
} from '../../src/application/wine-search/shadow-mode-scoring.js';
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

/**
 * Maximum fraction of scenarios allowed to surface a `'regressed'` verdict
 * while still exiting 0. 5 % chosen to match the bench cutover gate: at
 * 18 k scenarios that's ~900 regressions, well above the noise floor we
 * observed in repeated legacy-vs-legacy runs. `--regressed-rate-ceiling`
 * overrides.
 */
const DEFAULT_REGRESSED_RATE_CEILING_PERCENT = 5;

/** Top-N worst regressions surfaced in the stdout summary. */
const TOP_REGRESSION_REPORT_COUNT = 5;

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
  readonly score: boolean;
  readonly summaryOutput?: string;
  readonly regressedRateCeilingPercent: number;
  /**
   * When true, serialize each outcome's `observations` array into the JSONL
   * stream. Default false — observations are large strings (Korean wine
   * descriptions can be 100+ chars each, with up to 256 per scenario), and
   * embedding them blows up JSONL size to ~50KB+ per scenario. Observations
   * are ALWAYS available in-memory for scoring regardless of this flag; this
   * only controls JSONL persistence (CLAUDE.md SOTA+++++: memory-bounded
   * streaming, opt-in to debug-grade artifacts).
   */
  readonly observations: boolean;
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
  let score = false;
  let summaryOutput: string | undefined;
  let regressedRateCeilingPercent = DEFAULT_REGRESSED_RATE_CEILING_PERCENT;
  let observations = false;

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
      case '--score': {
        score = true;
        break;
      }
      case '--summary-output': {
        const next = argv[++i];
        if (next !== undefined) summaryOutput = next;
        break;
      }
      case '--observations': {
        observations = true;
        break;
      }
      case '--regressed-rate-ceiling': {
        const next = argv[++i];
        if (next !== undefined) {
          const parsed = Number.parseFloat(next);
          if (Number.isFinite(parsed) && parsed >= 0 && parsed <= PERCENT_FACTOR) {
            regressedRateCeilingPercent = parsed;
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
    score,
    regressedRateCeilingPercent,
    observations,
    ...(scenariosPath !== undefined ? { scenariosPath } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(summaryOutput !== undefined ? { summaryOutput } : {}),
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
  --score                       Invoke the REAL bench scorer (test/benchmark/agent/scorer.ts) on
                                each scenario via a dynamic import and emit a per-scenario
                                ShadowModeScoringReport (legacy/wineSearch ScenarioResult plus
                                per-dimension delta + verdict) in the JSONL stream.

                                Scorer dimensions surfaced (each in [0, 1]; nulls dropped):
                                  - executionEfficiency  (tool accuracy * 0.6 + step efficiency * 0.4)
                                  - answerQuality        (substring contract + structured checks)
                                  - terminationCorrectness (binary: matches expectation)
                                  - costEfficiency       (latency + token budget overshoot)
                                  - faithfulness         (RAGAS: grounded claims; null when no tools)
                                  - contextRelevance     (rule-based retrieval relevance; null OK)
                                  - contextRecall        (goldenKeywords coverage; null OK)
                                  - judge                (LLM-as-judge rubric; null when disabled)
                                Verdict per scenario is one of:
                                  - parity     |Δoverall| < SHADOW_SCORE_PARITY_EPSILON
                                  - improved   Δoverall > 0 and no dim regressed past threshold
                                  - regressed  ≥ 1 dim dropped > SHADOW_SCORE_REGRESSION_THRESHOLD
                                  - mixed      Δoverall < 0 but no dim crossed the threshold
                                The --regressed-rate-ceiling gate fails the run when the
                                'regressed' verdict share exceeds the ceiling percent.

  --summary-output <path>       Write the aggregate scoring summary as JSON to this path (--score only)
  --regressed-rate-ceiling <n>  Max %% of scenarios that may end up 'regressed' before exit 1 (default: ${DEFAULT_REGRESSED_RATE_CEILING_PERCENT})
  --observations                Persist outcome.observations into the JSONL stream (default: stripped).
                                Observations are ALWAYS used in-memory for scoring (faithfulness /
                                contextRecall) regardless of this flag; --observations only controls
                                whether they are also serialized to disk for offline inspection.
                                Caveat: enabling this can grow per-scenario JSONL records by ~50KB+
                                for verbose mini-loop traces with Korean text.
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
  /** Present only when scoring was enabled. */
  readonly scoring?: ScoringSummary;
}

interface WorstRegression {
  readonly scenarioId: string;
  readonly dimension: string;
  readonly delta: number;
}

interface ScoringSummary {
  readonly total: number;
  readonly verdictCounts: Readonly<Record<ShadowModeScoringVerdict, number>>;
  readonly meanDeltaPerDimension: Readonly<Record<string, number>>;
  readonly meanLegacyOverall: number;
  readonly meanWineSearchOverall: number;
  readonly meanTotalDelta: number;
  readonly worstRegressions: readonly WorstRegression[];
  readonly regressedRatePercent: number;
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

/**
 * Streaming aggregator for the scoring delta path. Tracks per-verdict counts,
 * per-dimension running sums, and a bounded top-N worst-regression heap-like
 * sorted list. Memory: O(D + K) where D = dimensions, K = TOP_REGRESSION_REPORT_COUNT.
 */
class ScoringAggregator {
  private total = 0;
  private legacyOverallSum = 0;
  private wineSearchOverallSum = 0;
  private totalDeltaSum = 0;
  private readonly verdictCounts: Record<ShadowModeScoringVerdict, number> = {
    parity: 0,
    improved: 0,
    regressed: 0,
    mixed: 0,
  };
  private readonly dimSums = new Map<string, { sum: number; count: number }>();
  // Sorted ascending by `delta` (most negative first) — bounded size K.
  private readonly worstRegressions: WorstRegression[] = [];

  observe(scenarioId: string, report: ShadowModeScoringReport): void {
    this.total += 1;
    this.verdictCounts[report.verdict] += 1;
    if (Number.isFinite(report.legacyScore.scores.overall)) {
      this.legacyOverallSum += report.legacyScore.scores.overall;
    }
    if (Number.isFinite(report.wineSearchScore.scores.overall)) {
      this.wineSearchOverallSum += report.wineSearchScore.scores.overall;
    }
    this.totalDeltaSum += report.scoreDelta.totalDelta;
    for (const [dim, delta] of Object.entries(report.scoreDelta.perDimension)) {
      const slot = this.dimSums.get(dim);
      if (slot === undefined) {
        this.dimSums.set(dim, { sum: delta, count: 1 });
      } else {
        slot.sum += delta;
        slot.count += 1;
      }
      // Track worst-by-dimension into the top-N table.
      if (delta < 0) this.maybeInsertRegression({ scenarioId, dimension: dim, delta });
    }
  }

  private maybeInsertRegression(entry: WorstRegression): void {
    // Insertion sort into the bounded list. Lowest delta first.
    if (this.worstRegressions.length < TOP_REGRESSION_REPORT_COUNT) {
      this.worstRegressions.push(entry);
      this.worstRegressions.sort((a, b) => a.delta - b.delta);
      return;
    }
    const tail = this.worstRegressions[this.worstRegressions.length - 1];
    if (tail !== undefined && entry.delta < tail.delta) {
      this.worstRegressions[this.worstRegressions.length - 1] = entry;
      this.worstRegressions.sort((a, b) => a.delta - b.delta);
    }
  }

  finalize(): ScoringSummary {
    const total = this.total;
    const meanDeltaPerDimension: Record<string, number> = {};
    for (const [dim, slot] of this.dimSums.entries()) {
      meanDeltaPerDimension[dim] = slot.count > 0 ? slot.sum / slot.count : 0;
    }
    const regressedRatePercent = total === 0
      ? 0
      : (this.verdictCounts.regressed * PERCENT_FACTOR) / total;
    return {
      total,
      verdictCounts: { ...this.verdictCounts },
      meanDeltaPerDimension,
      meanLegacyOverall: total === 0 ? 0 : this.legacyOverallSum / total,
      meanWineSearchOverall: total === 0 ? 0 : this.wineSearchOverallSum / total,
      meanTotalDelta: total === 0 ? 0 : this.totalDeltaSum / total,
      worstRegressions: [...this.worstRegressions],
      regressedRatePercent,
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
          // Field names match the WineSearchResult contract
          // (`name`/`arguments`, mirroring the Anthropic tool_use block).
          toolCalls: [{ name: 'search_wines', arguments: { q: query } }],
          observations: ['ok'],
          durationMs: 1,
        },
      ],
      toolCallCount: 1,
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
      intent: 'search',
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
  /** When provided, the bench harness ALSO runs the bench scorer on both
   *  sides and writes a `ShadowModeScoringReport` per scenario into the
   *  JSONL output (each line gets `{ ...shadowReport, scoring: ... }`). */
  readonly scorer?: BenchScorerFn;
  /**
   * Persist `outcome.observations` into the JSONL stream. Default false —
   * observations are large strings (Korean wine descriptions can total ~50KB
   * per scenario). They are ALWAYS available to the scorer in-memory; this
   * flag only controls disk serialization for offline inspection.
   */
  readonly includeObservations?: boolean;
}

export async function runBench(opts: RunBenchOptions): Promise<BenchSummary> {
  mkdirSync(dirname(resolve(opts.outputPath)), { recursive: true });
  const stream = createWriteStream(resolve(opts.outputPath), { flags: 'w' });
  const aggregator = new BenchAggregator();
  const scoringAggregator = opts.scorer !== undefined ? new ScoringAggregator() : undefined;
  const runner = new ShadowModeRunner({
    legacyOrchestrator: opts.legacyOrchestrator,
    wineSearchOrchestrator: opts.wineSearchOrchestrator,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  });
  const scorer = opts.scorer === undefined
    ? undefined
    : new ShadowModeScorer({ runner, scorer: opts.scorer });

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

  const includeObservations = opts.includeObservations === true;

  await runWithConcurrency(opts.scenarios, opts.concurrency, async (scn) => {
    try {
      if (scorer !== undefined && scoringAggregator !== undefined) {
        const scoringReport = await scorer.scoreOnce({
          scenario: scn,
          requestId: generateShadowModeRequestId(),
          timeoutMs: opts.timeoutMs,
        });
        aggregator.observe(scoringReport.shadowDiff);
        scoringAggregator.observe(String(scn.id), scoringReport);
        // Emit a compact per-scenario JSONL record: scenario id + nested
        // shadowDiff + per-dimension delta + verdict. Avoids inlining the
        // full `ScenarioResult` per side (judge reasoning, diagnostic
        // strings) to keep the JSONL stream lean; consumers needing those
        // can re-run with the in-process API.
        const line = JSON.stringify({
          scenarioId: scn.id,
          shadowDiff: includeObservations
            ? scoringReport.shadowDiff
            : stripObservationsFromReport(scoringReport.shadowDiff),
          legacyOverall: scoringReport.legacyScore.scores.overall,
          wineSearchOverall: scoringReport.wineSearchScore.scores.overall,
          // Surface faithfulness / contextRecall explicitly so consumers can
          // verify the cutover gate without re-parsing the full scenario
          // result. Null means "dropped from geo-mean" (scorer's documented
          // graceful path); a finite number means "measured".
          legacyFaithfulness: scoringReport.legacyScore.scores.faithfulness,
          wineSearchFaithfulness: scoringReport.wineSearchScore.scores.faithfulness,
          legacyContextRecall: scoringReport.legacyScore.scores.contextRecall,
          wineSearchContextRecall: scoringReport.wineSearchScore.scores.contextRecall,
          scoreDelta: scoringReport.scoreDelta,
          verdict: scoringReport.verdict,
        });
        await writeLine(`${line}\n`);
        return;
      }
      const report = await runner.runOnce({
        query: scn.query,
        requestId: generateShadowModeRequestId(),
        scenarioId: String(scn.id),
        timeoutMs: opts.timeoutMs,
      });
      aggregator.observe(report);
      const payload = includeObservations ? report : stripObservationsFromReport(report);
      await writeLine(`${JSON.stringify(payload)}\n`);
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

  const summary = aggregator.finalize();
  if (scoringAggregator !== undefined) {
    return { ...summary, scoring: scoringAggregator.finalize() };
  }
  return summary;
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

/**
 * Per-scenario error string ceiling — long stack traces in CLI output would
 * obscure aggregate signal. Aligned with pino's default error message clip
 * length in the project's serializers.err config.
 */
const SCORER_ERROR_MESSAGE_MAX_CHARS = 512;

/**
 * Dynamic import so the 3k-line bench scorer (and its evaluator dependencies)
 * only load when `--score` is set. The scorer module lives under `test/`,
 * which the main `tsconfig.json` excludes from rootDir — dynamic import is
 * the standard escape hatch (CLAUDE.md SSoT: keep the scorer where it owns
 * its scenario types).
 *
 * Runtime guards (CLAUDE.md rule 11):
 *   - validates `scoreScenario` is a callable export (not a re-export rename
 *     or accidental type-only erasure) before binding;
 *   - wraps each call in a try/catch so a single-scenario scorer crash
 *     surfaces as a context-rich error and does NOT collapse the bench run;
 *   - emits a per-scenario INFO log so operators can audit the scorer
 *     invocation visibility (CLAUDE.md rule 33).
 */
export async function loadBenchScorer(
  logger: ShadowModeLogger = consoleLogger,
): Promise<BenchScorerFn> {
  // `typeof import(...)` gives us the *real* module signature at type-check
  // time without crossing the rootDir boundary at compile time. The dynamic
  // import resolves at runtime where the boundary no longer applies.
  type ScorerModule = typeof import('../../test/benchmark/agent/scorer.js');
  const mod: ScorerModule = await import('../../test/benchmark/agent/scorer.js');
  if (typeof mod.scoreScenario !== 'function') {
    throw new Error(
      'bench scorer module does not export scoreScenario (got '
      + `${typeof mod.scoreScenario}). Check test/benchmark/agent/scorer.ts exports.`,
    );
  }
  const scoreScenario = mod.scoreScenario;
  return (scenario, execution, error): ReturnType<BenchScorerFn> => {
    try {
      const result = scoreScenario(scenario, execution, undefined, undefined, error);
      logger.info(
        {
          component: 'run-shadow-mode-bench.loadBenchScorer',
          scenarioId: scenario.id,
          tier: scenario.tier,
          overall: result.scores.overall,
          executionEfficiency: result.scores.executionEfficiency,
          answerQuality: result.scores.answerQuality,
          terminationCorrectness: result.scores.terminationCorrectness,
          costEfficiency: result.scores.costEfficiency,
          // judge / faithfulness / context* may be null — surface them
          // explicitly so dashboards can distinguish "0 score" from "dropped".
          judge: result.scores.judge,
          faithfulness: result.scores.faithfulness,
          contextRelevance: result.scores.contextRelevance,
          contextRecall: result.scores.contextRecall,
          ...(result.error !== undefined ? { scoredWithError: result.error } : {}),
        },
        'bench scorer scored scenario',
      );
      return result;
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const clipped = raw.length > SCORER_ERROR_MESSAGE_MAX_CHARS
        ? `${raw.slice(0, SCORER_ERROR_MESSAGE_MAX_CHARS)}…`
        : raw;
      // Re-throw with scenario context. The bench driver catches at the
      // per-scenario boundary so other scenarios continue scoring.
      throw new Error(
        `scoreScenario crashed for scenario id=${scenario.id} tier=${scenario.tier}: ${clipped}`,
        { cause: err },
      );
    }
  };
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
  process.stdout.write(
    `shadow-mode bench run ${runId}: ${scenarios.length} scenarios, concurrency=${args.concurrency}`
    + `${args.score ? ', scoring=on' : ''}\n`,
  );

  const scorer = args.score ? await loadBenchScorer(consoleLogger) : undefined;

  const summary = await runBench({
    scenarios,
    legacyOrchestrator,
    wineSearchOrchestrator,
    outputPath: args.output,
    concurrency: args.concurrency,
    timeoutMs: args.timeoutMs,
    logger: consoleLogger,
    includeObservations: args.observations,
    ...(scorer !== undefined ? { scorer } : {}),
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

  if (summary.scoring !== undefined) {
    const s = summary.scoring;
    const dimLines = Object.entries(s.meanDeltaPerDimension)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dim, delta]) => `    ${dim.padEnd(25)} ${formatSignedFixed(delta, 4)}`)
      .join('\n');
    const worstLines = s.worstRegressions.length === 0
      ? '    (none)'
      : s.worstRegressions
        .map((r) => `    scenario=${r.scenarioId} dim=${r.dimension} Δ=${formatSignedFixed(r.delta, 4)}`)
        .join('\n');
    process.stdout.write(
      `\n=== scoring delta summary ===\n`
      + `  total scored:        ${s.total}\n`
      + `  verdict counts:      parity=${s.verdictCounts.parity} improved=${s.verdictCounts.improved} regressed=${s.verdictCounts.regressed} mixed=${s.verdictCounts.mixed}\n`
      + `  mean legacy overall: ${s.meanLegacyOverall.toFixed(4)}\n`
      + `  mean wine overall:   ${s.meanWineSearchOverall.toFixed(4)}\n`
      + `  mean Δoverall:       ${formatSignedFixed(s.meanTotalDelta, 4)}\n`
      + `  per-dimension Δmean:\n${dimLines}\n`
      + `  top regressions:\n${worstLines}\n`
      + `  regressed rate:      ${s.regressedRatePercent.toFixed(2)}% (ceiling ${args.regressedRateCeilingPercent}%)\n`,
    );
    if (args.summaryOutput !== undefined) {
      mkdirSync(dirname(resolve(args.summaryOutput)), { recursive: true });
      writeFileSync(resolve(args.summaryOutput), JSON.stringify(s, null, 2));
      process.stdout.write(`  summary written:     ${args.summaryOutput}\n`);
    }
  }

  // Exit-code policy:
  //  - When scoring is enabled, regressed-rate is the dominant signal —
  //    behavioural parity (`equivalentPercent`) is a softer check.
  //  - When scoring is off, fall back to the historic equivalent-percent gate.
  const parityOk = summary.equivalentPercent >= args.passThresholdPercent;
  const scoringOk = summary.scoring === undefined
    || summary.scoring.regressedRatePercent <= args.regressedRateCeilingPercent;

  if (parityOk && scoringOk) {
    process.exit(0);
  } else {
    if (!parityOk) {
      process.stderr.write(
        `parity rate ${summary.equivalentPercent.toFixed(2)}% < threshold ${args.passThresholdPercent}%\n`,
      );
    }
    if (!scoringOk && summary.scoring !== undefined) {
      process.stderr.write(
        `regressed rate ${summary.scoring.regressedRatePercent.toFixed(2)}% > ceiling ${args.regressedRateCeilingPercent}%\n`,
      );
    }
    process.exit(1);
  }
}

/**
 * Strip the `observations` array from each side of a `ShadowModeReport`
 * before JSONL serialization. The in-memory report retains observations
 * (the bench scorer reads them for faithfulness / contextRecall before
 * JSONL emission); this helper only sanitizes the on-disk artifact.
 *
 * Returns a new object — does NOT mutate the input. Important: the scorer
 * has already been invoked by the time this is called, so dropping the
 * field here cannot affect the scoring result on the same line.
 */
function stripObservationsFromReport(report: ShadowModeReport): ShadowModeReport {
  // Spread-and-omit pattern (exactOptionalPropertyTypes-safe).
  const stripOutcome = (
    outcome: ShadowModeReport['legacy'],
  ): ShadowModeReport['legacy'] => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional destructure to drop a field
    const { observations: _observations, ...rest } = outcome;
    return rest;
  };
  return {
    ...report,
    legacy: stripOutcome(report.legacy),
    wineSearch: stripOutcome(report.wineSearch),
  };
}

/** Format `value` with sign + fixed-point precision, deterministic output
 *  (CLAUDE.md rule 21 — never `toLocaleString` for machine-/log-parseable
 *  output). */
function formatSignedFixed(value: number, fractionDigits: number): string {
  if (!Number.isFinite(value)) return 'NaN';
  const fixed = Math.abs(value).toFixed(fractionDigits);
  return value < 0 ? `-${fixed}` : `+${fixed}`;
}

if (isCliEntrypoint(process.argv[1], import.meta.url)) {
  mainCli().catch((err: unknown) => {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(`shadow-mode bench crashed: ${msg}\n`);
    process.exit(1);
  });
}
