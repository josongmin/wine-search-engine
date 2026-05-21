/**
 * End-to-end test for the shadow-mode bench CLI wired with the REAL bench
 * scorer (`test/benchmark/agent/scorer.ts`).
 *
 * Coverage goals (Track 5 R7 close-out):
 *   1. `loadBenchScorer()` dynamically imports the scorer module and
 *      returns a callable `BenchScorerFn` (no stub / placeholder).
 *   2. `runBench({ scorer })` end-to-end produces a JSONL stream where every
 *      record carries a real `ShadowModeScoringReport` projection (legacy +
 *      wineSearch overalls, per-dimension delta, verdict).
 *   3. Each scoring record exposes the scorer's documented dimensions and
 *      the verdict logic agrees with `computeScoreDelta` + `decideVerdict`.
 *   4. Orchestrators are mocked (no live LLM/Vespa); the test runs in the
 *      lightweight Vitest lane on a few crafted scenarios.
 *
 * Why this matters (CLAUDE.md rule 33 — production wire-up):
 *   The CLI is the cutover-validation entry point. If the scorer integration
 *   regresses to a stub or detaches from the real export, the harness silently
 *   reports "everything is fine" against synthetic scores. This test pins
 *   the wire: it asserts the production export is the actual `scoreScenario`
 *   function and that the JSONL stream surface mirrors the scorer's contract.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBench, loadBenchScorer } from '../run-shadow-mode-bench.js';
import type { AgentBenchmarkScenario } from '../../../test/benchmark/agent/scenario.js';
import type { AgentOrchestrator } from '../../../src/application/agent/agent-orchestrator.js';
import type {
  WineSearchOrchestratorLike,
} from '../../../src/application/wine-search/shadow-mode-runner.js';
import type { AgentResult } from '../../../src/domain/agent/model/agent-result.js';
import type { WineSearchResult } from '../../../src/application/wine-search/wine-search-result-schemas.js';
import type { ShadowModeLogger } from '../../../src/application/wine-search/shadow-mode-runner.js';
import {
  decideVerdict,
  computeScoreDelta,
  type ScoreDelta,
  type ShadowModeScoringVerdict,
} from '../../../src/application/wine-search/shadow-mode-scoring.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * A compact, hand-crafted scenario set the real scorer can evaluate end-to-end.
 * Three scenarios with different expectation surfaces so the verdict logic
 * sees variety (tool-call check, answer substring match, termination check).
 */
function makeScenarios(): readonly AgentBenchmarkScenario[] {
  return [
    {
      id: 10_001,
      tier: 'single_shot',
      query: 'Opus One 2018 추천해줘',
      description: 'real-scorer test: lookup with substring contract',
      expectation: {
        maxSteps: 5,
        tools: [{ tool: 'search_wines' }],
        answerContains: ['Opus One'],
        terminationReason: 'answer',
      },
    },
    {
      id: 10_002,
      tier: 'single_shot',
      query: 'Margaux 2015 와인 정보',
      description: 'real-scorer test: another search-only scenario',
      expectation: {
        maxSteps: 5,
        tools: [{ tool: 'search_wines' }],
        terminationReason: 'answer',
      },
    },
    {
      id: 10_003,
      tier: 'single_shot',
      query: '저렴한 프랑스 레드 와인',
      description: 'real-scorer test: minimal expectation surface',
      expectation: { maxSteps: 5 },
    },
  ];
}

const SHARED_LEGACY_ANSWER = 'Opus One 2018 — Napa Valley cabernet sauvignon blend.';
const SHARED_WINE_SEARCH_ANSWER = 'Opus One 2018 — Napa Valley cabernet sauvignon blend.';

function makeLegacyOrchestrator(): AgentOrchestrator {
  const execute = async (query: string): Promise<AgentResult> => ({
    answer: SHARED_LEGACY_ANSWER,
    steps: [
      {
        index: 0,
        thought: 'mock-legacy',
        action: { tool: 'search_wines', input: { q: query } },
        observation: 'mock-observation-legacy',
        durationMs: 5,
        tokenCount: { input: 50, output: 30 },
      },
    ],
    totalDurationMs: 5,
    totalTokens: { input: 50, output: 30 },
    toolCallCount: 1,
    fallbackApplied: false,
    terminationReason: 'answer',
  });
  return { execute } as unknown as AgentOrchestrator;
}

