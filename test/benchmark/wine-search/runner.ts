/**
 * Minimal bench runner targeting the NEW canonical agent —
 * `WineSearchOrchestrator` (Plan-then-Execute, `/v1/wine-search`).
 *
 * Replaces the deleted legacy `test/benchmark/agent/runner.ts` (which drove
 * the ReAct-style `AgentOrchestrator`). The cutover blueprint
 * ([[project-legacy-agent-cutover-blueprint]]) removed the old runner in
 * wave 6/10; this is the structural replacement.
 *
 * Architecture (re-uses every bench piece that survived the cutover):
 *
 *   1. Scenario corpus            — `test/benchmark/agent/scenarios.ts`
 *   2. Per-scenario execution     — `WineSearchOrchestrator.execute()`
 *   3. Result projection          — `wineSearchResultToScenarioExecution()`
 *                                    in `src/application/wine-search/
 *                                       bench-scorer-adapter.ts`
 *   4. Judge (rubric + faith)     — `judgeAnswerN` + `judgeFaithfulnessHybrid`
 *                                    in `test/benchmark/agent/judge.ts`
 *   5. Per-scenario scoring       — `scoreScenario()` in
 *                                    `test/benchmark/agent/scorer.ts`
 *   6. Aggregate                  — geometric mean via `aggregateGeoMean`
 *
 * Usage:
 *   node --env-file=.env --env-file=.env.local --import tsx \
 *     test/benchmark/wine-search/runner.ts \
 *     --profile quick-realdata --concurrency 1 [--runs N]
 *
 * The runner is intentionally minimal — no multi-sample aggregation,
 * no annotation/manifest/archive (those can be re-added wave by wave).
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../../src/config/env.js';
import { createContainer } from '../../../src/config/container.js';
import type { ChatLlmPort } from '../../../src/domain/ai/port/chat-llm.port.js';
import { createChatLlmFromEnv } from '../../../src/infrastructure/ai/chat-llm-from-env.js';
import { wineSearchResultToScenarioExecution } from '../../../src/application/wine-search/bench-scorer-adapter.js';
import type { WineSearchOrchestratorContract } from '../../../src/application/wine-search/wine-search-orchestrator.js';
import { AGENT_SCENARIOS } from '../agent/scenarios.js';
import type { AgentBenchmarkScenario } from '../agent/scenario.js';
import { scoreScenario, aggregateGeoMean } from '../agent/scorer.js';
import type { ScenarioExecution, ScenarioResult } from '../agent/scorer.js';
import { judgeAnswerN, judgeFaithfulnessHybrid } from '../agent/judge.js';

// ---------------------------------------------------------------------------
// Per-scenario result dump (structural — for RCA-grade post-hoc analysis).
//
// The bench process emits only an Overall score to stdout; without persisted
// per-scenario records there is no way to:
//   - identify regressed scenarios after a model/agent change
//   - cross-correlate fallback firing with score deltas
//   - sample bottom-quartile failures for root-cause analysis
//
// Records are written as JSONL (one line per scenario) so they accumulate
// even if the process is killed mid-run. A `summary.json` lands alongside
// on clean completion.
// ---------------------------------------------------------------------------
const RESULTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'results',
);

/**
 * Per-record preview limit: only the first N characters of the answer
 * and judge reasoning are persisted. Avoids JSONL blow-up on long
 * synthesizer outputs while keeping enough text for grep-based RCA.
 */
const SCENARIO_RECORD_PREVIEW_CHARS = 600;

/**
 * Quartile divisor for the bottom-N% scenario list in summary.json.
 * 4 = bottom quartile (lowest-scoring 25%).
 */
const BOTTOM_QUARTILE_DIVISOR = 4;

interface ScenarioRecord {
  readonly runIndex: number;
  readonly id: number;
  readonly tier: string;
  readonly query: string;
  readonly overallScore: number;
  readonly judgeScore: number | null;
  readonly faithfulnessScore: number | null;
  readonly terminationReason: string | undefined;
  /**
   * Status of the comparison-LLM fallback for this scenario. Derived from
   * `executionSteps` summary tags emitted by the orchestrator's
   * `tryComparisonLlmFallback`. The 4 values map 1:1 to fallback verdicts:
   *
   *   - `not_invoked`           — gate did not fire (no fallback step emitted)
   *   - `fired_ok`              — fallback produced a verdict (chosen=A|B)
   *   - `declined_no_candidates`— gate fired but no candidates per leg
   *   - `failed`                — gate fired but LLM call/parse failed
   */
  readonly comparisonFallback: 'not_invoked' | 'fired_ok' | 'declined_no_candidates' | 'failed';
  readonly fallbackChosenSide?: 'A' | 'B';
  readonly stepCount: number;
  readonly toolCallCount: number;
  readonly wallMs: number;
  readonly error?: string;
  readonly answerPreview?: string;
  readonly judgeReasoningPreview?: string;
}

