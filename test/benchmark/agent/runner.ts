/**
 * SOTA++ agent benchmark runner — real container (PG + Redis + Vespa).
 *
 * For a fast mock-only smoke test (no infra required), use smoke.ts instead:
 *   npx tsx test/benchmark/agent/smoke.ts
 *
 * Usage:
 *   npx tsx test/benchmark/agent/runner.ts                                    # all scenarios (no --profile), real container, judge on
 *   npx tsx test/benchmark/agent/runner.ts --tier single_shot
 *   npx tsx test/benchmark/agent/runner.ts --id 1,2,3
 *   npx tsx test/benchmark/agent/runner.ts --concurrency 5
 *   npx tsx test/benchmark/agent/runner.ts --baseline test/benchmark/agent/results/baseline.json
 *   npx tsx test/benchmark/agent/runner.ts --fail-if-worse-than 0.05
 *   npx tsx test/benchmark/agent/runner.ts --model gpt-5.4 --judge-model gpt-5.4-mini
 *   npx tsx test/benchmark/agent/runner.ts --no-judge                         # disable LLM-as-judge
 *   npx tsx test/benchmark/agent/runner.ts --max-retries 2
 *   npx tsx test/benchmark/agent/runner.ts --seed 42
 *   npx tsx test/benchmark/agent/runner.ts --profile quick                     # 20 key scenarios, concurrency 3, judge off, retries 1
 *   npx tsx test/benchmark/agent/runner.ts --profile quick-realdata             # 60 high-signal scenarios, concurrency 5, judge on (~6-10 min)
 *   npx tsx test/benchmark/agent/runner.ts --profile standard                  # 80 curated scenarios, concurrency 3, judge on
 *   npx tsx test/benchmark/agent/runner.ts --profile nightly                   # all 233 scenarios, concurrency 3, judge on (3 samples)
 *   npx tsx test/benchmark/agent/runner.ts --profile retrieval                 # agent benchmark on scenarios with golden retrieval IDs
 *   npx tsx test/benchmark/agent/runner.ts --profile messy-search              # in-domain messy search slice, judge on
 *
 * Outputs JSON report to stdout, human-readable summary to stderr.
 * Wall-clock profiling: `wallClock` in JSON + "wall clock" section on stderr
 * (init → scenario pool → shutdown, per-scenario mean/sum, `concurrency`).
 * `sumScenarioWallMs` is sequential work-time; with concurrency greater than 1 it can
 * exceed `scenariosPhaseMs` (pool wall). `scenarioWallSampleCount` counts
 * scenarios that actually ran (not skipped), including errors.
 *
 * Exit codes:
 *   0 — success (and overall score not worse than baseline by --fail-if-worse-than)
 *   1 — runtime failure (config, container, etc.)
 *   2 — regression detected (overall worse than baseline by threshold)
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { formatBenchmarkDurationMs } from './benchmark-duration-format.js';
import { isBenchmarkRunnerCliEntrypoint } from './runner-cli-entry.js';
import { loadConfig } from '../../../src/config/env.js';
import { AgentOrchestrator } from '../../../src/application/agent/agent-orchestrator.js';
import { OpenAiChatLlm } from '../../../src/infrastructure/ai/openai-chat-llm.js';
import { AnthropicChatLlm } from '../../../src/infrastructure/ai/anthropic-chat-llm.js';
import { QuerySanitizer } from '../../../src/domain/security/service/query-sanitizer.js';
import { AGENT_SCENARIOS, MESSY_SEARCH_SCENARIO_IDS, STANDARD_SCENARIO_IDS } from './scenarios.js';
import { scoreScenario, type ScenarioResult, type ScenarioExecution, type StepTrace } from './scorer.js';
import { judgeAnswerN, judgeFaithfulness } from './judge.js';
import { evaluateScenarioClaims } from './claim-evaluator-adapter.js';
import { runConstraintExtraction } from './constraint-extraction-eval.js';
import { printBenchmarkInsights, type BenchmarkReportSlice } from './benchmark-insight-generator.js';
import { scoreSemanticConstraintRecall, scoreEntityLinkingAccuracy, scoreSlotF1, scoreConstraintSatisfactionRate } from './constraint-metrics.js';
import type { ConstraintExtractionMetricsInput } from './scorer.js';
import type { AgentBenchmarkScenario, ScenarioExpectation, ScenarioTier, TerminationReason } from './scenario.js';
import type { DiagnosticVector } from '../../../src/domain/evaluation/model/claim.js';
import type { AgentToolDeps } from '../../../src/application/agent/agent-tools.js';
import { InMemoryCorpusCardinalityCache } from '../../../src/domain/retrieval/service/corpus-cardinality-cache.js';
import type { ChatLlmPort } from '../../../src/domain/ai/port/chat-llm.port.js';
import { buildSystemMessage } from '../../../src/application/agent/agent-prompt.js';
import type { AgentTerminationReason } from '../../../src/domain/agent/model/agent-step.js';

export { formatBenchmarkDurationMs } from './benchmark-duration-format.js';

// ─────────────────────────────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────────────────────────────

interface CliArgs {
  readonly profile?: 'quick' | 'quick-realdata' | 'standard' | 'nightly' | 'retrieval' | 'messy-search';
  readonly tierFilter?: ScenarioTier;
  readonly idFilter?: readonly number[];
  readonly container: 'real';
  readonly concurrency: number;
  readonly maxRetries: number;
  readonly seed?: number;
  readonly model?: string;
  readonly judgeModel?: string;
  readonly enableJudge: boolean;
  readonly judgeSamples: number;
  readonly baseline?: string;
  readonly failIfWorseThan?: number;
  readonly outputPath?: string;
}

type CriticalWineType = 'red' | 'white' | 'sparkling';
type CriticalWineTypeCoverage = Record<CriticalWineType, number>;

// 20 scenario IDs spread across tiers for the "quick" profile (~2 min PR smoke test).
const QUICK_SCENARIO_IDS = new Set([
  1, 4, 8, 12, 19, 25, 30, 35, 40, 45,  // core tiers
  50, 56, 61, 65, 68, 75, 81, 88, 93, 98,  // language/adversarial
]);

/**
 * "quick-realdata" profile — 60 high-signal scenarios for fast iteration with real infra.
 * Selection criteria:
 *   - All 5 worst performers from last standard run (#32, #42, #63, #90, #106)
 *   - Adversarial tier: full coverage (refusal, injection, jailbreak, PII, unicode)
 *   - Weak tiers: single_shot×5, negation_complex×4, wine_type_basic×3, korean_colloquial×4
 *   - Healthy regression guards: nested_condition×4, comparison_nested×3, multi_step×3
 *   - Broad tier sampling: negation, situation_based, gift_refined, knowledge_hybrid, extreme
 * Concurrency 5 (keeps the initial burst below the observed gpt-5.4-mini TPM ceiling), judge on, ~6-10 min wall clock.
 */
const QUICK_REALDATA_SCENARIO_IDS = new Set([
  // Worst performers (regression must-haves)
  106, 32, 42, 90, 63,
  // Adversarial — full tier coverage
  101, 102, 103, 104, 105, 107, 108, 109, 110, 111,
  // single_shot (weakest tier)
  1, 2, 3, 4, 7,
  // negation_complex
  70, 71, 72, 73,
  // wine_type_basic
  5, 6, 8,
  // korean_colloquial
  60, 61, 62, 64,
  // negation
  25, 26, 27, 28,
  // multi_step
  15, 16, 17,
  // situation_based
  40, 41, 43,
  // nested_condition (regression guard)
  50, 51, 52, 53,
  // comparison_nested
  55, 56, 57,
  // gift_refined
  88, 89, 90,
  // knowledge_hybrid
  30, 31,
  // extreme
  80, 81,
  // taste_descriptor
  20, 21,
]);

/**
 * "messy-search" profile — in-domain free-form wine search slice.
 *
 * Focus:
 *   - colloquial Korean, typos, abbreviations, bilingual overlap
 *   - gift / mood / situation-based recommendation under uncertainty
 *   - beginner-safe / crowd-pleasing retrieval alignment
 *
 * Judge-on by default because the hard part here is semantic intent alignment,
 * not tool-path correctness. Concurrency defaults to 2 to keep the initial
 * judge burst below provider RPM/TPM ceilings while still moving steadily.
 */
const MESSY_SEARCH_DEFAULT_CONCURRENCY = 2;

function parseOptionalInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseIdFilter(raw: string | undefined): readonly number[] | undefined {
  if (raw === undefined) return undefined;
  const ids = raw
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((id) => Number.isFinite(id));
  return ids.length > 0 ? ids : undefined;
}

export function parseRunnerArgs(argv: readonly string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);

  const explicitId = get('--id');
  const explicitConcurrency = get('--concurrency');
  const explicitNoJudge = has('--no-judge');
  const explicitJudgeModel = get('--judge-model');
  // --judge-model explicitly passed counts as opting into judge mode
  const explicitJudge = explicitNoJudge || explicitJudgeModel !== undefined;
  const explicitJudgeSamples = get('--judge-samples');

  const profile = get('--profile') as CliArgs['profile'];

  let args: CliArgs = {
    profile,
    tierFilter: get('--tier') as ScenarioTier | undefined,
    idFilter: parseIdFilter(explicitId),
    container: 'real',
    concurrency: parseOptionalInt(explicitConcurrency, 3),
    // v4: default is 1 (no retry). The OpenAI client already does 4 inner retries
    // with Retry-After header support — adding scenario-level retries was redundant
    // and wasteful (re-runs all completed steps). The real fix for 429s lives in
    // the LLM client (sleepWithJitter for 429s eliminates synchronized retry storms).
    maxRetries: parseOptionalInt(get('--max-retries'), 1),
    seed: get('--seed') !== undefined ? Number.parseInt(get('--seed')!, 10) : undefined,
    model: get('--model'),
    judgeModel: get('--judge-model'),
    enableJudge: !explicitNoJudge,
    judgeSamples: parseOptionalInt(explicitJudgeSamples, 3),
    baseline: get('--baseline'),
    failIfWorseThan:
      get('--fail-if-worse-than') !== undefined
        ? Number.parseFloat(get('--fail-if-worse-than')!)
        : undefined,
    outputPath: get('--out'),
  };

  // Apply profile defaults AFTER parsing individual flags so explicit flags still override.
  if (profile === 'quick') {
    if (explicitId === undefined) {
      args = { ...args, idFilter: [...QUICK_SCENARIO_IDS] };
    }
    if (explicitConcurrency === undefined) {
      args = { ...args, concurrency: 3 };
    }
    if (!explicitJudge) {
      args = { ...args, enableJudge: false };
    }
  }

  if (profile === 'standard') {
    // 80 curated scenarios — all tiers represented, critical adversarial 100% included
    if (explicitId === undefined) {
      args = { ...args, idFilter: [...STANDARD_SCENARIO_IDS] };
    }
    if (explicitConcurrency === undefined) {
      args = { ...args, concurrency: 3 };
    }
    if (!explicitJudge) {
      args = { ...args, enableJudge: true };
    }
  }

  if (profile === 'nightly') {
    // All 233 scenarios, judge 3 samples for statistical stability
    if (explicitConcurrency === undefined) {
      args = { ...args, concurrency: 3 };
    }
    if (!explicitJudge) {
      args = { ...args, enableJudge: true };
    }
    if (explicitJudgeSamples === undefined) {
      args = { ...args, judgeSamples: 3 };
    }
  }

  if (profile === 'quick-realdata') {
    // 60 high-signal scenarios, concurrency 5, judge on — still fast enough for
    // iteration while reducing the initial burst that previously triggered 429 cascades.
    if (explicitId === undefined) {
      args = { ...args, idFilter: [...QUICK_REALDATA_SCENARIO_IDS] };
    }
    if (explicitConcurrency === undefined) {
      args = { ...args, concurrency: 5 };
    }
    if (!explicitJudge) {
      args = { ...args, enableJudge: true };
    }
  }

  if (profile === 'retrieval') {
    if (explicitConcurrency === undefined) {
      args = { ...args, concurrency: 3 };
    }
    if (!explicitJudge) {
      args = { ...args, enableJudge: false };
    }
  }

  if (profile === 'messy-search') {
    if (explicitId === undefined) {
      args = { ...args, idFilter: [...MESSY_SEARCH_SCENARIO_IDS] };
    }
    if (explicitConcurrency === undefined) {
      args = { ...args, concurrency: MESSY_SEARCH_DEFAULT_CONCURRENCY };
    }
    if (!explicitJudge) {
      args = { ...args, enableJudge: true };
    }
  }

  return args;
}