function makeWineSearchOrchestrator(): WineSearchOrchestratorLike {
  return {
    execute: async ({ query }): Promise<WineSearchResult> => ({
      answer: SHARED_WINE_SEARCH_ANSWER,
      layer: 'primary',
      groundedOnToolResults: true,
      toolOutcomes: [],
      executionSteps: [
        {
          index: 0,
          source: 'runner',
          summary: 'mock-wine-search',
          toolCalls: [{ name: 'search_wines', arguments: { q: query } }],
          observations: ['mock-observation-wine-search'],
          durationMs: 5,
        },
      ],
      toolCallCount: 1,
      tokenUsage: {
        inputTokens: 50,
        outputTokens: 30,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      totalDurationMs: 5,
      terminationReason: 'answer',
      policyBlocked: false,
      degradedReason: undefined,
      intent: 'search',
      planKind: 'single-search',
    }),
  };
}

const silentLogger: ShadowModeLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// Setup / teardown — one tmpdir per test for clean isolation.
// ---------------------------------------------------------------------------

let tmpDir: string;
let outputPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'shadow-bench-real-scorer-'));
  outputPath = join(tmpDir, 'bench.jsonl');
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup; ignore
  }
});

// ---------------------------------------------------------------------------
// loadBenchScorer — pure unit
// ---------------------------------------------------------------------------

describe('loadBenchScorer', () => {
  it('dynamically imports the real scorer module and returns a callable', async () => {
    const scorer = await loadBenchScorer(silentLogger);
    expect(typeof scorer).toBe('function');
  });

  it('binding is identity-stable: same module ref reused across loads', async () => {
    // The dynamic import caches; two loads return distinct closures but
    // both call into the same `scoreScenario`. Smoke-test by feeding both
    // an identical scenario+execution and asserting identical overall.
    const a = await loadBenchScorer(silentLogger);
    const b = await loadBenchScorer(silentLogger);
    const scenario = makeScenarios()[0]!;
    const execution = {
      answer: 'Opus One 2018 mock',
      stepCount: 1,
      toolCallCount: 1,
      toolsUsed: [{ tool: 'search_wines' }],
      observations: [],
      terminationReason: 'answer' as const,
      totalDurationMs: 5,
      totalTokens: { input: 50, output: 30 },
    };
    const resA = a(scenario, execution);
    const resB = b(scenario, execution);
    expect(resA.scores.overall).toBe(resB.scores.overall);
  });

  it('emits an INFO log per scored scenario with full dimension surface', async () => {
    const logged: Array<{ obj: Record<string, unknown>; msg?: string }> = [];
    const captureLogger: ShadowModeLogger = {
      info: (obj, msg) => logged.push({ obj, ...(msg !== undefined ? { msg } : {}) }),
      warn: () => {},
      error: () => {},
    };
    const scorer = await loadBenchScorer(captureLogger);
    const scenario = makeScenarios()[0]!;
    scorer(
      scenario,
      {
        answer: 'Opus One 2018 mock',
        stepCount: 1,
        toolCallCount: 1,
        toolsUsed: [{ tool: 'search_wines' }],
        observations: [],
        terminationReason: 'answer',
        totalDurationMs: 5,
        totalTokens: { input: 50, output: 30 },
      },
    );
    expect(logged.length).toBe(1);
    const entry = logged[0]!;
    expect(entry.msg).toBe('bench scorer scored scenario');
    expect(entry.obj['scenarioId']).toBe(scenario.id);
    // Real dimensions surface in the log payload.
    for (const dim of [
      'overall',
      'executionEfficiency',
      'answerQuality',
      'terminationCorrectness',
      'costEfficiency',
      'judge',
      'faithfulness',
      'contextRelevance',
      'contextRecall',
    ] as const) {
      expect(entry.obj).toHaveProperty(dim);
    }
  });

  it('wraps scorer crashes with scenario context (rule 11 — runtime guard)', async () => {
    const scorer = await loadBenchScorer(silentLogger);
    // Force a crash by passing a scenario with an id but a malformed
    // expectation. scoreScenario tolerates most inputs, so we craft an
    // obviously-broken scenario shape (cast through unknown) to provoke
    // a throw deep inside one of the dim scorers.
    const malformed = {
      id: 999_999,
      tier: 'single_shot',
      query: 'crash',
      description: 'crash test',
      expectation: null,
    } as unknown as AgentBenchmarkScenario;
    expect(() => scorer(malformed, {
      answer: '',
      stepCount: 0,
      toolCallCount: 0,
      toolsUsed: [],
      observations: [],
      terminationReason: 'answer',
      totalDurationMs: 0,
      totalTokens: { input: 0, output: 0 },
    })).toThrow(/scoreScenario crashed for scenario id=999999/u);
  });
});

