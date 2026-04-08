/**
 * SOTA++ agent benchmark runner.
 *
 * Usage:
 *   npx tsx test/benchmark/agent/runner.ts                                    # full suite, mock container
 *   npx tsx test/benchmark/agent/runner.ts --container real                   # real DI container (PG + Redis)
 *   npx tsx test/benchmark/agent/runner.ts --tier single_shot
 *   npx tsx test/benchmark/agent/runner.ts --id 1,2,3
 *   npx tsx test/benchmark/agent/runner.ts --concurrency 5
 *   npx tsx test/benchmark/agent/runner.ts --baseline test/benchmark/agent/results/baseline.json
 *   npx tsx test/benchmark/agent/runner.ts --fail-if-worse-than 0.05
 *   npx tsx test/benchmark/agent/runner.ts --model gpt-4o --judge-model gpt-4o-mini
 *   npx tsx test/benchmark/agent/runner.ts --no-judge                         # disable LLM-as-judge
 *   npx tsx test/benchmark/agent/runner.ts --max-retries 2
 *   npx tsx test/benchmark/agent/runner.ts --seed 42
 *
 * Outputs JSON report to stdout, human-readable summary to stderr.
 *
 * Exit codes:
 *   0 — success (and overall score not worse than baseline by --fail-if-worse-than)
 *   1 — runtime failure (config, container, etc.)
 *   2 — regression detected (overall worse than baseline by threshold)
 */

import { promises as fs } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { loadConfig } from '../../../src/config/env.js';
import { AgentOrchestrator } from '../../../src/application/agent/agent-orchestrator.js';
import { OpenAiChatLlm } from '../../../src/infrastructure/ai/openai-chat-llm.js';
import { AGENT_SCENARIOS, AGENT_SCENARIOS_WITH_PHASE2 } from './scenarios.js';
import { scoreScenario, type ScenarioResult, type ScenarioExecution } from './scorer.js';
import { judgeAnswerN } from './judge.js';
import type { AgentBenchmarkScenario, ScenarioTier, TerminationReason } from './scenario.js';
import type { AgentToolDeps } from '../../../src/application/agent/agent-tools.js';
import type { ChatLlmPort } from '../../../src/domain/ai/port/chat-llm.port.js';
import type { AgentTerminationReason } from '../../../src/domain/agent/model/agent-step.js';

// ─────────────────────────────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────────────────────────────