function parseArgs(): CliArgs {
  return parseRunnerArgs(process.argv.slice(2));
}

function parseCoverageCount(raw: unknown, wineType: CriticalWineType): number {
  const count = typeof raw === 'number' ? raw : Number(raw ?? 0);
  if (!Number.isFinite(count)) {
    throw new Error(
      `Agent benchmark preflight failed: Vespa count for wine_type=${wineType} is not finite (${String(raw)})`,
    );
  }
  return Math.trunc(count);
}

export function assertCriticalWineTypeCoverage(
  coverage: CriticalWineTypeCoverage,
): void {
  const missing = (Object.entries(coverage) as Array<[CriticalWineType, number]>)
    .filter(([, count]) => count <= 0)
    .map(([wineType]) => wineType);
  if (missing.length === 0) {
    return;
  }

  throw new Error(
    `Agent benchmark preflight failed: critical Vespa wine_type coverage missing (${missing.join(', ')}). `
    + `counts=${JSON.stringify(coverage)}`,
  );
}

export async function fetchCriticalWineTypeCoverage(
  vespaClient: {
    query(
      yql: string,
      params?: Record<string, unknown>,
      signal?: AbortSignal,
      requestId?: string,
    ): Promise<{ root?: { fields?: { totalCount?: unknown } } }>;
  },
): Promise<CriticalWineTypeCoverage> {
  const entries = await Promise.all((['red', 'white', 'sparkling'] as const).map(async (wineType) => {
    const yql = `select * from sources * where wine_type contains "${wineType}" limit 0`;
    const response = await vespaClient.query(yql, undefined, undefined, `agent-bench-coverage:${wineType}`);
    return [wineType, parseCoverageCount(response.root?.fields?.totalCount, wineType)] as const;
  }));
  return Object.fromEntries(entries) as CriticalWineTypeCoverage;
}

// ─────────────────────────────────────────────────────────────────────
// Real container — wires the production DI graph for end-to-end benchmark
// ─────────────────────────────────────────────────────────────────────

async function buildRealToolDeps(): Promise<{
  toolDeps: AgentToolDeps;
  shutdown: () => Promise<void>;
}> {
  // Lazy imports so the module graph stays lean when imported for type checking.
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
  const vespaClient = ((container.candidatePool as unknown as {
    readonly searchIndex?: { readonly client?: Parameters<typeof fetchCriticalWineTypeCoverage>[0] };
  }).searchIndex?.client);
  if (vespaClient === undefined) {
    throw new Error(
      'Agent benchmark preflight failed: candidatePool searchIndex client is unavailable for Vespa coverage verification.',
    );
  }
  const coverage = await fetchCriticalWineTypeCoverage(vespaClient);
  assertCriticalWineTypeCoverage(coverage);

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
    entityLookup: async (id) => {
      const docs = await container.entityLookup.getDocuments([id]);
      return docs.get(id) ?? undefined;
    },
    ...(container.entityLookup.getDrinkingWindowDocuments !== undefined
      ? {
          drinkingWindowEntityLookup: async (id) => {
            const docs = await container.entityLookup.getDrinkingWindowDocuments!([id]);
            return docs.get(id) ?? undefined;
          },
        }
      : {}),
    // Phase 1: corpus cardinality — prevents futile retries on small wine-type pools.
    // Uses empty cache (all types → corpus_limited) until real Vespa cardinality query is wired.
    corpusCardinality: InMemoryCorpusCardinalityCache.empty(),
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
    case 'blocked':
      return 'blocked';
    case 'max_steps':
    case 'budget':
    case 'loop_detected':
    case 'fallback':
    default:
      return 'fallback';
  }
}

async function computeConstraintMetricsForScenario(
  scenario: AgentBenchmarkScenario,
  observations: readonly string[],
): Promise<ConstraintExtractionMetricsInput | undefined> {
  const hasExpectedConstraints = scenario.expectation.expectedConstraints !== undefined;
  const hasExpectedEntities = scenario.expectation.expectedEntities !== undefined;
  if (!hasExpectedConstraints && !hasExpectedEntities) {
    return undefined;
  }

  const extraction = await runConstraintExtraction(scenario.query);
  const graph = extraction.constraintGraph;
  const scr = hasExpectedConstraints && scenario.expectation.expectedConstraints
    ? scoreSemanticConstraintRecall(
        extraction.bundle,
        scenario.expectation.expectedConstraints,
        'relaxed',
        graph,
      )
    : { scrOverall: null, scrHard: null, scrSoft: null, scrInferred: null, scrInferredGraph: null };
  const ela = hasExpectedEntities && scenario.expectation.expectedEntities
    ? scoreEntityLinkingAccuracy(
      scenario.expectation.expectedEntities,
      extraction.resolvedEntities,
    )
    : { ela1: null };
  const slot = hasExpectedConstraints && scenario.expectation.expectedConstraints
    ? scoreSlotF1(extraction.bundle, scenario.expectation.expectedConstraints)
    : { strict: null, relaxed: null };

  // P4: Constraint Satisfaction Rate — measures whether retrieval results
  // actually satisfy the constraints that the NL extraction pipeline produced.
  // Requires observations (agent tool results) to check evidence.
  // ADR-011 PR2 dual-emit: graph threaded so `csrInferredGraph` is populated
  // alongside the flat `csrInferred`.
  const csr = observations.length > 0
    ? scoreConstraintSatisfactionRate(extraction.bundle, observations, graph)
    : { csrHard: null, csrSoft: null, csrInferred: null, csrInferredGraph: null, csrOverall: null };

  return {
    semanticConstraintRecall: scr.scrOverall,
    scrHard: scr.scrHard,
    scrSoft: scr.scrSoft,
    scrInferred: scr.scrInferred,
    scrInferredGraph: scr.scrInferredGraph,
    entityLinkingAccuracy: ela.ela1,
    slotF1Strict: slot.strict,
    slotF1Relaxed: slot.relaxed,
    csrOverall: csr.csrOverall,
    csrHard: csr.csrHard,
    csrSoft: csr.csrSoft,
    csrInferred: csr.csrInferred,
    csrInferredGraph: csr.csrInferredGraph,
  };
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
  // Use an explicit queue instead of a shared cursor++ to avoid the race where
  // two workers read the same index before either increments (JS is single-
  // threaded but await yields control, so cursor++ is NOT atomic across awaits).
  const queue: number[] = Array.from({ length: items.length }, (_, i) => i);
  // v4: worker startup jitter to break the thundering herd at T=0.
  // Without this, N workers fire their first LLM call in the same millisecond,
  // saturating provider RPM/TPM in a single burst → cascading 429s. Spread the
  // initial workers across a 1-second window so the first calls are decorrelated.
  const STARTUP_JITTER_MS_PER_WORKER = 333;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async (_, workerIdx) => {
    if (workerIdx > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, workerIdx * STARTUP_JITTER_MS_PER_WORKER));
    }
    while (true) {
      const i = queue.shift();
      if (i === undefined) break;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ─────────────────────────────────────────────────────────────────────
// Retry wrapper for transient failures
// ─────────────────────────────────────────────────────────────────────

// Backoff constants — named so audit/review can verify the arithmetic.
// Rate-limit (429): TPM windows reset every 60s; start at 5s to give the
// quota time to recover: 5s → 10s → 20s (capped at RUNNER_RATE_LIMIT_MAX_MS).
const RUNNER_RATE_LIMIT_BASE_MS = 5_000;
const RUNNER_RATE_LIMIT_MAX_MS = 30_000;
// Transient errors (5xx, network): short jittered backoff, not quota-related.
const RUNNER_TRANSIENT_BASE_MS = 200;

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return msg.includes('rate limit') || msg.includes('429');
}

function normalizeRunnerError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }
  if (err === undefined) {
    return new Error('Scenario failed with undefined rejection (upstream threw/rejected undefined)');
  }
  if (err === null) {
    return new Error('Scenario failed with null rejection (upstream threw/rejected null)');
  }
  if (typeof err === 'string' || typeof err === 'number' || typeof err === 'boolean' || typeof err === 'bigint') {
    return new Error(`Scenario failed with non-Error rejection: ${String(err)}`);
  }
  return new Error('Scenario failed with non-Error rejection: [non-stringifiable object]');
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  shouldRetry: (err: unknown) => boolean,
): Promise<T> {
  // `--max-retries N` means "initial attempt + up to N retries".
  // N=0 must still execute fn() once; otherwise the runner skips the scenario
  // entirely and falls through to `throw undefined`.
  const totalAttempts = Math.max(1, maxRetries + 1);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= totalAttempts || !shouldRetry(err)) throw normalizeRunnerError(err);
      // Rate-limit errors (429/TPM): slow exponential backoff — quota windows
      // are 60s; fast retries just keep hitting the wall.
      // Other transient errors (5xx, network): light exponential backoff.
      const delayMs = isRateLimitError(err)
        ? Math.min(RUNNER_RATE_LIMIT_BASE_MS * 2 ** (attempt - 1), RUNNER_RATE_LIMIT_MAX_MS)
        : RUNNER_TRANSIENT_BASE_MS * attempt;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw normalizeRunnerError(lastErr);
}