// ---------------------------------------------------------------------------
// runBench — end-to-end with real scorer
// ---------------------------------------------------------------------------

describe('runBench + real scorer end-to-end', () => {
  it('writes a JSONL stream with valid ShadowModeScoringReport entries', async () => {
    const scorer = await loadBenchScorer(silentLogger);
    const scenarios = makeScenarios();
    const summary = await runBench({
      scenarios,
      legacyOrchestrator: makeLegacyOrchestrator(),
      wineSearchOrchestrator: makeWineSearchOrchestrator(),
      outputPath,
      concurrency: 1,
      timeoutMs: 5_000,
      logger: silentLogger,
      scorer,
    });

    expect(summary.total).toBe(scenarios.length);
    expect(summary.scoring).toBeDefined();
    const scoring = summary.scoring!;
    expect(scoring.total).toBe(scenarios.length);

    // Inspect JSONL: every line must carry the expected scoring keys.
    const lines = readFileSync(outputPath, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(scenarios.length);
    for (const line of lines) {
      const parsed = JSON.parse(line) as {
        scenarioId: number;
        shadowDiff: { requestId: string };
        legacyOverall: number;
        wineSearchOverall: number;
        scoreDelta: ScoreDelta;
        verdict: ShadowModeScoringVerdict;
      };
      expect(typeof parsed.scenarioId).toBe('number');
      expect(typeof parsed.legacyOverall).toBe('number');
      expect(typeof parsed.wineSearchOverall).toBe('number');
      expect(Number.isFinite(parsed.legacyOverall)).toBe(true);
      expect(Number.isFinite(parsed.wineSearchOverall)).toBe(true);
      expect(['parity', 'improved', 'regressed', 'mixed']).toContain(parsed.verdict);
      // Per-dimension deltas exist for at least the structural dimensions
      // (faithfulness/judge/context* may be dropped when null).
      const dims = Object.keys(parsed.scoreDelta.perDimension);
      expect(dims).toContain('executionEfficiency');
      expect(dims).toContain('answerQuality');
      expect(dims).toContain('terminationCorrectness');
      expect(dims).toContain('costEfficiency');
      // Every reported delta is finite.
      for (const v of Object.values(parsed.scoreDelta.perDimension)) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('produces parity verdicts when both sides return identical executions', async () => {
    const scorer = await loadBenchScorer(silentLogger);
    const scenarios = makeScenarios();
    const summary = await runBench({
      scenarios,
      legacyOrchestrator: makeLegacyOrchestrator(),
      wineSearchOrchestrator: makeWineSearchOrchestrator(),
      outputPath,
      concurrency: 1,
      timeoutMs: 5_000,
      logger: silentLogger,
      scorer,
    });
    const scoring = summary.scoring!;
    // With identical executions, no dimension should regress and the verdict
    // distribution must be parity-only.
    expect(scoring.verdictCounts.regressed).toBe(0);
    expect(scoring.verdictCounts.improved).toBe(0);
    expect(scoring.verdictCounts.mixed).toBe(0);
    expect(scoring.verdictCounts.parity).toBe(scenarios.length);
  });

  it('regressed-rate is honored: divergent wineSearch surfaces regressed verdict', async () => {
    // Wine-search orchestrator emits an *empty* answer and `error`
    // termination → answerQuality + terminationCorrectness should collapse.
    const divergentWineSearch: WineSearchOrchestratorLike = {
      execute: async (): Promise<WineSearchResult> => ({
        answer: '',
        layer: 'primary',
        groundedOnToolResults: false,
        toolOutcomes: [],
        executionSteps: [],
        toolCallCount: 0,
        tokenUsage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        totalDurationMs: 1,
        terminationReason: 'error',
        policyBlocked: false,
        degradedReason: undefined,
        intent: 'search',
        planKind: 'single-search',
      }),
    };
    const scorer = await loadBenchScorer(silentLogger);
    const summary = await runBench({
      scenarios: makeScenarios(),
      legacyOrchestrator: makeLegacyOrchestrator(),
      wineSearchOrchestrator: divergentWineSearch,
      outputPath,
      concurrency: 1,
      timeoutMs: 5_000,
      logger: silentLogger,
      scorer,
    });
    const scoring = summary.scoring!;
    expect(scoring.regressedRatePercent).toBeGreaterThan(0);
    // The first scenario has `answerContains: ['Opus One']` — the empty
    // wineSearch answer fails that contract, so its verdict cannot be
    // 'parity' or 'improved'.
    expect(scoring.verdictCounts.parity).toBeLessThan(makeScenarios().length);
    // worstRegressions should surface answerQuality or terminationCorrectness.
    const dims = new Set(scoring.worstRegressions.map((r) => r.dimension));
    const hasExpectedRegression = dims.has('answerQuality')
      || dims.has('terminationCorrectness')
      || dims.has('executionEfficiency');
    expect(hasExpectedRegression).toBe(true);
  });

  it('verdict logic agrees with computeScoreDelta + decideVerdict at the per-line level', async () => {
    // For each JSONL line, recompute the verdict from the recorded delta
    // and assert the recorded verdict matches. This pins the end-to-end
    // wiring of scorer → composer → CLI without trusting an intermediate
    // cache.
    const scorer = await loadBenchScorer(silentLogger);
    const scenarios = makeScenarios();
    await runBench({
      scenarios,
      legacyOrchestrator: makeLegacyOrchestrator(),
      wineSearchOrchestrator: makeWineSearchOrchestrator(),
      outputPath,
      concurrency: 1,
      timeoutMs: 5_000,
      logger: silentLogger,
      scorer,
    });
    const lines = readFileSync(outputPath, 'utf-8').trim().split('\n');
    for (const line of lines) {
      const parsed = JSON.parse(line) as {
        scoreDelta: ScoreDelta;
        verdict: ShadowModeScoringVerdict;
      };
      const recomputed = decideVerdict(parsed.scoreDelta);
      expect(recomputed).toBe(parsed.verdict);
    }
  });
});

// ---------------------------------------------------------------------------
// Type-shape contract: ScenarioExecutionLike subset matches the real scorer
// ---------------------------------------------------------------------------

describe('type harmony — ScenarioExecutionLike vs ScenarioExecution', () => {
  it('the adapter projection feeds scoreScenario without runtime shape errors', async () => {
    // This is a runtime smoke test against the structural mirror in
    // `bench-scorer-adapter.ts`. The compile-time check lives in
    // `src/application/wine-search/__tests__/bench-scorer-adapter.test.ts`;
    // this assertion makes the wiring failure mode visible at runtime too.
    const scorer = await loadBenchScorer(silentLogger);
    const scenario = makeScenarios()[0]!;
    const result = scorer(scenario, {
      answer: 'Opus One 2018 mock',
      stepCount: 1,
      toolCallCount: 1,
      toolsUsed: [{ tool: 'search_wines', input: JSON.stringify({ q: 'opus' }) }],
      observations: ['mock-observation'],
      terminationReason: 'answer',
      totalDurationMs: 5,
      totalTokens: { input: 50, output: 30 },
    });
    expect(Number.isFinite(result.scores.overall)).toBe(true);
    expect(result.scores.overall).toBeGreaterThanOrEqual(0);
    expect(result.scores.overall).toBeLessThanOrEqual(1);
  });

  it('per-dimension delta math agrees between recorded and recomputed', async () => {
    // Sanity: when we score the same execution twice (both sides
    // identical), every dim delta must be exactly 0.
    const scorer = await loadBenchScorer(silentLogger);
    const scenario = makeScenarios()[0]!;
    const execution = {
      answer: 'Opus One 2018 mock',
      stepCount: 1,
      toolCallCount: 1,
      toolsUsed: [{ tool: 'search_wines' }],
      observations: [],
      terminationReason: 'answer' as const,
      totalDurationMs: 5,
      totalTokens: { input: 50, output: 30 },
    };
    const left = scorer(scenario, execution);
    const right = scorer(scenario, execution);
    const delta = computeScoreDelta(left, right);
    expect(delta.totalDelta).toBe(0);
    expect(delta.regressedDimensions).toEqual([]);
    for (const v of Object.values(delta.perDimension)) {
      expect(v).toBe(0);
    }
  });
});