/**
 * Detect comparison-fallback status from the execution-step trace. The
 * orchestrator emits a single step with a summary prefix like
 * `comparison_llm_fallback: ok (chosen=A)` / `declined (...)` / `failed (...)`.
 * Scanning the most recent occurrence handles the case where the orchestrator
 * is reworked to emit multiple fallback steps in a future wave.
 */
function detectComparisonFallback(steps: ReadonlyArray<{ readonly summary?: string }> | undefined): {
  readonly status: ScenarioRecord['comparisonFallback'];
  readonly chosenSide?: 'A' | 'B';
} {
  if (steps === undefined) return { status: 'not_invoked' };
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const summary = steps[i]?.summary ?? '';
    if (!summary.startsWith('comparison_llm_fallback:')) continue;
    if (summary.includes('ok (chosen=A)')) return { status: 'fired_ok', chosenSide: 'A' };
    if (summary.includes('ok (chosen=B)')) return { status: 'fired_ok', chosenSide: 'B' };
    if (summary.includes('declined')) return { status: 'declined_no_candidates' };
    if (summary.includes('failed')) return { status: 'failed' };
    return { status: 'not_invoked' };
  }
  return { status: 'not_invoked' };
}

function buildScenarioRecord(
  runIndex: number,
  result: ScenarioResult,
  wallMs: number,
): ScenarioRecord {
  const fallback = detectComparisonFallback(result.steps);
  const record: ScenarioRecord = {
    runIndex,
    id: result.id,
    tier: result.tier,
    query: result.query,
    overallScore: result.scores.overall ?? 0,
    judgeScore: result.scores.judge,
    faithfulnessScore: result.scores.faithfulness,
    ...(result.terminationReason !== undefined ? { terminationReason: result.terminationReason } : {}),
    comparisonFallback: fallback.status,
    ...(fallback.chosenSide !== undefined ? { fallbackChosenSide: fallback.chosenSide } : {}),
    stepCount: result.stepCount ?? 0,
    toolCallCount: result.toolCallCount ?? 0,
    wallMs,
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.answer !== undefined
      ? { answerPreview: result.answer.slice(0, SCENARIO_RECORD_PREVIEW_CHARS) }
      : {}),
    ...(result.judgeReasoning !== undefined
      ? { judgeReasoningPreview: result.judgeReasoning.slice(0, SCENARIO_RECORD_PREVIEW_CHARS) }
      : {}),
  };
  return record;
}

// ---------------------------------------------------------------------------
// Profile: identical scenario set to the legacy quick-realdata loop so the
// new agent's score is directly comparable against historical baselines.
// Source-of-truth: this set originates from the deleted legacy
// `runner.ts:185` (see git history at commit 2a4e60f5).
// ---------------------------------------------------------------------------
const QUICK_REALDATA_SCENARIO_IDS: ReadonlySet<number> = new Set([
  // worst performers (regression must-haves)
  106, 32, 42, 90, 63,
  // adversarial — full tier coverage
  101, 102, 103, 104, 105, 107, 108, 109, 110, 111,
  // critical security regression guards
  22, 112, 113, 115, 116,
  // single_shot
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
  // nested_condition
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
  // targeted gap guards
  117, 118, 119, 120, 121, 122, 123, 124,
  // coverage promotions
  200, 202, 203, 204, 208, 209,
  321, 322,
  340, 341, 342, 343,
]);

interface RunnerArgs {
  readonly profile: 'quick-realdata' | 'all';
  readonly concurrency: number;
  readonly runs: number;
  readonly idFilter?: ReadonlySet<number>;
}