function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  // Explicitly exclude 4xx client errors — retrying Bad Request / Unauthorized
  // / Forbidden never helps and wastes budget. Only 5xx + network + rate-limit
  // are genuinely transient.
  if (msg.includes('400') || msg.includes('401') || msg.includes('403') || msg.includes('404') || msg.includes('405')) {
    return false;
  }
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

// ── Latency SLA thresholds (KPI targets) ──
/** p50 must be under this for SLA pass (ms). */
const LATENCY_SLA_P50_MS = 10_000;
/** p95 must be under this for SLA pass (ms). */
const LATENCY_SLA_P95_MS = 20_000;
/** Individual scenario hard timeout (ms) — exceeding this = SLA violation. */
const LATENCY_SLA_TIMEOUT_MS = 30_000;

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
 * Student-t 95% confidence interval for the mean of continuous bounded
 * [0,1] scores. The earlier implementation used Wilson, which is designed
 * for binomial PROPORTIONS (k successes / n trials) — applying it to a
 * continuous geo-mean ignores within-sample variance entirely. Two runs
 * with the same mean but different variances would report identical CIs.
 *
 * We use the t-distribution with n-1 degrees of freedom and the sample
 * standard deviation (Bessel-corrected). Result is clipped to [0,1].
 *
 * For n < 2 the SD is undefined; we degenerate to a zero-width interval
 * around the mean rather than reporting a misleading CI from a single point.
 */
function tCi95(values: readonly number[]): WilsonCi {
  const n = values.length;
  if (n === 0) return { mean: 0, lower: 0, upper: 0, n: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  if (n === 1) return { mean, lower: mean, upper: mean, n: 1 };

  // Bessel-corrected sample variance.
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  const standardError = sd / Math.sqrt(n);

  // Two-tailed Student-t critical values for α=0.05. Cubic table covering
  // the range we care about for benchmark suites (n=2..200). Falls back to
  // 1.96 (z) for n > 200 where t→z.
  const tCrit = tCriticalValue95(n - 1);
  const margin = tCrit * standardError;
  return {
    mean,
    lower: Math.max(0, mean - margin),
    upper: Math.min(1, mean + margin),
    n,
  };
}

/**
 * Two-tailed t-distribution critical value at α=0.05 for given degrees of
 * freedom. Lookup table for df=1..30; analytic interpolation thereafter.
 */
function tCriticalValue95(df: number): number {
  if (df <= 0) return 12.706; // df=1 fallback
  const table: Record<number, number> = {
    1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
    6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
    11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131,
    16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086,
    21: 2.080, 22: 2.074, 23: 2.069, 24: 2.064, 25: 2.060,
    26: 2.056, 27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042,
  };
  if (df in table) return table[df]!;
  // df > 30: t approaches z=1.96; smooth interpolation.
  if (df < 60) return 2.042 - (2.042 - 2.000) * ((df - 30) / 30);
  if (df < 120) return 2.000 - (2.000 - 1.980) * ((df - 60) / 60);
  return 1.96;
}

/**
 * Bootstrap 95% CI (2026 SOTA — distribution-free, no normality assumption).
 *
 * Resamples the score array B times with replacement, computes the geo-mean
 * of each resample, and reports the 2.5th/97.5th percentiles. More robust
 * than Student-t for skewed distributions (common with geo-mean scoring).
 *
 * Uses a fixed seed (scenario count) for reproducibility across runs.
 */
const BOOTSTRAP_RESAMPLES = 2_000;

function bootstrapCi95(values: readonly number[]): WilsonCi {
  const n = values.length;
  if (n === 0) return { mean: 0, lower: 0, upper: 0, n: 0 };
  if (n === 1) {
    const v = values[0] ?? 0;
    return { mean: v, lower: v, upper: v, n: 1 };
  }

  // Simple seeded PRNG (mulberry32) for reproducibility.
  let seed = n * 2654435761;
  const rand = (): number => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const EPS = 1e-12;
  const geoMeans: number[] = [];
  for (let b = 0; b < BOOTSTRAP_RESAMPLES; b++) {
    let logSum = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rand() * n);
      logSum += Math.log(Math.max(values[idx] ?? EPS, EPS));
    }
    geoMeans.push(Math.exp(logSum / n));
  }

  geoMeans.sort((a, b) => a - b);
  const lo = geoMeans[Math.floor(0.025 * BOOTSTRAP_RESAMPLES)] ?? 0;
  const hi = geoMeans[Math.floor(0.975 * BOOTSTRAP_RESAMPLES)] ?? 1;
  const mean = Math.exp(values.reduce((s, v) => s + Math.log(Math.max(v, EPS)), 0) / n);

  return { mean, lower: Math.max(0, lo), upper: Math.min(1, hi), n };
}

// ─────────────────────────────────────────────────────────────────────
// Report shape
// ─────────────────────────────────────────────────────────────────────

/**
 * 95% confidence interval for a continuous mean. The type name was historical
 * (originally Wilson) — actual implementation now uses Student-t with sample
 * variance. Field shape kept stable for baseline JSON compat.
 */
export interface WilsonCi {
  readonly mean: number;
  readonly lower: number;
  readonly upper: number;
  readonly n: number;
}

/**
 * End-to-end wall clock for the benchmark process (distinct from per-scenario
 * `summary.latencyMs`, which reflects orchestrator-reported durations).
 */
export interface BenchmarkWallClock {
  /** Config load + container wiring + orchestrator construction. */
  readonly initMs: number;
  /**
   * Wall time for `runWithConcurrency` (all scenarios). When concurrency is
   * greater than 1 this is less than the sum of per-scenario walls.
   */
  readonly scenariosPhaseMs: number;
  /** Pool quit / Redis close (capped by shutdown race timeout). */
  readonly shutdownMs: number;
  /** init + scenario phase + shutdown (full `runBenchmark`). */
  readonly totalMs: number;
  /** Arithmetic mean of per-scenario wall time (skipped scenarios excluded). */
  readonly meanScenarioWallMs: number;
  /** Sum of per-scenario wall times (sequential work-time lower bound). */
  readonly sumScenarioWallMs: number;
  /** Count of scenarios that contributed to mean/sum (executed or errored, not skipped). */
  readonly scenarioWallSampleCount: number;
  /** Same as CLI `--concurrency`; explains pool wall vs sum of per-scenario walls. */
  readonly concurrency: number;
}

/**
 * ADR-011 PR2 dual-emit: structural version of the `baseline.json` contract.
 *
 * - `"v3"`: legacy shape (no `scrInferredGraph` / `csrInferredGraph`). Readers
 *   fall back to `null` for the graph-aware means.
 * - `"v4"`: adds `scrInferredGraph` / `csrInferredGraph` to the summary block.
 *
 * The `compareBaseline` reader accepts both `"v3"` and `"v4"` (one-release
 * compatibility window). Unknown versions fail loudly — never silent.
 */
export const BASELINE_VERSION_CURRENT = 'v4' as const;
export const BASELINE_VERSION_COMPATIBLE = new Set<string>(['v3', 'v4']);

export interface BenchmarkReport {
  /**
   * ADR-011 PR2 dual-emit: explicit structural version of the baseline file
   * so downstream readers can fail loudly on unknown shapes. See
   * {@link BASELINE_VERSION_CURRENT}.
   */
  readonly baselineVersion: typeof BASELINE_VERSION_CURRENT;
  readonly timestamp: string;
  readonly model: string;
  readonly judgeModel: string | null;
  readonly judgeSamples: number;
  /** Embedding model used for dense retrieval (from OPENAI_EMBEDDING_MODEL). */
  readonly embeddingModel: string;
  /** Hostname of the OpenAI-compatible API endpoint (e.g. "api.openai.com"). */
  readonly apiBaseDomain: string;
  readonly container: 'real';
  readonly seed: number | null;
  /** Node.js runtime version (e.g. "v22.4.0") for environment reproducibility. */
  readonly nodeVersion: string;
  /** OS platform string (e.g. "darwin", "linux"). */
  readonly platform: string;
  /** SHA-256 hash of the agent system prompt for reproducibility tracking. */
  readonly promptHash: string;
  readonly scenarioCount: number;
  readonly executedCount: number;
  readonly skippedCount: number;
  readonly errorCount: number;
  readonly criticalFailureCount: number;
  readonly judgeRequiredButSkippedCount: number;
  /**
   * Count of judgeRequired scenarios excluded from the overallScore aggregate
   * because no judge was available (no-judge mode). These scenarios are still
   * present in `results` but their scores do not contribute to overallScore
   * or overallCi95 to prevent contamination of the aggregate.
   */
  readonly judgeRequiredExcludedCount: number;
  readonly judgeFailCount: number;
  readonly judgeAttemptCount: number;
  /**
   * Number of scenarios that hit step-0 fallback: LLM was unavailable (rate-limit/timeout)
   * BEFORE the agent ran even one step. These are infra failures, not agent logic bugs,
   * but they drag down terminationCorrectness (25% partial credit) and the overall score.
   */
  readonly infraFallbackCount: number;
  /** Wall-clock breakdown for the whole CLI run (profiling). */
  readonly wallClock: BenchmarkWallClock;
  readonly results: readonly ScenarioResult[];
  readonly summary: {
    readonly overallScore: number;
    readonly overallCi95: WilsonCi;
    /** Bootstrap 95% CI — distribution-free, more robust for skewed geo-mean. */
    readonly overallBootstrapCi95: WilsonCi;
    readonly executionEfficiency: number;
    readonly toolAccuracy: number;
    readonly stepEfficiency: number;
    readonly answerQuality: number;
    readonly terminationCorrectness: number;
    readonly costEfficiency: number;
    /** RAGAS Faithfulness mean (grounding). null when no observations available. */
    readonly faithfulness: number | null;
    /** RAGAS Context Relevance mean (rule-based). null when no structured constraints. */
    readonly contextRelevance: number | null;
    /** RAGAS Context Recall mean (entity-ID overlap). null when no goldenEntityIds. */
    readonly contextRecall: number | null;
    /** Mean judge score across scenarios that produced a non-null judge value. */
    readonly judge: number | null;
    /** RFC-020 claim-level faithfulness (deterministic + LLM hybrid). null when no claim eval ran. */
    readonly claimFaithfulness: number | null;
    /** RFC-020 claim-level contradiction rate (claims contradicted by evidence). null when no claim eval. */
    readonly claimContradictionRate: number | null;
    /** RFC-020 critical-error rate on identity + structured claims. null when no claim eval. */
    readonly claimCriticalErrorRate: number | null;
    /** RFC-020 provenance coverage: fraction of claims with FieldAnchor. null when no claim eval. */
    readonly claimProvenanceCoverage: number | null;
    /** RFC-020 hard-fail count: scenarios where critical claim violation triggered hard fail. */
    readonly claimHardFailCount: number;
    /** Number of scenarios that received claim-level evaluation. */
    readonly claimEvaluatedCount: number;
    /** RFC-020 P1: Semantic Constraint Recall overall (weighted bucket mean). null when no scenarios have ground truth. */
    readonly scrOverall: number | null;
    /** RFC-020 P1: SCR hard bucket mean. */
    readonly scrHard: number | null;
    /** RFC-020 P1: SCR soft bucket mean. */
    readonly scrSoft: number | null;
    /** RFC-020 P1: SCR inferred bucket mean. */
    readonly scrInferred: number | null;
    /**
     * ADR-011 PR2 dual-emit: graph-aware SCR inferred mean, null-safe across
     * scenarios. Mean over scenarios with non-null `scrInferredGraph` — mixed
     * scenarios (some with graph, some without) are handled correctly because
     * the denominator only counts present values.
     */
    readonly scrInferredGraph: number | null;
    /** RFC-020 P2: Entity Linking Accuracy @1 mean. */
    readonly entityLinkingAccuracy: number | null;
    /** RFC-020 P3: Slot F1 strict mode mean. */
    readonly slotF1Strict: number | null;
    /** RFC-020 P3: Slot F1 relaxed mode mean. */
    readonly slotF1Relaxed: number | null;
    /** RFC-020 P4: Constraint Satisfaction Rate weighted overall mean. */
    readonly csrOverall: number | null;
    /** RFC-020 P4: CSR hard tier mean. */
    readonly csrHard: number | null;
    /** RFC-020 P4: CSR soft tier mean. */
    readonly csrSoft: number | null;
    /** RFC-020 P4: CSR inferred tier mean. */
    readonly csrInferred: number | null;
    /**
     * ADR-011 PR2 dual-emit: graph-aware CSR inferred mean, null-safe across
     * scenarios. Mean over scenarios with non-null `csrInferredGraph`.
     */
    readonly csrInferredGraph: number | null;
    /** Number of scenarios that received constraint extraction evaluation. */
    readonly constraintEvaluatedCount: number;
    readonly avgSteps: number;
    readonly latencyMs: LatencyStats;
    /** Latency SLA KPI assessment. */
    readonly latencySla: {
      /** p50 < 10s target. */
      readonly p50Pass: boolean;
      /** p95 < 20s target. */
      readonly p95Pass: boolean;
      /** Scenarios exceeding 30s (hard timeout). */
      readonly timeoutCount: number;
    };
    readonly tokens: {
      readonly inputMean: number;
      readonly outputMean: number;
      readonly totalP95: number;
    };
    readonly byTier: Record<string, { readonly count: number; readonly avgScore: number }>;
    /**
     * ADR-009 Phase 0: fraction of tool calls across the run that emitted a
     * typed evidence frame. Cutover gate is >= 0.99 on two consecutive
     * nightly runs before Phase 1 (ConstraintGraph) begins.
     *
     * null when the bench run had zero tool calls (rare edge — edge_case
     * scenarios that answer without invoking any tool).
     */
    readonly evidenceFrameCoverage: number | null;
    /** Absolute counts behind the coverage ratio, for audit. */
    readonly evidenceFrameCounts: {
      readonly framedToolCalls: number;
      readonly totalToolCalls: number;
    };
  };
}