interface CliArgs {
  readonly tierFilter?: ScenarioTier;
  readonly idFilter?: readonly number[];
  readonly container: 'mock' | 'real';
  readonly concurrency: number;
  readonly maxRetries: number;
  readonly seed?: number;
  readonly model?: string;
  readonly judgeModel?: string;
  readonly enableJudge: boolean;
  readonly judgeSamples: number;
  readonly includePhase2: boolean;
  readonly baseline?: string;
  readonly failIfWorseThan?: number;
  readonly outputPath?: string;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);

  return {
    tierFilter: get('--tier') as ScenarioTier | undefined,
    idFilter: get('--id')?.split(',').map(Number),
    container: (get('--container') as 'mock' | 'real' | undefined) ?? 'mock',
    concurrency: Number.parseInt(get('--concurrency') ?? '1', 10) || 1,
    maxRetries: Number.parseInt(get('--max-retries') ?? '1', 10) || 1,
    seed: get('--seed') !== undefined ? Number.parseInt(get('--seed')!, 10) : undefined,
    model: get('--model'),
    judgeModel: get('--judge-model'),
    enableJudge: !has('--no-judge'),
    judgeSamples: Number.parseInt(get('--judge-samples') ?? '1', 10) || 1,
    includePhase2: has('--include-phase2'),
    baseline: get('--baseline'),
    failIfWorseThan:
      get('--fail-if-worse-than') !== undefined
        ? Number.parseFloat(get('--fail-if-worse-than')!)
        : undefined,
    outputPath: get('--out'),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Mock container (smoke mode)
// ─────────────────────────────────────────────────────────────────────

function buildMockToolDeps(): AgentToolDeps {
  return {
    searchUseCase: {
      async execute(request: { query: string }, requestId: string) {
        return {
          queryType: 'search' as const,
          engineDecision: {
            decisionStatus: 'resolved' as const,
            nextAction: 'return_result' as const,
            route: 'hybrid',
            decisionConfidence: 0.8,
            confidenceSemantics: 'calibrated_decision_confidence' as const,
            decisionTraceRef: 'bench-trace',
            decisionSnapshot: {
              model_versions: {},
              index_versions: {},
              policy_rule_version: '1.0.0',
              threshold_profile_id: 'default-v1',
              planner_version: '1.0.0',
              feature_flags: {},
            },
          },
          results: [
            {
              entity: {
                entityId: 'wine-bench-001',
                canonicalLabel: `Result for: ${request.query.slice(0, 50)}`,
                type: 'wine',
                producer: 'Benchmark Winery',
                region: 'Test Region',
              },
              relevanceScore: 0.85,
              match: {
                matchType: 'hybrid' as const,
                scoreComponents: {
                  lexical: 0,
                  semantic: 0.8,
                  attribute: 0.7,
                  popularity: 0.5,
                  preferenceAlignment: 0.5,
                },
              },
              constraints: { matched: [], unmet: [], inferred: [] },
              uncertainty: {
                uncertaintyConfidence: 0.9,
                missingInfo: [],
                approximationUsed: false,
              },
              evidenceItems: [
                {
                  type: 'semantic_relevance',
                  source: 'benchmark',
                  contribution: '+0.80',
                  strength: 'high' as const,
                  provenance: 'Benchmark evidence',
                },
              ],
            },
          ],
          meta: {
            requestId,
            queryTimeMs: 10,
            route: 'hybrid',
            version: '1.0.0',
            engine_schema_version: 'search_response_v1',
          },
        };
      },
    } as never,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Real container — wires the production DI graph for end-to-end benchmark
// ─────────────────────────────────────────────────────────────────────

async function buildRealToolDeps(): Promise<{
  toolDeps: AgentToolDeps;
  shutdown: () => Promise<void>;
}> {
  // Lazy imports so mock-mode runs don't pay the PG/Redis import cost.
  const { createContainer } = await import('../../../src/config/container.js');
  const { createManagedRuntimeHandles } = await import('../../../src/config/runtime-handles.js');
  const { createPgPool, shouldUsePgPool } = await import('../../../src/infrastructure/db/pg-pool.js');
  const { connectRedisClient } = await import('../../../src/infrastructure/db/redis-client.js');
  const config = loadConfig();

  // Hard timeout for infrastructure connect — node-redis and pg both can
  // hang indefinitely if the daemon isn't listening. The benchmark CLI
  // would otherwise sit at 0% CPU forever, which is exactly the failure
  // mode we hit when running real-mode without local PG/Redis up.
  const CONNECT_TIMEOUT_MS = 5_000;
  const withTimeout = async <T,>(label: string, p: Promise<T>): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timeout after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS),
      ),
    ]);

  let pool: ReturnType<typeof createPgPool> | undefined;
  if (shouldUsePgPool(config.pg)) {
    try {
      const candidate = createPgPool(config.pg);
      // Force an actual round-trip so a missing PG fails fast instead of
      // surfacing on the first planner alias query mid-benchmark.
      await withTimeout('PG connect', (async () => {
        const client = await candidate.connect();
        try {
          await client.query('SELECT 1');
        } finally {
          client.release();
        }
      })());
      pool = candidate;
      console.error('  [INIT] PG pool connected');
    } catch (err) {
      console.error(`  [INIT] PG unavailable (${err instanceof Error ? err.message : String(err)}) — proceeding without`);
    }
  }

  let redisClient: Awaited<ReturnType<typeof connectRedisClient>> | null = null;
  try {
    redisClient = await withTimeout('Redis connect', connectRedisClient(config.redis));
    console.error('  [INIT] Redis connected');
  } catch (err) {
    console.error(`  [INIT] Redis unavailable (${err instanceof Error ? err.message : String(err)}) — proceeding without`);
  }

  const baseHandles = {
    ...(pool ? { pool } : {}),
    ...(redisClient ? { redisClient } : {}),
  };
  const managedRuntime = createManagedRuntimeHandles(baseHandles);
  const container = await createContainer(config, managedRuntime);

  const toolDeps: AgentToolDeps = {
    searchUseCase: container.searchUseCase as never,
    ...(container.decomposedSearchUseCase !== undefined
      ? {
          decomposedSearchExecute: async (
            subQueries: readonly string[],
            comparisonIntent: string,
            originalQuery: string,
            requestId: string,
            startTime: number,
          ) =>
            container.decomposedSearchUseCase.execute(
              subQueries as [string, string],
              comparisonIntent as 'compare' | 'recommend_one' | 'list_both',
              originalQuery,
              requestId,
              startTime,
            ),
        }
      : {}),
  };

  return {
    toolDeps,
    shutdown: async () => {
      await managedRuntime.close();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Termination mapping
// ─────────────────────────────────────────────────────────────────────

function mapTerminationReason(reason: AgentTerminationReason): TerminationReason {
  switch (reason) {
    case 'answer':
      return 'answer';
    case 'timeout':
      return 'timeout';
    case 'error':
      return 'error';
    case 'max_steps':
    case 'budget':
    case 'loop_detected':
    case 'fallback':
    default:
      return 'fallback';
  }
}

// ─────────────────────────────────────────────────────────────────────
// Concurrency primitive — bounded async pool
// ─────────────────────────────────────────────────────────────────────

async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<readonly R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ─────────────────────────────────────────────────────────────────────
// Retry wrapper for transient failures
// ─────────────────────────────────────────────────────────────────────

async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  shouldRetry: (err: unknown) => boolean,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !shouldRetry(err)) throw err;
      // Light exponential backoff: 200ms, 400ms, ...
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }
  throw lastErr;
}