function parseArgs(argv: readonly string[]): RunnerArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const profileRaw = get('--profile') ?? 'quick-realdata';
  const profile: RunnerArgs['profile'] =
    profileRaw === 'all' ? 'all' : 'quick-realdata';
  const concurrency = Math.max(1, Number.parseInt(get('--concurrency') ?? '1', 10));
  const runs = Math.max(1, Number.parseInt(get('--runs') ?? '1', 10));
  const idsRaw = get('--ids');
  const idFilter =
    idsRaw !== undefined
      ? new Set(idsRaw.split(',').map((s) => Number.parseInt(s.trim(), 10)).filter(Number.isFinite))
      : undefined;
  return idFilter !== undefined
    ? { profile, concurrency, runs, idFilter }
    : { profile, concurrency, runs };
}

function selectScenarios(args: RunnerArgs): readonly AgentBenchmarkScenario[] {
  if (args.idFilter !== undefined) {
    return AGENT_SCENARIOS.filter((s) => args.idFilter!.has(s.id));
  }
  if (args.profile === 'all') return AGENT_SCENARIOS;
  return AGENT_SCENARIOS.filter((s) => QUICK_REALDATA_SCENARIO_IDS.has(s.id));
}

interface ExecuteOutcome {
  readonly execution: ScenarioExecution | null;
  readonly judgeScore?: number | undefined;
  readonly judgeReasoning?: string | undefined;
  readonly faithfulnessScore?: number | undefined;
  readonly error?: string | undefined;
  readonly wallMs: number;
}

async function executeScenario(
  scenario: AgentBenchmarkScenario,
  orchestrator: WineSearchOrchestratorContract,
  judgeLlm: ChatLlmPort,
  requestId: string,
): Promise<ExecuteOutcome> {
  const t0 = Date.now();
  try {
    // gpt-5 reasoning models can comfortably take 15-30s per synthesis,
    // and the default 10s perStepTimeoutMs collapses those calls to
    // layer4 fallback (bench #117/#118 root cause when running on
    // gpt-5-mini). Env-overridable so non-reasoning models keep the
    // tight default.
    const perStepTimeoutMs = Number.parseInt(
      process.env['WINE_SEARCH_PER_STEP_TIMEOUT_MS'] ?? '',
      10,
    );
    const result = await orchestrator.execute({
      query: scenario.query,
      requestId,
      ...(scenario.expectation.maxSteps !== undefined
        ? { maxSteps: scenario.expectation.maxSteps }
        : {}),
      ...(scenario.expectation.maxTotalTokens !== undefined
        ? { maxTotalTokens: scenario.expectation.maxTotalTokens }
        : {}),
      ...(Number.isFinite(perStepTimeoutMs) && perStepTimeoutMs > 0
        ? { perStepTimeoutMs }
        : {}),
    });
    const projection = wineSearchResultToScenarioExecution(result);
    // ScenarioExecutionLike is structurally a ScenarioExecution superset
    // (per bench-scorer-adapter's contract test); the cast is the documented
    // seam — see the adapter docstring.
    const execution = projection as unknown as ScenarioExecution;

    // Rubric judge (N=1 for speed; can be raised via --runs in a future
    // wave). Skip silently when scenario has no rubric — judgeAnswerN
    // returns score=null which scoreScenario treats as "judge skipped".
    let judgeScore: number | undefined;
    let judgeReasoning: string | undefined;
    if (scenario.expectation.rubric !== undefined || hasAutoRubricSurface(scenario)) {
      const judged = await judgeAnswerN(judgeLlm, scenario, execution.answer, 1);
      if (judged.score !== null) judgeScore = judged.score;
      if (judged.rationale.length > 0) judgeReasoning = judged.rationale;
    }

    // Faithfulness (hybrid: deterministic floor + graded LLM partial-credit).
    // Receives the orchestrator's typed `toolOutcomes`, which carry the
    // GROUNDING_JSON envelopes the deterministic verifier matches against.
    const faith = await judgeFaithfulnessHybrid(
      judgeLlm,
      execution.answer,
      execution.observations,
      result.toolOutcomes,
      1,
    );
    const faithfulnessScore = faith.score ?? undefined;

    return {
      execution,
      ...(judgeScore !== undefined ? { judgeScore } : {}),
      ...(judgeReasoning !== undefined ? { judgeReasoning } : {}),
      ...(faithfulnessScore !== undefined ? { faithfulnessScore } : {}),
      wallMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      execution: null,
      error: err instanceof Error ? err.message : String(err),
      wallMs: Date.now() - t0,
    };
  }
}