// ─────────────────────────────────────────────────────────────────────
/**
 * Returns true when a scenario expectation has enough material for the LLM
 * judge to evaluate — either a hand-written rubric or at least one structured
 * field that `composeAutoRubric()` in judge.ts converts into rubric criteria.
 */
function hasJudgeMaterial(exp: ScenarioExpectation): boolean {
  if (exp.rubric !== undefined) return true;
  if (exp.priceBandKrw !== undefined) return true;
  if (exp.vintageRange !== undefined) return true;
  if (exp.drinkingWindowStatus !== undefined) return true;
  if (exp.requireHedging !== undefined) return true;
  if (exp.requiredRegister !== undefined) return true;
  if (exp.refusalExpected !== undefined) return true;
  if (exp.mustCiteFromToolResults !== undefined) return true;
  if (exp.maxConfidence !== undefined) return true;
  if (exp.factCheckClaims !== undefined && exp.factCheckClaims.length > 0) return true;
  return false;
}

// Main run logic
// ─────────────────────────────────────────────────────────────────────

async function runBenchmark(args: CliArgs): Promise<BenchmarkReport> {
  const runStartedAt = Date.now();
  const config = loadConfig();

  const modelId = args.model ?? config.openai.chatModel;
  const embeddingModel = config.openai.embeddingModel;
  // Extract hostname only — avoid logging full URL which may contain auth tokens in some configs.
  const apiBaseDomain = (() => {
    try { return new URL(config.openai.baseUrl).hostname; } catch { return config.openai.baseUrl; }
  })();
  const isAnthropicModel = modelId.startsWith('claude-');

  if (isAnthropicModel) {
    if (config.anthropic?.apiKey === undefined) {
      console.error('ERROR: ANTHROPIC_API_KEY required for claude-* models. Set in .env or environment.');
      process.exit(1);
    }
  } else {
    if (config.openai.apiKey === undefined) {
      console.error('ERROR: OPENAI_API_KEY required. Set in .env or environment.');
      process.exit(1);
    }
  }

  // Judge always uses OpenAI (cost-effective GPT-mini) regardless of agent model
  const judgeModelId = args.enableJudge ? (args.judgeModel ?? 'gpt-5.4-mini') : null;

  const chatLlm: ChatLlmPort = isAnthropicModel
    ? new AnthropicChatLlm({
        // apiKey is guaranteed non-undefined here — we process.exit(1) above if absent
        apiKey: config.anthropic.apiKey as string,
        defaultModel: modelId,
        httpTimeoutMs: config.openai.httpTimeoutMs,
      })
    : new OpenAiChatLlm({
        baseUrl: config.openai.baseUrl,
        // apiKey is guaranteed non-undefined here — we process.exit(1) above if absent
        apiKey: config.openai.apiKey as string,
        defaultModel: modelId,
        httpTimeoutMs: config.openai.httpTimeoutMs,
      });

  const judgeLlm: ChatLlmPort | null = judgeModelId !== null
    ? new OpenAiChatLlm({
        baseUrl: config.openai.baseUrl,
        apiKey: config.openai.apiKey ?? '',
        defaultModel: judgeModelId,
        httpTimeoutMs: config.openai.httpTimeoutMs,
      })
    : null;

  const effectiveConcurrency = args.concurrency;

  const scenarios = filterScenarios(AGENT_SCENARIOS, args);

  // Container wiring
  console.error('  [INIT] real container — wiring PG + Redis + production deps...');
  const built = await buildRealToolDeps();
  const toolDeps = built.toolDeps;
  const shutdown = built.shutdown;

  const orchestrator = new AgentOrchestrator(
    { chatLlm, toolDeps, querySanitizer: new QuerySanitizer() },
    {
      maxSteps: 8, // generous; per-scenario maxSteps is the real budget via overrides
      agentTimeoutMs: 120_000,
      // gpt-5.4-mini typically 5-15s per call + up to 2s+4s+8s=14s 429 backoff → 90s headroom.
      // 20s caused backoff sleeps to be aborted mid-retry, cutting off the 429 recovery chain.
      perStepTimeoutMs: 90_000,
      maxContextChars: 12_000,
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
    },
  );

  const initDoneAt = Date.now();

  let judgeFailCount = 0;
  let judgeAttemptCount = 0;
  let scenarioWallMsSum = 0;
  let scenarioWallSampleCount = 0;
  let completedCount = 0;
  // Infra failure tracking: step-0 fallback = LLM rate-limit / timeout before agent ran.
  // These pollute the overall score but are NOT agent logic failures.
  let infraFallbackCount = 0;
  const totalToRun = scenarios.filter((s) => s.skip === undefined).length;

  const results = await runWithConcurrency(
    scenarios,
    effectiveConcurrency,
    async (scenario) => {
      if (scenario.skip !== undefined) {
        console.error(`  [SKIP] #${scenario.id} ${scenario.description}: ${scenario.skip}`);
        return scoreScenario(scenario, null, undefined, undefined);
      }

      console.error(`  [RUN]  #${String(scenario.id).padEnd(3)} [${scenario.tier.slice(0, 16).padEnd(16)}] ${scenario.description.slice(0, 55)}`);
      const start = Date.now();

      try {
        // Pass scenario maxSteps as an override so the adaptive budget
        // classifier doesn't override the scenario's expected budget.
        // Without this, a scenario expecting maxSteps:2 would get
        // adaptive_budget=3 for specific_sku, deflating stepEfficiency.
        const result = await withRetry(
          () => orchestrator.execute(
            scenario.query,
            `bench-${scenario.id}`,
            { maxSteps: scenario.expectation.maxSteps },
          ),
          args.maxRetries,
          isTransient,
        );

        const toolsUsed = result.steps.flatMap((s) => {
          if (s.actionPairs !== undefined) {
            return s.actionPairs.map((p) => ({ tool: p.action.tool, input: JSON.stringify(p.action.input) }));
          }
          if (s.action !== undefined) {
            return [{ tool: s.action.tool, input: JSON.stringify(s.action.input) }];
          }
          return [];
        });

        // ADR-009 Phase 0: prefer typed evidence-frame observationSnapshots when
        // available — byte-equivalent to what the LLM saw, but backed by a
        // structured output the evaluator could alternatively read directly.
        // Fallback to legacy actionPairs/observation strings when frames absent.
        const observations = result.evidenceFrames !== undefined && result.evidenceFrames.length > 0
          ? result.evidenceFrames.map((f) => f.observationSnapshot).filter((o) => o.length > 0)
          : result.steps.flatMap((s) => {
              if (s.actionPairs !== undefined) return s.actionPairs.map((p) => p.observation).filter((o) => o.length > 0);
              if (s.observation !== undefined) return [s.observation];
              return [];
            });

        const evidenceFrameCount = result.evidenceFrames?.length ?? 0;

        const execution: ScenarioExecution = {
          answer: result.answer,
          stepCount: result.steps.length,
          toolCallCount: result.toolCallCount,
          toolsUsed,
          observations,
          terminationReason: mapTerminationReason(result.terminationReason),
          totalDurationMs: result.totalDurationMs,
          totalTokens: result.totalTokens,
          ...(result.evidenceFrames !== undefined ? { evidenceFrameCount } : {}),
        };

        // Map AgentStep[] → StepTrace[] for triage profiling in the result JSON.
        const stepTraces: StepTrace[] = result.steps.map((s) => {
          const trace: StepTrace = {
            index: s.index,
            thought: s.thought,
            durationMs: s.durationMs,
            tokenCount: s.tokenCount,
            ...(s.action !== undefined ? { action: { tool: s.action.tool, input: s.action.input as Record<string, unknown> } } : {}),
            ...(s.observation !== undefined ? { observation: s.observation } : {}),
            ...(s.actionPairs !== undefined ? { actions: s.actionPairs.map((p) => ({ tool: p.action.tool, input: p.action.input as Record<string, unknown> })) } : {}),
            ...(s.actionPairs !== undefined ? { observations: s.actionPairs.map((p) => p.observation) } : {}),
            ...(s.answer !== undefined ? { answer: s.answer } : {}),
          };
          return trace;
        });

        // LLM judges (optional). Run in parallel — no data dependency between
        // rubric judge, faithfulness judge, and claim-level evaluator (RFC-020).
        // ~3x speedup on judge-heavy runs.
        let judgeScore: number | undefined;
        let judgeReasoning: string | undefined;
        let faithScore: number | undefined;
        let claimDiagnostics: DiagnosticVector | undefined;
        if (judgeLlm !== null) {
          const judgePromises: Promise<void>[] = [];
          // Answer quality judge (rubric-based or structured fields via auto-rubric)
          if (hasJudgeMaterial(scenario.expectation)) {
            judgeAttemptCount++;
            judgePromises.push(
              judgeAnswerN(judgeLlm, scenario, result.answer, args.judgeSamples).then((r) => {
                if (r.score !== null) judgeScore = r.score;
                if (r.rationale.length > 0) judgeReasoning = r.rationale;
                if (r.failed) judgeFailCount++;
              }),
            );
          }
          // RAGAS Faithfulness judge (grounding in tool results).
          //
          // No-observation cases (observations.length === 0):
          //   1. mustNotCallTools set → agent CORRECTLY made no tool calls.
          //      Claims are knowledge-only; grounding N/A. Score 1.0.
          //   2. expectedBlocked=true → agent blocked before tools ran. Score 1.0.
          //   3. tools === undefined (knowledge-only scenario) → agent correctly
          //      answered from domain knowledge with no search. Score 1.0.
          //      Examples: "What is the difference between Bordeaux and Burgundy?"
          //   4. refusalExpected=true → agent correctly refused (no search needed). Score 1.0.
          //   5. terminationReason='blocked' (security gate fired) → policy-grounded
          //      refusal; no tool calls expected even if not explicitly flagged. Score 1.0.
          //   6. Infra failure (step-0 fallback, LLM rate-limit) → agent never ran.
          //      Leave faithScore undefined → scorer drops the dim from the geo-mean.
          //   7. All other cases → agent answered without tool calls when tools were
          //      expected. Claims are ungrounded. Score 0.0.
          //
          // Note: `result.steps.length` (not `result.stepCount`) — AgentResult
          // exposes `steps: readonly AgentStep[]`, not a `stepCount` numeric property.
          if (observations.length === 0) {
            const isExpectedNoTools =
              scenario.expectation.mustNotCallTools !== undefined ||
              scenario.expectation.expectedBlocked === true ||
              scenario.expectation.tools === undefined ||       // knowledge-only scenario
              scenario.expectation.refusalExpected === true;   // refusal is correct response
            const isBlockedTermination = execution.terminationReason === 'blocked';
            const isInfraFailure =
              result.terminationReason === 'fallback' && result.steps.length === 0;
            if (isExpectedNoTools || isBlockedTermination) {
              // Correct behavior: no tool calls were made as intended.
              faithScore = 1.0;
            } else if (!isInfraFailure) {
              // Agent answered without tool calls (and tools were expected).
              // All answer claims are ungrounded — zero faithfulness.
              faithScore = 0.0;
            }
            // isInfraFailure: leave faithScore undefined so scorer null-drops the dim
          } else if (observations.length > 0) {
            judgeAttemptCount++;
            judgePromises.push(
              judgeFaithfulness(judgeLlm, result.answer, observations, args.judgeSamples).then((r) => {
                if (r.score !== null) faithScore = r.score;
                if (r.failed) judgeFailCount++;
              }),
            );
          }

          // RFC-020 claim-level evaluator: deterministic + LLM hybrid faithfulness
          // measurement. Runs in parallel with the rubric/faithfulness judges.
          // Returns a DiagnosticVector with per-category claim breakdown,
          // contradictionRate, criticalErrorRate, and provenanceCoverage.
          // Skipped when there are no observations (no evidence to verify against).
          if (observations.length > 0 && execution.answer.trim().length > 0) {
            judgePromises.push(
              evaluateScenarioClaims(scenario, execution, judgeLlm)
                .then((dv) => { claimDiagnostics = dv; })
                .catch((err: unknown) => {
                  // Failure is non-fatal: log and leave claimDiagnostics undefined.
                  // Other dimensions still score; just no claim-level signal for this run.
                  console.error(`  [CLAIM-EVAL] #${scenario.id} failed: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`);
                }),
            );
          }
          await Promise.all(judgePromises);
        }

        let constraintMetrics: ConstraintExtractionMetricsInput | undefined;
        try {
          constraintMetrics = await computeConstraintMetricsForScenario(scenario, observations);
        } catch (err) {
          console.error(`  [CONSTRAINT-EVAL] #${scenario.id} failed: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`);
        }

        const scored = scoreScenario(scenario, execution, judgeScore, faithScore, undefined, stepTraces, judgeReasoning, claimDiagnostics, constraintMetrics);
        const elapsed = Date.now() - start;
        scenarioWallMsSum += elapsed;
        scenarioWallSampleCount++;
        const sc = scored.scores;
        const judgePart = judgeScore !== undefined ? ` judge=${judgeScore.toFixed(2)}` : '';
        const faithPart = faithScore !== undefined ? ` faith=${faithScore.toFixed(2)}` : '';
        const scrPart = constraintMetrics?.semanticConstraintRecall !== null && constraintMetrics?.semanticConstraintRecall !== undefined
          ? ` scr=${constraintMetrics.semanticConstraintRecall.toFixed(2)}`
          : '';
        const elaPart = constraintMetrics?.entityLinkingAccuracy !== null && constraintMetrics?.entityLinkingAccuracy !== undefined
          ? ` ela=${constraintMetrics.entityLinkingAccuracy.toFixed(2)}`
          : '';
        const claimPart = claimDiagnostics !== undefined
          ? ` claims=${claimDiagnostics.claims.length}/${claimDiagnostics.faithfulnessScore.toFixed(2)}${claimDiagnostics.hardFail ? '⚠' : ''}`
          : '';
        const dimParts = [
          `tool=${(sc.toolAccuracy * 100).toFixed(0)}%`,
          `ans=${(sc.answerQuality * 100).toFixed(0)}%`,
          `term=${(sc.terminationCorrectness * 100).toFixed(0)}%`,
        ].join(' ');
        completedCount++;
        // Detect infra failure: step-0 fallback = LLM unavailable (rate-limit/timeout).
        const isInfraFallback = execution.terminationReason === 'fallback' && execution.stepCount === 0;
        if (isInfraFallback) infraFallbackCount++;
        const infraTag = isInfraFallback ? ' ⚡INFRA-FALLBACK(LLM rate-limit/timeout — not agent bug)' : '';
        console.error(
          `  [DONE] #${String(scenario.id).padEnd(3)} `
          + `[${scenario.tier.slice(0, 16).padEnd(16)}] `
          + `score=${(sc.overall * 100).toFixed(1).padStart(5)}% `
          + `tools=${execution.toolCallCount} steps=${scored.stepCount} `
          + `${dimParts}${judgePart}${faithPart}${scrPart}${elaPart}${claimPart} `
          + `${(elapsed / 1000).toFixed(1)}s `
          + `[${completedCount}/${totalToRun}]${infraTag}`,
        );
        return scored;
      } catch (err) {
        const normalizedErr = normalizeRunnerError(err);
        const elapsed = Date.now() - start;
        scenarioWallMsSum += elapsed;
        scenarioWallSampleCount++;
        completedCount++;
        console.error(
          `  [FAIL] #${String(scenario.id).padEnd(3)} [${scenario.tier.slice(0, 16).padEnd(16)}] `
          + `${normalizedErr.message.slice(0, 80)} `
          + `${(elapsed / 1000).toFixed(1)}s `
          + `[${completedCount}/${totalToRun}]`,
        );
        return scoreScenario(
          scenario,
          null,
          undefined,
          undefined,
          normalizedErr.message,
        );
      }
    },
  );

  const scenariosDoneAt = Date.now();

  const expectedWallSamples = scenarios.reduce(
    (n, s) => n + (s.skip === undefined ? 1 : 0),
    0,
  );
  if (scenarioWallSampleCount !== expectedWallSamples) {
    console.error(
      `  [WARN] wallClock scenarioWallSampleCount=${scenarioWallSampleCount} `
      + `!== expected non-skipped=${expectedWallSamples} (profiling bug?)`,
    );
  }

  // Shutdown with timeout — pool.end() can hang indefinitely when PG
  // connections don't release, and redisClient.quit() can hang when the
  // server is unreachable. The benchmark CLI must never stall after results
  // are collected.
  const SHUTDOWN_TIMEOUT_MS = 10_000;
  await Promise.race([
    shutdown(),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        console.error('  [WARN] shutdown timed out after 10s — forcing exit');
        resolve();
      }, SHUTDOWN_TIMEOUT_MS),
    ),
  ]);

  const shutdownDoneAt = Date.now();

  const initMs = initDoneAt - runStartedAt;
  const scenariosPhaseMs = scenariosDoneAt - initDoneAt;
  const shutdownMs = shutdownDoneAt - scenariosDoneAt;
  const wallClock: BenchmarkWallClock = {
    initMs,
    scenariosPhaseMs,
    shutdownMs,
    totalMs: shutdownDoneAt - runStartedAt,
    meanScenarioWallMs:
      scenarioWallSampleCount > 0 ? scenarioWallMsSum / scenarioWallSampleCount : 0,
    sumScenarioWallMs: scenarioWallMsSum,
    scenarioWallSampleCount,
    concurrency: effectiveConcurrency,
  };

  const wallClockPhaseSum = initMs + scenariosPhaseMs + shutdownMs;
  if (wallClockPhaseSum !== wallClock.totalMs) {
    console.error(
      `  [WARN] wallClock phase sum (${wallClockPhaseSum}ms) !== totalMs (${wallClock.totalMs}ms) — clock skew?`,
    );
  }

  return buildReport(results, scenarios, modelId, judgeModelId, embeddingModel, apiBaseDomain, args, judgeFailCount, judgeAttemptCount, wallClock, infraFallbackCount);
}