function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    msg.includes('timeout')
    || msg.includes('econnreset')
    || msg.includes('etimedout')
    || msg.includes('rate limit')
    || msg.includes('429')
    || msg.includes('502')
    || msg.includes('503')
    || msg.includes('504')
  );
}

// ─────────────────────────────────────────────────────────────────────
// Statistics helpers
// ─────────────────────────────────────────────────────────────────────

function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo] ?? 0;
  const loVal = sortedAsc[lo] ?? 0;
  const hiVal = sortedAsc[hi] ?? 0;
  return loVal + (hiVal - loVal) * (idx - lo);
}

interface LatencyStats {
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

function summariseLatency(values: readonly number[]): LatencyStats {
  if (values.length === 0) {
    return { mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  return {
    mean,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

/**
 * Wilson score 95% confidence interval for the mean of bounded [0,1] scores.
 *
 * Uses the standard formula:
 *   center = (p + z²/(2n)) / (1 + z²/n)
 *   margin = z * sqrt(p(1-p)/n + z²/(4n²)) / (1 + z²/n)
 *
 * z = 1.96 for 95% confidence. The Wilson interval is preferred over the
 * naive normal approximation because it stays inside [0,1] for small n and
 * extreme proportions, which matches our overall-score distribution.
 */
function wilsonCi95(mean: number, n: number): WilsonCi {
  if (n === 0) return { mean: 0, lower: 0, upper: 0, n: 0 };
  const z = 1.96;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (mean + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt(mean * (1 - mean) / n + z2 / (4 * n * n))) / denom;
  return {
    mean,
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
    n,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Report shape
// ─────────────────────────────────────────────────────────────────────

export interface WilsonCi {
  readonly mean: number;
  readonly lower: number;
  readonly upper: number;
  readonly n: number;
}

export interface BenchmarkReport {
  readonly timestamp: string;
  readonly model: string;
  readonly judgeModel: string | null;
  readonly judgeSamples: number;
  readonly container: 'mock' | 'real';
  readonly seed: number | null;
  readonly scenarioCount: number;
  readonly executedCount: number;
  readonly skippedCount: number;
  readonly errorCount: number;
  readonly criticalFailureCount: number;
  readonly judgeFailCount: number;
  readonly results: readonly ScenarioResult[];
  readonly summary: {
    readonly overallScore: number;
    readonly overallCi95: WilsonCi;
    readonly executionEfficiency: number;
    readonly toolAccuracy: number;
    readonly stepEfficiency: number;
    readonly answerQuality: number;
    readonly terminationCorrectness: number;
    readonly costEfficiency: number;
    /** Mean judge score across scenarios that produced a non-null judge value. */
    readonly judge: number | null;
    readonly avgSteps: number;
    readonly latencyMs: LatencyStats;
    readonly tokens: {
      readonly inputMean: number;
      readonly outputMean: number;
      readonly totalP95: number;
    };
    readonly byTier: Record<string, { readonly count: number; readonly avgScore: number }>;
  };
}

// ─────────────────────────────────────────────────────────────────────
// Main run logic
// ─────────────────────────────────────────────────────────────────────

async function runBenchmark(args: CliArgs): Promise<BenchmarkReport> {
  const config = loadConfig();

  if (config.openai.apiKey === undefined) {
    console.error('ERROR: OPENAI_API_KEY required. Set in .env or environment.');
    process.exit(1);
  }

  const modelId = args.model ?? config.openai.chatModel;
  const judgeModelId = args.enableJudge ? (args.judgeModel ?? 'gpt-4o-mini') : null;

  const chatLlm: ChatLlmPort = new OpenAiChatLlm({
    baseUrl: config.openai.baseUrl,
    apiKey: config.openai.apiKey,
    defaultModel: modelId,
    httpTimeoutMs: config.openai.httpTimeoutMs,
  });
  const judgeLlm: ChatLlmPort | null = judgeModelId !== null
    ? new OpenAiChatLlm({
        baseUrl: config.openai.baseUrl,
        apiKey: config.openai.apiKey,
        defaultModel: judgeModelId,
        httpTimeoutMs: config.openai.httpTimeoutMs,
      })
    : null;

  // Container wiring
  let toolDeps: AgentToolDeps;
  let shutdown: () => Promise<void> = async () => {};
  if (args.container === 'real') {
    console.error('  [INIT] real container — wiring PG + Redis + production deps...');
    const built = await buildRealToolDeps();
    toolDeps = built.toolDeps;
    shutdown = built.shutdown;
  } else {
    console.error('  [INIT] mock container (smoke mode — search returns synthetic results)');
    toolDeps = buildMockToolDeps();
  }

  const orchestrator = new AgentOrchestrator(
    { chatLlm, toolDeps },
    {
      maxSteps: 8, // generous; per-scenario maxSteps is the real budget
      agentTimeoutMs: 60_000,
      perStepTimeoutMs: 20_000,
      maxContextChars: 12_000,
    },
  );

  const baseScenarios = args.includePhase2 ? AGENT_SCENARIOS_WITH_PHASE2 : AGENT_SCENARIOS;
  const scenarios = filterScenarios(baseScenarios, args);

  let judgeFailCount = 0;
  const seenIndices: number[] = [];

  const results = await runWithConcurrency(
    scenarios,
    args.concurrency,
    async (scenario) => {
      const idx = seenIndices.length;
      seenIndices.push(idx);

      if (scenario.skip !== undefined) {
        console.error(`  [SKIP] #${scenario.id} ${scenario.description}: ${scenario.skip}`);
        return scoreScenario(scenario, null, undefined);
      }

      console.error(`  [RUN]  #${scenario.id} ${scenario.description}`);
      const start = Date.now();

      try {
        const result = await withRetry(
          () => orchestrator.execute(scenario.query, `bench-${scenario.id}`),
          args.maxRetries,
          isTransient,
        );

        const toolsUsed = result.steps
          .filter((s) => s.action !== undefined)
          .map((s) => ({
            tool: s.action!.tool,
            input: JSON.stringify(s.action!.input),
          }));

        const execution: ScenarioExecution = {
          answer: result.answer,
          stepCount: result.steps.length,
          toolCallCount: result.toolCallCount,
          toolsUsed,
          terminationReason: mapTerminationReason(result.terminationReason),
          totalDurationMs: result.totalDurationMs,
          totalTokens: result.totalTokens,
        };

        // LLM judge (optional, with N-sample median voting for variance reduction).
        // judge.score === null when judge is disabled / no rubric / all samples failed —
        // the scorer drops the dim from the geo-mean rather than inflating it to 1.
        let judgeScore: number | undefined;
        if (judgeLlm !== null && scenario.expectation.rubric !== undefined) {
          const judgeResult = await judgeAnswerN(judgeLlm, scenario, result.answer, args.judgeSamples);
          if (judgeResult.score !== null) judgeScore = judgeResult.score;
          if (judgeResult.failed) judgeFailCount++;
        }

        const scored = scoreScenario(scenario, execution, judgeScore);
        const elapsed = Date.now() - start;
        console.error(
          `  [DONE] #${scenario.id} score=${scored.scores.overall.toFixed(2)} `
          + `steps=${scored.stepCount} ${elapsed}ms`,
        );
        return scored;
      } catch (err) {
        console.error(
          `  [FAIL] #${scenario.id} ${err instanceof Error ? err.message : String(err)}`,
        );
        return scoreScenario(
          scenario,
          null,
          undefined,
          err instanceof Error ? err.message : String(err),
        );
      }
    },
  );

  await shutdown();

  return buildReport(results, scenarios, modelId, judgeModelId, args, judgeFailCount);
}

function filterScenarios(
  all: readonly AgentBenchmarkScenario[],
  args: CliArgs,
): readonly AgentBenchmarkScenario[] {
  let filtered = all;
  if (args.tierFilter) filtered = filtered.filter((s) => s.tier === args.tierFilter);
  if (args.idFilter) filtered = filtered.filter((s) => args.idFilter!.includes(s.id));
  return filtered;
}

function buildReport(
  results: readonly ScenarioResult[],
  scenarios: readonly AgentBenchmarkScenario[],
  model: string,
  judgeModel: string | null,
  args: CliArgs,
  judgeFailCount: number,
): BenchmarkReport {
  const executed = results.filter((r) => !r.skipped && r.error === undefined);

  // Numeric dimensions only — judge can be null when disabled, so handled separately.
  type NumericDim = 'executionEfficiency' | 'toolAccuracy' | 'stepEfficiency' | 'answerQuality' | 'terminationCorrectness' | 'costEfficiency' | 'overall';
  const avgScore = (field: NumericDim): number => {
    if (executed.length === 0) return 0;
    return executed.reduce((sum, r) => sum + r.scores[field], 0) / executed.length;
  };

  // Judge mean: only over scenarios that produced a non-null judge score.
  const judgeScores = executed
    .map((r) => r.scores.judge)
    .filter((s): s is number => s !== null);
  const judgeMean = judgeScores.length > 0
    ? judgeScores.reduce((sum, s) => sum + s, 0) / judgeScores.length
    : null;

  const byTier: Record<string, { count: number; avgScore: number }> = {};
  for (const r of executed) {
    const entry = byTier[r.tier] ?? { count: 0, avgScore: 0 };
    entry.count++;
    entry.avgScore += r.scores.overall;
    byTier[r.tier] = entry;
  }
  for (const tier of Object.keys(byTier)) {
    byTier[tier]!.avgScore /= byTier[tier]!.count;
  }

  const durations = executed.map((r) => r.totalDurationMs ?? 0);
  const totalTokens = executed.map((r) => (r.totalTokens?.input ?? 0) + (r.totalTokens?.output ?? 0));
  const sortedTokens = [...totalTokens].sort((a, b) => a - b);

  const overallScore = avgScore('overall');
  const criticalFailureCount = executed.filter((r) => r.scores.criticalFailure).length;
  const overallCi95 = wilsonCi95(overallScore, executed.length);

  return {
    timestamp: new Date().toISOString(),
    model,
    judgeModel,
    judgeSamples: args.judgeSamples,
    container: args.container,
    seed: args.seed ?? null,
    scenarioCount: scenarios.length,
    executedCount: executed.length,
    skippedCount: results.filter((r) => r.skipped).length,
    errorCount: results.filter((r) => r.error !== undefined).length,
    criticalFailureCount,
    judgeFailCount,
    results,
    summary: {
      overallScore,
      overallCi95,
      executionEfficiency: avgScore('executionEfficiency'),
      toolAccuracy: avgScore('toolAccuracy'),
      stepEfficiency: avgScore('stepEfficiency'),
      answerQuality: avgScore('answerQuality'),
      terminationCorrectness: avgScore('terminationCorrectness'),
      costEfficiency: avgScore('costEfficiency'),
      judge: judgeMean,
      avgSteps:
        executed.length > 0
          ? executed.reduce((s, r) => s + (r.stepCount ?? 0), 0) / executed.length
          : 0,
      latencyMs: summariseLatency(durations),
      tokens: {
        inputMean:
          executed.length > 0
            ? executed.reduce((s, r) => s + (r.totalTokens?.input ?? 0), 0) / executed.length
            : 0,
        outputMean:
          executed.length > 0
            ? executed.reduce((s, r) => s + (r.totalTokens?.output ?? 0), 0) / executed.length
            : 0,
        totalP95: percentile(sortedTokens, 0.95),
      },
      byTier,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Baseline comparison
// ─────────────────────────────────────────────────────────────────────

async function compareBaseline(
  current: BenchmarkReport,
  baselinePath: string,
  failIfWorseThan: number | undefined,
): Promise<{ regressed: boolean; delta: number }> {
  try {
    const raw = await fs.readFile(resolvePath(baselinePath), 'utf8');
    const baseline = JSON.parse(raw) as BenchmarkReport;
    const delta = current.summary.overallScore - baseline.summary.overallScore;
    const threshold = failIfWorseThan ?? 0.05;
    const regressed = delta < -threshold;
    console.error(
      `\n  [BASELINE] current=${current.summary.overallScore.toFixed(3)} `
      + `baseline=${baseline.summary.overallScore.toFixed(3)} `
      + `delta=${delta >= 0 ? '+' : ''}${delta.toFixed(3)} `
      + `(threshold=−${threshold.toFixed(3)})`,
    );
    if (regressed) {
      console.error(`  [BASELINE] ❌ REGRESSION: overall dropped by more than ${threshold}`);
    }
    return { regressed, delta };
  } catch (err) {
    console.error(
      `  [BASELINE] read failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { regressed: false, delta: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  const report = await runBenchmark(args);

  // JSON to stdout (or to file if --out)
  const json = JSON.stringify(report, null, 2);
  if (args.outputPath !== undefined) {
    await fs.writeFile(resolvePath(args.outputPath), json, 'utf8');
    console.error(`  [OUT] wrote ${args.outputPath}`);
  } else {
    console.log(json);
  }

  // Human-readable summary to stderr
  const s = report.summary;
  console.error('\n══════════════════════════════════════');
  console.error('  AGENT BENCHMARK SUMMARY (SOTA++)');
  console.error('══════════════════════════════════════');
  console.error(`  Container:    ${report.container}`);
  console.error(`  Model:        ${report.model}`);
  console.error(`  Judge:        ${report.judgeModel ?? 'disabled'}${report.judgeSamples > 1 ? ` (N=${report.judgeSamples} median)` : ''}`);
  console.error(`  Scenarios:    ${report.scenarioCount} (${report.executedCount} executed, `
    + `${report.skippedCount} skipped, ${report.errorCount} errored)`);
  if (report.criticalFailureCount > 0) {
    console.error(`  ⚠ Critical:   ${report.criticalFailureCount} scenario(s) had a critical failure (overall=0)`);
  }
  if (report.judgeFailCount > 0) {
    console.error(`  Judge fails:  ${report.judgeFailCount}`);
  }
  console.error(
    `  Overall:      ${(s.overallScore * 100).toFixed(1)}% (geo-mean) `
    + `[95% CI ${(s.overallCi95.lower * 100).toFixed(1)}–${(s.overallCi95.upper * 100).toFixed(1)}%, n=${s.overallCi95.n}]`,
  );
  console.error('  ────── dimensions ──────');
  console.error(`  Exec Eff:     ${(s.executionEfficiency * 100).toFixed(1)}%   (tool ${(s.toolAccuracy * 100).toFixed(0)}% × step ${(s.stepEfficiency * 100).toFixed(0)}%)`);
  console.error(`  Answer Qual:  ${(s.answerQuality * 100).toFixed(1)}%`);
  console.error(`  Term Corr:    ${(s.terminationCorrectness * 100).toFixed(1)}%`);
  console.error(`  Cost Eff:     ${(s.costEfficiency * 100).toFixed(1)}%`);
  console.error(`  Judge:        ${s.judge !== null ? `${(s.judge * 100).toFixed(1)}%` : 'disabled'}`);
  console.error('  ────── execution ───────');
  console.error(`  Avg Steps:    ${s.avgSteps.toFixed(1)}`);
  console.error(`  Latency p50:  ${s.latencyMs.p50.toFixed(0)}ms`);
  console.error(`  Latency p95:  ${s.latencyMs.p95.toFixed(0)}ms`);
  console.error(`  Latency p99:  ${s.latencyMs.p99.toFixed(0)}ms`);
  console.error(`  Latency max:  ${s.latencyMs.max.toFixed(0)}ms`);
  console.error(`  Tokens in:    ${s.tokens.inputMean.toFixed(0)} mean`);
  console.error(`  Tokens out:   ${s.tokens.outputMean.toFixed(0)} mean`);
  console.error(`  Tokens p95:   ${s.tokens.totalP95.toFixed(0)} total`);
  console.error('  ────── by tier ─────────');
  const sortedTiers = Object.entries(s.byTier).sort((a, b) => b[1].avgScore - a[1].avgScore);
  for (const [tier, data] of sortedTiers) {
    console.error(`  ${tier.padEnd(22)} ${(data.avgScore * 100).toFixed(1)}% (${data.count})`);
  }
  console.error('══════════════════════════════════════\n');

  // Baseline comparison gate
  if (args.baseline !== undefined) {
    const { regressed } = await compareBaseline(report, args.baseline, args.failIfWorseThan);
    if (regressed) {
      process.exit(2);
    }
  }
}

main().catch((err: unknown) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