/**
 * Auto-rubric is composed inside judgeAnswerN from structured-expectation
 * fields. We mirror the trigger here so we only invoke the judge when a
 * meaningful rubric exists — avoiding wasted judge LLM calls on scenarios
 * with neither a hand-written rubric nor auto-rubric surface area.
 */
function hasAutoRubricSurface(scenario: AgentBenchmarkScenario): boolean {
  const e = scenario.expectation;
  return (
    e.priceBandKrw !== undefined
    || e.factCheckClaims !== undefined
    || e.requireHedging === true
    || e.refusalExpected === true
    || e.requiredRegister !== undefined
    || (e.answerMustMatch !== undefined && e.answerMustMatch.length > 0)
  );
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<readonly R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const lanes = Math.min(concurrency, items.length);
  const workers = Array.from({ length: lanes }, async () => {
    for (;;) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= items.length) return;
      results[i] = await worker(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const scenarios = selectScenarios(args);
  console.log(
    `[runner-wine-search] profile=${args.profile} concurrency=${args.concurrency} runs=${args.runs} scenarios=${scenarios.length}`,
  );

  const config = loadConfig();
  const container = await createContainer(config);
  const wineSearch = container.wineSearch;
  if (wineSearch === undefined) {
    throw new Error(
      'wineSearch container slice is undefined — check ANTHROPIC_API_KEY / WINE_SEARCH_ENABLED env.',
    );
  }
  const orchestrator = wineSearch.wineSearchOrchestrator;
  const judgeLlm = createChatLlmFromEnv({
    env: process.env,
    openAiBaseUrl: config.openai.baseUrl,
    defaultModel: config.openai.chatModel,
    httpTimeoutMs: config.openai.httpTimeoutMs,
    allowCodexFallback: true,
  });
  if (judgeLlm === undefined) {
    throw new Error('chatLlm undefined — judge cannot run. Check OPENAI_API_KEY/OPENAI_API_KEYS or Codex ChatGPT login token.');
  }

  // Per-run JSONL stream: one record per scenario as it completes. The
  // suffix label allows operators to tag runs (e.g. "v11-expanded-gate")
  // for offline diff. Stream-as-you-go survives kill-mid-run.
  mkdirSync(RESULTS_DIR, { recursive: true });
  const runLabel = process.env['WINE_SEARCH_BENCH_LABEL'] ?? 'unlabeled';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonlPath = join(RESULTS_DIR, `${stamp}_${runLabel}.jsonl`);
  const summaryPath = join(RESULTS_DIR, `${stamp}_${runLabel}.summary.json`);
  console.log(`[runner-wine-search] persisting per-scenario records to ${jsonlPath}`);

  const allRunResults: ScenarioResult[][] = [];
  const allRecords: ScenarioRecord[] = [];
  for (let runIdx = 0; runIdx < args.runs; runIdx += 1) {
    if (args.runs > 1) console.log(`\n[run ${runIdx + 1}/${args.runs}]`);

    const startedAt = Date.now();
    const scenarioResults = await runWithConcurrency(
      scenarios,
      args.concurrency,
      async (scenario, i) => {
        const tag = `[${i + 1}/${scenarios.length}]`;
        process.stdout.write(`  [RUN]  #${String(scenario.id).padEnd(4)} ${tag} ${scenario.tier}\n`);
        const requestId = `bench-pte-${scenario.id}-r${runIdx}`;
        const outcome = await executeScenario(scenario, orchestrator, judgeLlm, requestId);

        const result = scoreScenario(
          scenario,
          outcome.execution,
          outcome.judgeScore,
          outcome.faithfulnessScore,
          outcome.error,
          outcome.execution?.steps,
          outcome.judgeReasoning,
        );

        const overall = result.scores.overall ?? 0;
        process.stdout.write(
          `  [DONE] #${String(scenario.id).padEnd(4)} score=${(overall * 100).toFixed(1).padStart(5)}% ${(outcome.wallMs / 1000).toFixed(1)}s\n`,
        );

        const record = buildScenarioRecord(runIdx, result, outcome.wallMs);
        allRecords.push(record);
        appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`, 'utf8');

        return result;
      },
    );

    const wallSec = (Date.now() - startedAt) / 1000;
    const overallScores: number[] = [];
    for (const r of scenarioResults) {
      if (r.skipped || r.error !== undefined) continue;
      const o = r.scores.overall;
      if (typeof o === 'number' && Number.isFinite(o)) overallScores.push(o);
    }
    const geoMean = aggregateGeoMean(overallScores);
    const criticalFails = scenarioResults.filter((r) =>
      !r.skipped && r.error === undefined && (r.scores.overall ?? 0) === 0,
    ).length;

    console.log(
      `\n  Overall: ${(geoMean * 100).toFixed(1)}% (geo-mean) [n=${overallScores.length}]` +
      `   critical-fail=${criticalFails}` +
      `   wall=${wallSec.toFixed(0)}s`,
    );
    allRunResults.push(scenarioResults);
  }

  // Multi-run summary (when --runs > 1).
  if (allRunResults.length > 1) {
    const perRunGeo = allRunResults.map((rs) => {
      const xs: number[] = [];
      for (const r of rs) {
        if (r.skipped || r.error !== undefined) continue;
        const o = r.scores.overall;
        if (typeof o === 'number' && Number.isFinite(o)) xs.push(o);
      }
      return aggregateGeoMean(xs);
    });
    const mean = perRunGeo.reduce((a, b) => a + b, 0) / perRunGeo.length;
    console.log(
      `\n  Multi-run mean overall: ${(mean * 100).toFixed(1)}%   per-run: [${perRunGeo.map((g) => (g * 100).toFixed(1)).join('%, ')}%]`,
    );
  }

  // Summary file: aggregate metrics + fallback distribution + bottom-quartile
  // scenario list. This is the primary RCA artifact — operators can diff
  // summary.json across runs without re-parsing the full JSONL.
  const overallScores = allRecords
    .filter((r) => r.error === undefined)
    .map((r) => r.overallScore)
    .filter((s) => Number.isFinite(s));
  const geoMean = aggregateGeoMean(overallScores);
  const fallbackBuckets = { not_invoked: 0, fired_ok: 0, declined_no_candidates: 0, failed: 0 };
  const fallbackFiredScores: number[] = [];
  const fallbackNotInvokedScores: number[] = [];
  for (const r of allRecords) {
    fallbackBuckets[r.comparisonFallback] += 1;
    if (r.error !== undefined) continue;
    if (r.comparisonFallback === 'fired_ok') fallbackFiredScores.push(r.overallScore);
    else if (r.comparisonFallback === 'not_invoked') fallbackNotInvokedScores.push(r.overallScore);
  }
  const arithmeticMean = (xs: readonly number[]): number =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
  const bottomQuartile = [...allRecords]
    .filter((r) => r.error === undefined)
    .sort((a, b) => a.overallScore - b.overallScore)
    .slice(0, Math.max(1, Math.floor(allRecords.length / BOTTOM_QUARTILE_DIVISOR)));
  const summary = {
    runLabel,
    timestamp: new Date().toISOString(),
    scenarioCount: allRecords.length,
    overallGeoMean: geoMean,
    fallbackBuckets,
    fallbackFiredCount: fallbackFiredScores.length,
    fallbackFiredMean: arithmeticMean(fallbackFiredScores),
    fallbackNotInvokedMean: arithmeticMean(fallbackNotInvokedScores),
    bottomQuartileIds: bottomQuartile.map((r) => ({
      id: r.id,
      tier: r.tier,
      score: r.overallScore,
      fallback: r.comparisonFallback,
      terminationReason: r.terminationReason,
    })),
  };
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(
    `[runner-wine-search] summary written ${summaryPath}\n` +
      `  fallback: not_invoked=${String(fallbackBuckets.not_invoked)} ` +
      `fired_ok=${String(fallbackBuckets.fired_ok)} ` +
      `declined=${String(fallbackBuckets.declined_no_candidates)} ` +
      `failed=${String(fallbackBuckets.failed)}\n` +
      `  mean(fired_ok)=${(arithmeticMean(fallbackFiredScores) * 100).toFixed(1)}%   ` +
      `mean(not_invoked)=${(arithmeticMean(fallbackNotInvokedScores) * 100).toFixed(1)}%`,
  );
}

main().catch((err: unknown) => {
  console.error('[runner-wine-search] FATAL', err);
  process.exit(1);
});