function filterScenarios(
  all: readonly AgentBenchmarkScenario[],
  args: CliArgs,
): readonly AgentBenchmarkScenario[] {
  let filtered = all;
  if (args.tierFilter) filtered = filtered.filter((s) => s.tier === args.tierFilter);
  if (args.idFilter) filtered = filtered.filter((s) => args.idFilter!.includes(s.id));
  if (args.profile === 'retrieval') {
    filtered = filtered.filter((s) => s.expectation.expectedEntityIds !== undefined && s.expectation.expectedEntityIds.length > 0);
  }
  return filtered;
}

function buildReport(
  results: readonly ScenarioResult[],
  scenarios: readonly AgentBenchmarkScenario[],
  model: string,
  judgeModel: string | null,
  embeddingModel: string,
  apiBaseDomain: string,
  args: CliArgs,
  judgeFailCount: number,
  judgeAttemptCount: number,
  wallClock: BenchmarkWallClock,
  infraFallbackCount: number = 0,
): BenchmarkReport {
  const executed = results.filter((r) => !r.skipped && r.error === undefined);

  // When judge is not available, judgeRequired scenarios cannot be reliably
  // scored — their overall score is unreliable (rubric criteria go unchecked).
  // Exclude them from the overallScore / overallCi95 aggregate to prevent
  // contamination. They still appear in `results` for visibility.
  const judgeAvailable = judgeModel !== null;
  const judgeRequiredExcluded = judgeAvailable
    ? []
    : executed.filter((r) => r.judgeRequiredButSkipped);
  const judgeRequiredExcludedCount = judgeRequiredExcluded.length;
  // executedForAggregate: scenarios that contribute to the overall score.
  const executedForAggregate = judgeAvailable
    ? executed
    : executed.filter((r) => !r.judgeRequiredButSkipped);

  // Numeric dimensions only — judge can be null when disabled, so handled separately.
  type NumericDim = 'executionEfficiency' | 'toolAccuracy' | 'stepEfficiency' | 'answerQuality' | 'terminationCorrectness' | 'costEfficiency' | 'overall';
  const avgScore = (field: NumericDim): number => {
    if (executedForAggregate.length === 0) return 0;
    return executedForAggregate.reduce((sum, r) => sum + r.scores[field], 0) / executedForAggregate.length;
  };

  // Judge mean: only over scenarios that produced a non-null judge score.
  const judgeScores = executed
    .map((r) => r.scores.judge)
    .filter((s): s is number => s !== null);
  const judgeMean = judgeScores.length > 0
    ? judgeScores.reduce((sum, s) => sum + s, 0) / judgeScores.length
    : null;

  // RAGAS dim means — only over scenarios that produced non-null values.
  // Use executedForAggregate (consistent with avgScore) so judgeRequired scenarios
  // excluded in --no-judge mode do not skew the RAGAS aggregate differently from overall.
  const faithScores = executedForAggregate.map((r) => r.scores.faithfulness).filter((s): s is number => s !== null);
  const faithMean = faithScores.length > 0 ? faithScores.reduce((s, v) => s + v, 0) / faithScores.length : null;

  const ctxRelScores = executedForAggregate.map((r) => r.scores.contextRelevance).filter((s): s is number => s !== null);
  const ctxRelMean = ctxRelScores.length > 0 ? ctxRelScores.reduce((s, v) => s + v, 0) / ctxRelScores.length : null;

  const ctxRecallScores = executedForAggregate.map((r) => r.scores.contextRecall).filter((s): s is number => s !== null);
  const ctxRecallMean = ctxRecallScores.length > 0 ? ctxRecallScores.reduce((s, v) => s + v, 0) / ctxRecallScores.length : null;

  // RFC-020 claim-level diagnostic aggregation across executed scenarios.
  // Reports faithfulness (claim-grounded), contradiction rate, critical-error rate,
  // and hard-fail count — supplements the LLM judge faithfulness with structured signal.
  const claimEvaluated = executedForAggregate.filter((r) => r.claimDiagnostics !== undefined);
  const claimFaithfulnessMean = claimEvaluated.length > 0
    ? claimEvaluated.reduce((s, r) => s + (r.claimDiagnostics?.faithfulnessScore ?? 0), 0) / claimEvaluated.length
    : null;
  const claimContradictionMean = claimEvaluated.length > 0
    ? claimEvaluated.reduce((s, r) => s + (r.claimDiagnostics?.contradictionRate ?? 0), 0) / claimEvaluated.length
    : null;
  const claimCriticalErrorMean = claimEvaluated.length > 0
    ? claimEvaluated.reduce((s, r) => s + (r.claimDiagnostics?.criticalErrorRate ?? 0), 0) / claimEvaluated.length
    : null;
  const claimProvenanceMean = claimEvaluated.length > 0
    ? claimEvaluated.reduce((s, r) => s + (r.claimDiagnostics?.provenanceCoverage ?? 0), 0) / claimEvaluated.length
    : null;
  const claimHardFailCount = claimEvaluated.filter((r) => r.claimDiagnostics?.hardFail === true).length;

  // RFC-020: Constraint extraction metric aggregation across executed scenarios.
  // Each metric is averaged only over scenarios that produced non-null values
  // (scenarios without expectedConstraints/expectedEntities are excluded).
  const nullableMean = (scores: readonly (number | null)[]): number | null => {
    const present = scores.filter((s): s is number => s !== null);
    return present.length > 0 ? present.reduce((sum, v) => sum + v, 0) / present.length : null;
  };
  const scrOverallScores = executedForAggregate.map((r) => r.scores.semanticConstraintRecall);
  const scrHardScores = executedForAggregate.map((r) => r.scores.scrHard);
  const scrSoftScores = executedForAggregate.map((r) => r.scores.scrSoft);
  const scrInferredScores = executedForAggregate.map((r) => r.scores.scrInferred);
  const scrInferredGraphScores = executedForAggregate.map((r) => r.scores.scrInferredGraph);
  const elaScores = executedForAggregate.map((r) => r.scores.entityLinkingAccuracy);
  const slotF1StrictScores = executedForAggregate.map((r) => r.scores.slotF1Strict);
  const slotF1RelaxedScores = executedForAggregate.map((r) => r.scores.slotF1Relaxed);
  const csrOverallScores = executedForAggregate.map((r) => r.scores.csrOverall);
  const csrHardScores = executedForAggregate.map((r) => r.scores.csrHard);
  const csrSoftScores = executedForAggregate.map((r) => r.scores.csrSoft);
  const csrInferredScores = executedForAggregate.map((r) => r.scores.csrInferred);
  const csrInferredGraphScores = executedForAggregate.map((r) => r.scores.csrInferredGraph);
  const constraintEvaluatedCount = executedForAggregate.filter(
    (r) => r.scores.semanticConstraintRecall !== null || r.scores.entityLinkingAccuracy !== null,
  ).length;

  const judgeRequiredButSkippedCount = executed.filter((r) => r.judgeRequiredButSkipped).length;
  // judgeRequiredExcludedCount already computed above (judgeRequiredExcluded.length).

  // byTier uses executedForAggregate so per-tier scores are consistent with
  // the overall aggregate (judgeRequired scenarios excluded in no-judge mode).
  const byTier: Record<string, { count: number; avgScore: number }> = {};
  for (const r of executedForAggregate) {
    const entry = byTier[r.tier] ?? { count: 0, avgScore: 0 };
    entry.count++;
    entry.avgScore += r.scores.overall;
    byTier[r.tier] = entry;
  }
  for (const tier of Object.keys(byTier)) {
    byTier[tier]!.avgScore /= byTier[tier]!.count;
  }

  if (judgeRequiredExcludedCount > 0) {
    console.error(
      `  [WARN] ${judgeRequiredExcludedCount} judgeRequired scenario(s) excluded from overallScore `
      + `(no judge available — run without --no-judge for accurate aggregate)`,
    );
  }
  if (executedForAggregate.length === 0 && executed.length > 0) {
    console.error(
      '  [WARN] All executed scenarios are judgeRequired but no judge is available. '
      + 'overallScore=0 is NOT meaningful — run with a judge for a valid aggregate.',
    );
  }

  const durations = executed.map((r) => r.totalDurationMs ?? 0);
  const totalTokens = executed.map((r) => (r.totalTokens?.input ?? 0) + (r.totalTokens?.output ?? 0));
  const sortedTokens = [...totalTokens].sort((a, b) => a - b);

  const overallScore = avgScore('overall');
  const criticalFailureCount = executed.filter((r) => r.scores.criticalFailure).length;
  // overallCi95 uses only the aggregate-eligible scenarios (judgeRequired excluded
  // in no-judge mode) so the CI reflects the same population as overallScore.
  const overallScores = executedForAggregate.map((r) => r.scores.overall);
  const overallCi95 = tCi95(overallScores);
  // Bootstrap CI — distribution-free, more robust for skewed geo-mean scores.
  const overallBootstrapCi95 = bootstrapCi95(overallScores);

  return {
    baselineVersion: BASELINE_VERSION_CURRENT,
    timestamp: new Date().toISOString(),
    model,
    judgeModel,
    judgeSamples: args.judgeSamples,
    embeddingModel,
    apiBaseDomain,
    container: args.container,
    seed: args.seed ?? null,
    nodeVersion: process.version,
    platform: process.platform,
    promptHash: createHash('sha256').update(buildSystemMessage().content).digest('hex').slice(0, 16),
    scenarioCount: scenarios.length,
    executedCount: executed.length,
    skippedCount: results.filter((r) => r.skipped).length,
    errorCount: results.filter((r) => r.error !== undefined).length,
    criticalFailureCount,
    judgeRequiredButSkippedCount,
    judgeRequiredExcludedCount,
    judgeFailCount,
    judgeAttemptCount,
    infraFallbackCount,
    wallClock,
    results,
    summary: {
      overallScore,
      overallCi95,
      overallBootstrapCi95,
      executionEfficiency: avgScore('executionEfficiency'),
      toolAccuracy: avgScore('toolAccuracy'),
      stepEfficiency: avgScore('stepEfficiency'),
      answerQuality: avgScore('answerQuality'),
      terminationCorrectness: avgScore('terminationCorrectness'),
      costEfficiency: avgScore('costEfficiency'),
      faithfulness: faithMean,
      contextRelevance: ctxRelMean,
      contextRecall: ctxRecallMean,
      judge: judgeMean,
      claimFaithfulness: claimFaithfulnessMean,
      claimContradictionRate: claimContradictionMean,
      claimCriticalErrorRate: claimCriticalErrorMean,
      claimProvenanceCoverage: claimProvenanceMean,
      claimHardFailCount,
      claimEvaluatedCount: claimEvaluated.length,
      scrOverall: nullableMean(scrOverallScores),
      scrHard: nullableMean(scrHardScores),
      scrSoft: nullableMean(scrSoftScores),
      scrInferred: nullableMean(scrInferredScores),
      scrInferredGraph: nullableMean(scrInferredGraphScores),
      entityLinkingAccuracy: nullableMean(elaScores),
      slotF1Strict: nullableMean(slotF1StrictScores),
      slotF1Relaxed: nullableMean(slotF1RelaxedScores),
      csrOverall: nullableMean(csrOverallScores),
      csrHard: nullableMean(csrHardScores),
      csrSoft: nullableMean(csrSoftScores),
      csrInferred: nullableMean(csrInferredScores),
      csrInferredGraph: nullableMean(csrInferredGraphScores),
      constraintEvaluatedCount,
      avgSteps:
        executed.length > 0
          ? executed.reduce((s, r) => s + (r.stepCount ?? 0), 0) / executed.length
          : 0,
      latencyMs: summariseLatency(durations),
      latencySla: {
        p50Pass: summariseLatency(durations).p50 < LATENCY_SLA_P50_MS,
        p95Pass: summariseLatency(durations).p95 < LATENCY_SLA_P95_MS,
        timeoutCount: durations.filter((d) => d > LATENCY_SLA_TIMEOUT_MS).length,
      },
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
      // ADR-009 Phase 0 cutover metric: framed / total tool calls.
      // Scenarios that never invoked a tool (terminationReason='answer',
      // stepCount=1) contribute nothing to either numerator or denominator.
      ...(() => {
        const framedToolCalls = executed.reduce(
          (n, r) => n + (r.evidenceFrameCount ?? 0),
          0,
        );
        const totalToolCalls = executed.reduce(
          (n, r) => n + (r.toolCallCount ?? 0),
          0,
        );
        return {
          evidenceFrameCoverage: totalToolCalls > 0 ? framedToolCalls / totalToolCalls : null,
          evidenceFrameCounts: { framedToolCalls, totalToolCalls },
        };
      })(),
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
    // Cast to unknown first (CLAUDE.md rule 12): JSON.parse result is unknown until validated.
    // We only access the specific fields we need (.summary.overallScore) with safe navigation.
    const baselineUnknown = JSON.parse(raw) as unknown;
    if (
      typeof baselineUnknown !== 'object' || baselineUnknown === null
      || !('summary' in baselineUnknown)
      || typeof (baselineUnknown as Record<string, unknown>)['summary'] !== 'object'
    ) {
      // v4 fix: invalid baseline → fail (regressed: true), not silent pass.
      // The previous behavior (regressed: false) meant a corrupted or missing
      // baseline file always reported "PASSED" — masking real regressions.
      console.error(`  [BASELINE] ⚠ Baseline file has unexpected shape — treating as regression (fail-safe)`);
      return { regressed: true, delta: 0 };
    }

    // ADR-011 PR2 dual-emit: baseline version compatibility.
    // - Missing `baselineVersion` → treat as legacy "v3" (one-release compat
    //   window). Graph-aware fields stay null; overallScore comparison unchanged.
    // - Known version (`v3`, `v4`) → read normally.
    // - Unknown version → fail-safe (regressed: true). Silent acceptance of an
    //   unknown shape could mask a schema migration bug downstream.
    const baselineRecord = baselineUnknown as Record<string, unknown>;
    const rawVersion = baselineRecord['baselineVersion'];
    const effectiveVersion: string = typeof rawVersion === 'string' ? rawVersion : 'v3';
    if (!BASELINE_VERSION_COMPATIBLE.has(effectiveVersion)) {
      console.error(
        `  [BASELINE] ⚠ Unknown baselineVersion="${effectiveVersion}" — compatible: `
        + `${[...BASELINE_VERSION_COMPATIBLE].join(', ')}. Treating as regression (fail-safe).`,
      );
      return { regressed: true, delta: 0 };
    }
    const baseline = baselineUnknown as BenchmarkReport;

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
    // v4 fix: baseline read failure → fail-safe (regressed: true).
    // Missing or unreadable baseline should NOT silently pass the benchmark.
    console.error(
      `  [BASELINE] ⚠ read failed: ${err instanceof Error ? err.message : String(err)} — treating as regression (fail-safe)`,
    );
    return { regressed: true, delta: 0 };
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
  if (args.profile !== undefined) {
    const profileLabel = args.profile === 'retrieval'
      ? 'retrieval (agent mode, golden-ID scenarios only)'
      : args.profile;
    console.error(`  Profile:      ${profileLabel}`);
  }
  console.error('  ────── run profile ─────');
  console.error(`  Model:        ${report.model}`);
  console.error(`  Embedding:    ${report.embeddingModel}`);
  console.error(`  Judge:        ${report.judgeModel ?? 'disabled'}${report.judgeSamples > 1 ? ` (N=${report.judgeSamples} median)` : ''}`);
  console.error(`  API:          ${report.apiBaseDomain}`);
  console.error(`  Container:    ${report.container}`);
  console.error(`  Node:         ${report.nodeVersion}  (${report.platform})`);
  console.error(`  Seed:         ${report.seed ?? 'none (non-deterministic)'}`);
  console.error(`  Prompt hash:  ${report.promptHash}`);
  console.error(`  Scenarios:    ${report.scenarioCount} (${report.executedCount} executed, `
    + `${report.skippedCount} skipped, ${report.errorCount} errored)`);
  const wc = report.wallClock;
  console.error('  ────── wall clock ───────');
  console.error(`  Total:        ${formatBenchmarkDurationMs(wc.totalMs)}`);
  console.error(
    `  Phases:       init ${formatBenchmarkDurationMs(wc.initMs)} · scenarios `
    + `${formatBenchmarkDurationMs(wc.scenariosPhaseMs)} · shutdown `
    + formatBenchmarkDurationMs(wc.shutdownMs),
  );
  console.error(
    `  Per scenario: mean ${formatBenchmarkDurationMs(wc.meanScenarioWallMs)} wall · sum `
    + `${formatBenchmarkDurationMs(wc.sumScenarioWallMs)} (n=${wc.scenarioWallSampleCount}, `
    + `concurrency=${wc.concurrency})`,
  );
  if (report.criticalFailureCount > 0) {
    console.error(`  ⚠ Critical:   ${report.criticalFailureCount} scenario(s) had a critical failure (overall=0)`);
  }
  if (report.infraFallbackCount > 0) {
    const pct = report.executedCount > 0 ? (report.infraFallbackCount / report.executedCount * 100).toFixed(0) : '0';
    console.error(
      `  ⚡ Infra fail: ${report.infraFallbackCount} scenario(s) (${pct}%) hit step-0 fallback`
      + ` — LLM rate-limit/timeout BEFORE agent ran. Score penalized by term=25% but NOT an agent bug.`
      + ` Lower concurrency (--concurrency ${Math.max(1, (report.wallClock.concurrency ?? 7) - 2)}) or retry to get clean signal.`,
    );
  }
  if (report.judgeFailCount > 0) {
    // Warn loudly when >10% of actual judge attempts failed.
    const judgeCallsTotal = report.judgeAttemptCount;
    const failRate = judgeCallsTotal > 0 ? report.judgeFailCount / judgeCallsTotal : 0;
    const failSymbol = failRate >= 0.1 ? '⚠ ' : '  ';
    console.error(`  ${failSymbol}Judge fails: ${report.judgeFailCount}${failRate >= 0.1 ? ` (${(failRate * 100).toFixed(0)}% — scores may be unreliable, re-run or check API quota)` : ''}`);
  }
  if (report.judgeRequiredButSkippedCount > 0) {
    console.error(`  ⚠️  ${report.judgeRequiredButSkippedCount} scenario(s) require judge for reliable scoring (run without --no-judge for accurate results)`);
  }
  if (report.judgeRequiredExcludedCount > 0) {
    console.error(
      `  ⚠️  ${report.judgeRequiredExcludedCount} judgeRequired scenario(s) EXCLUDED from overall score `
      + `(no judge — overallScore reflects ${report.executedCount - report.judgeRequiredExcludedCount} scenarios only)`,
    );
  }
  const bci = s.overallBootstrapCi95;
  console.error(
    `  Overall:      ${(s.overallScore * 100).toFixed(1)}% (geo-mean) `
    + `[bootstrap 95% CI ${(bci.lower * 100).toFixed(1)}–${(bci.upper * 100).toFixed(1)}%, n=${bci.n}]`,
  );
  console.error(
    `                (t-CI: ${(s.overallCi95.lower * 100).toFixed(1)}–${(s.overallCi95.upper * 100).toFixed(1)}%)`,
  );
  console.error('  ────── dimensions ──────');
  console.error(`  Exec Eff:     ${(s.executionEfficiency * 100).toFixed(1)}%   (tool ${(s.toolAccuracy * 100).toFixed(0)}% × step ${(s.stepEfficiency * 100).toFixed(0)}%)`);
  console.error(`  Answer Qual:  ${(s.answerQuality * 100).toFixed(1)}%`);
  console.error(`  Faithful:     ${s.faithfulness !== null ? `${(s.faithfulness * 100).toFixed(1)}%` : 'n/a'}`);
  console.error(`  Ctx Relev:    ${s.contextRelevance !== null ? `${(s.contextRelevance * 100).toFixed(1)}%` : 'n/a'}`);
  console.error(`  Ctx Recall:   ${s.contextRecall !== null ? `${(s.contextRecall * 100).toFixed(1)}%` : 'n/a'}`);
  console.error(`  Term Corr:    ${(s.terminationCorrectness * 100).toFixed(1)}%`);
  console.error(`  Cost Eff:     ${(s.costEfficiency * 100).toFixed(1)}%`);
  console.error(`  Judge:        ${s.judge !== null ? `${(s.judge * 100).toFixed(1)}%` : 'disabled'}`);
  // RFC-020 claim-level diagnostic block
  if (s.claimEvaluatedCount > 0) {
    console.error('  ────── claims (RFC-020) ──');
    console.error(`  Faithful (claim): ${(s.claimFaithfulness! * 100).toFixed(1)}%   (${s.claimEvaluatedCount} scenarios evaluated)`);
    console.error(`  Contradiction:    ${(s.claimContradictionRate! * 100).toFixed(1)}%`);
    console.error(`  Critical errors:  ${(s.claimCriticalErrorRate! * 100).toFixed(1)}%`);
    console.error(`  Provenance cov:   ${(s.claimProvenanceCoverage! * 100).toFixed(1)}%`);
    if (s.claimHardFailCount > 0) {
      console.error(`  ⚠ Hard fails:     ${s.claimHardFailCount} scenario(s) had critical claim violations`);
    }
  }
  // RFC-020 constraint extraction metric block
  if (s.constraintEvaluatedCount > 0) {
    const fmt = (v: number | null): string => v !== null ? (v * 100).toFixed(1).padStart(5) + '%' : '  n/a';
    console.error('  ────── constraint extraction (RFC-020) ──────');
    console.error(`  SCR overall:  ${fmt(s.scrOverall)}   SCR hard: ${fmt(s.scrHard)}   SCR soft: ${fmt(s.scrSoft)}   SCR inferred: ${fmt(s.scrInferred)}`);
    console.error(`  ELA@1:        ${fmt(s.entityLinkingAccuracy)}`);
    console.error(`  Slot F1 strict: ${fmt(s.slotF1Strict)}   relaxed: ${fmt(s.slotF1Relaxed)}`);
    console.error(`  CSR overall:  ${fmt(s.csrOverall)}   CSR hard: ${fmt(s.csrHard)}   CSR soft: ${fmt(s.csrSoft)}   CSR inferred: ${fmt(s.csrInferred)}`);
    // ADR-011 PR2 dual-emit: graph-aware siblings. Columns sit next to the flat
    // inferred values so divergence (XOR / OR / subquery-bundled scenarios) is
    // immediately visible. Flat value = legacy bucket-set equality; graph value
    // = AND/OR/XOR-aware root satisfaction.
    console.error(`  SCR inferred (graph): ${fmt(s.scrInferredGraph)}   CSR inferred (graph): ${fmt(s.csrInferredGraph)}`);
    console.error(`  Evaluated:    ${s.constraintEvaluatedCount} scenario(s)`);
  }
  console.error('  ────── execution ───────');
  console.error(`  Avg Steps:    ${s.avgSteps.toFixed(1)}`);
  const p50Tag = s.latencySla.p50Pass ? 'PASS' : 'FAIL';
  const p95Tag = s.latencySla.p95Pass ? 'PASS' : 'FAIL';
  console.error(`  Latency p50:  ${s.latencyMs.p50.toFixed(0)}ms  [SLA <${LATENCY_SLA_P50_MS / 1000}s: ${p50Tag}]`);
  console.error(`  Latency p95:  ${s.latencyMs.p95.toFixed(0)}ms  [SLA <${LATENCY_SLA_P95_MS / 1000}s: ${p95Tag}]`);
  console.error(`  Latency p99:  ${s.latencyMs.p99.toFixed(0)}ms`);
  console.error(`  Latency max:  ${s.latencyMs.max.toFixed(0)}ms`);
  if (s.latencySla.timeoutCount > 0) {
    console.error(`  Timeouts:     ${s.latencySla.timeoutCount} scenario(s) exceeded ${LATENCY_SLA_TIMEOUT_MS / 1000}s`);
  }
  console.error(`  Tokens in:    ${s.tokens.inputMean.toFixed(0)} mean`);
  console.error(`  Tokens out:   ${s.tokens.outputMean.toFixed(0)} mean`);
  console.error(`  Tokens p95:   ${s.tokens.totalP95.toFixed(0)} total`);
  console.error('  ────── by tier ─────────');
  const sortedTiers = Object.entries(s.byTier).sort((a, b) => b[1].avgScore - a[1].avgScore);
  for (const [tier, data] of sortedTiers) {
    console.error(`  ${tier.padEnd(22)} ${(data.avgScore * 100).toFixed(1)}% (${data.count})`);
  }
  // ────── worst N scenarios (triage-ready) ──────
  const executedResults = report.results.filter((r) => !r.skipped && r.error === undefined);
  const WORST_N = 10;
  const worstN = [...executedResults]
    .sort((a, b) => a.scores.overall - b.scores.overall)
    .slice(0, WORST_N);
  if (worstN.length > 0) {
    console.error(`  ────── worst ${WORST_N} (triage) ──────`);
    for (const w of worstN) {
      // ── root-cause classification ──────────────────────────────────────────
      const isInfraFallback = w.terminationReason === 'fallback' && (w.stepCount ?? 1) === 0;
      const criticals = (w.diagnostics ?? []).filter((d) => d.severity === 'critical');
      const warns = (w.diagnostics ?? []).filter((d) => d.severity === 'warn');

      // Primary root-cause label — pick the most informative one
      let rootCause: string;
      if (isInfraFallback) {
        rootCause = '⚡ INFRA-FALLBACK — LLM rate-limit/timeout, agent never ran';
      } else if (criticals.length > 0) {
        rootCause = `🔴 CRITICAL: ${criticals.map((d) => d.code).join(', ')}`;
      } else if (w.scores.judge !== null && w.scores.judge < 0.25) {
        rootCause = '🟠 JUDGE-FAIL — answer structurally wrong per rubric';
      } else if ((w.scores.toolAccuracy ?? 1) < 0.5) {
        rootCause = '🟡 WRONG-TOOL — tool selection or tool call missing';
      } else if ((w.scores.answerQuality ?? 1) < 0.5) {
        rootCause = '🟡 ANSWER-INCOMPLETE — partial constraint coverage';
      } else if (warns.length > 0) {
        rootCause = `⚠ ${warns[0].code}`;
      } else {
        rootCause = '— (no critical diag)';
      }

      // ── score breakdown ────────────────────────────────────────────────────
      const sc = w.scores;
      const scoreParts = [
        `tool=${(sc.toolAccuracy * 100).toFixed(0)}%`,
        `ans=${(sc.answerQuality * 100).toFixed(0)}%`,
        `term=${(sc.terminationCorrectness * 100).toFixed(0)}%`,
        sc.faithfulness !== null ? `faith=${(sc.faithfulness * 100).toFixed(0)}%` : null,
        sc.judge !== null ? `judge=${sc.judge.toFixed(2)}` : null,
      ].filter(Boolean).join(' ');

      // ── execution context ──────────────────────────────────────────────────
      const steps = w.stepCount ?? 0;
      const tools = (w.toolsUsed ?? []).join(',') || 'none';
      const termReason = w.terminationReason ?? '?';
      const durationS = w.totalDurationMs !== undefined ? `${(w.totalDurationMs / 1000).toFixed(1)}s` : '';

      // ── query (truncated) ──────────────────────────────────────────────────
      const querySnippet = (w.query ?? '').slice(0, 70);

      // ── answer snippet (only when judge failed or answer incomplete) ───────
      const showAnswer = (sc.judge !== null && sc.judge < 0.5) || sc.answerQuality < 0.7;
      const answerSnippet = showAnswer && w.answer
        ? `\n      answer: "${w.answer.slice(0, 120).replace(/\n/g, ' ')}…"`
        : '';

      // ── judge rationale ────────────────────────────────────────────────────
      const judgeRationale = w.judgeReasoning
        ? `\n      judge:  "${w.judgeReasoning.slice(0, 150).replace(/\n/g, ' ')}…"`
        : '';

      // ── critical diagnostic details ────────────────────────────────────────
      const diagDetails = criticals.slice(0, 3).map((d) => {
        const obs = d.observed !== undefined ? ` observed=${d.observed}` : '';
        const exp = d.expected !== undefined ? ` expected=${d.expected}` : '';
        return `\n      diag:   [${d.dim}] ${d.message}${obs}${exp}`;
      }).join('');

      // ── step trace (first tool call input when tool is wrong) ──────────────
      const stepTrace = !isInfraFallback && (w.steps ?? []).length > 0
        ? (() => {
            const firstToolStep = (w.steps ?? []).find((s) => s.action !== undefined || (s.actions !== undefined && s.actions.length > 0));
            if (firstToolStep?.action !== undefined) {
              const inp = JSON.stringify(firstToolStep.action.input).slice(0, 100);
              return `\n      step1:  ${firstToolStep.action.tool}(${inp})`;
            }
            if (firstToolStep?.actions !== undefined && firstToolStep.actions.length > 0) {
              const acts = firstToolStep.actions.map((a) => a.tool).join('+');
              return `\n      step1:  [batch] ${acts}`;
            }
            return '';
          })()
        : '';

      console.error(
        `\n  #${String(w.id).padEnd(4)} ${(sc.overall * 100).toFixed(1)}%  [${w.tier}]`
        + `\n      query:  "${querySnippet}"`
        + `\n      cause:  ${rootCause}`
        + `\n      scores: ${scoreParts}  steps=${steps} tools=${tools} term=${termReason} ${durationS}`
        + answerSnippet
        + judgeRationale
        + diagDetails
        + stepTrace,
      );
    }
    console.error('');
  }

  // ────── critical failures ──────
  if (report.criticalFailureCount > 0) {
    const criticals = executedResults.filter((r) => r.scores.criticalFailure);
    console.error('  ────── critical fails ──');
    for (const c of criticals) {
      const diag = c.diagnosticStrings?.find((d) => d.includes('critical')) ?? c.diagnosticStrings?.[0] ?? '';
      console.error(`  #${String(c.id).padEnd(4)} ${c.tier.padEnd(20)} ${diag.slice(0, 60)}`);
    }
  }
  console.error('══════════════════════════════════════');

  // ── RFC-020: Benchmark Insights (deterministic rules + LLM analysis) ──
  {
    const insightSlice: BenchmarkReportSlice = {
      overallScore: s.overallScore,
      overallCi95Lower: s.overallBootstrapCi95?.lower ?? s.overallCi95.lower,
      overallCi95Upper: s.overallBootstrapCi95?.upper ?? s.overallCi95.upper,
      executionEfficiency: s.executionEfficiency,
      answerQuality: s.answerQuality,
      faithfulness: s.faithfulness,
      contextRelevance: s.contextRelevance,
      contextRecall: s.contextRecall,
      judge: s.judge,
      latencyP50Ms: s.latencyMs.p50,
      latencyP95Ms: s.latencyMs.p95,
      tier6SoleExtractionRate: null, // TODO: aggregate from query logs
      meanHardConstraints: 0, // TODO: aggregate from query logs
      scrOverall: s.scrOverall ?? null,
      scrHard: s.scrHard ?? null,
      scrSoft: s.scrSoft ?? null,
      scrInferred: s.scrInferred ?? null,
      entityLinkingAccuracy: s.entityLinkingAccuracy ?? null,
      slotF1Strict: s.slotF1Strict ?? null,
      constraintEvaluatedCount: s.constraintEvaluatedCount ?? 0,
      scenarioCount: report.executedCount,
      criticalFailureCount: report.criticalFailureCount,
      worstScenarios: report.results
        .filter((r) => !r.skipped && r.error === undefined)
        .sort((a, b) => a.scores.overall - b.scores.overall)
        .slice(0, 5)
        .map((r) => ({ id: r.id, tier: r.tier, score: r.scores.overall, judge: r.scores.judge })),
    };
    // LLM insight: create a dedicated gpt-5.4-mini instance for analysis.
    // Separate from the judge LLM (which lives inside runBenchmark scope).
    // Cost: ~1 LLM call ($0.001) at the very end — negligible vs judge cost.
    let insightLlm: ChatLlmPort | undefined;
    try {
      const openaiKey = process.env['OPENAI_API_KEY'];
      if (openaiKey !== undefined && openaiKey.length > 0) {
        insightLlm = new OpenAiChatLlm({
          baseUrl: process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1',
          apiKey: openaiKey,
          defaultModel: 'gpt-5.4-mini',
          httpTimeoutMs: 30_000,
        });
      }
    } catch (insightLlmErr) {
      console.error(`  [INSIGHT] LLM creation failed: ${insightLlmErr instanceof Error ? insightLlmErr.message.slice(0, 100) : String(insightLlmErr)}`);
    }
    await printBenchmarkInsights(insightSlice, insightLlm);
  }

  console.error('');

  // Baseline comparison gate
  if (args.baseline !== undefined) {
    const { regressed } = await compareBaseline(report, args.baseline, args.failIfWorseThan);
    if (regressed) {
      process.exit(2);
    }
  }
}

// Allow importing types/helpers (e.g. unit tests) without starting the benchmark.
if (isBenchmarkRunnerCliEntrypoint(process.argv[1], import.meta.url)) {
  main().then(() => {
    // Explicit exit: after shutdown timeout, dangling PG/Redis connections may
    // keep the event loop alive indefinitely. process.exit(0) ensures the CLI
    // terminates cleanly after results are written.
    process.exit(0);
  }).catch((err: unknown) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
}
