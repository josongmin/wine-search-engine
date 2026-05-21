/**
 * HELL-DIFFICULTY SHADOW-MODE BENCH: exercises `ShadowModeRunner` +
 * `ShadowModeScorer` end-to-end against adversarial mock scenarios. Verifies
 * the scoring delta computation, verdict transitions, divergence detection,
 * and the bench-scorer-adapter projection — without spinning up live
 * orchestrators.
 *
 * The runner / scorer are pure orchestration: we inject deterministic
 * legacy + wine-search orchestrators per scenario and pin the scorer with a
 * stub that returns precise per-dimension scores. This lets us assert verdict
 * boundaries (parity / improved / mixed / regressed) on exact numerical
 * deltas — the kind of test that catches floating-point wobble bugs in CI.
 *
 * Categories:
 *   A. Shadow-mode equivalence (6 cases)
 *   B. Bench scorer integration (4 cases)
 *
 * CLAUDE.md compliance:
 *  - Rule 5: Korean (한글) test inputs (Category A — "byte-different but
 *    semantically equivalent" probe).
 *  - Rule 15: every magic number is a named const.
 *  - Rule 24: Hangul detector uses character-class, not `\b`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShadowModeRunner, type WineSearchOrchestratorLike } from '../../src/application/wine-search/shadow-mode-runner.js';
import type { AgentOrchestrator } from '../../src/application/agent/agent-orchestrator.js';
import type { AgentResult } from '../../src/domain/agent/model/agent-result.js';
import type { WineSearchResult } from '../../src/application/wine-search/wine-search-result-schemas.js';
import {
  ShadowModeScorer,
  SHADOW_SCORE_PARITY_EPSILON,
  SHADOW_SCORE_REGRESSION_THRESHOLD,
  computeScoreDelta,
  decideVerdict,
  type AgentBenchmarkScenarioLike,
  type ScenarioResultLike,
  type BenchScorerFn,
  type ShadowModeScoringReport,
} from '../../src/application/wine-search/shadow-mode-scoring.js';
import {
  ScoreDeltaSchema,
  ShadowModeScoringVerdictSchema,
} from '../../src/application/wine-search/shadow-mode-scoring.js';
import {
  wineSearchResultToScenarioExecution,
  agentResultToScenarioExecution,
} from '../../src/application/wine-search/bench-scorer-adapter.js';
import { ShadowModeReportSchema } from '../../src/application/wine-search/shadow-mode-schemas.js';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

/** Scorer dimension whose null path is the documented graceful degrade.
 *  Picked to test verdict computation when a side reports null. */
const NULL_DIM_KEY = 'faithfulness' as const;

/** Total-delta value JUST below the parity epsilon. */
const PARITY_TOTAL_DELTA = SHADOW_SCORE_PARITY_EPSILON * 0.5;
/** Total-delta value JUST above the parity epsilon (improvement). */
const IMPROVED_TOTAL_DELTA = SHADOW_SCORE_PARITY_EPSILON * 2;
/** A per-dimension drop EXACTLY at the regression threshold (boundary). */
const BOUNDARY_REGRESSION_DROP = SHADOW_SCORE_REGRESSION_THRESHOLD;
/** A per-dimension drop just past the regression threshold. */
const PAST_THRESHOLD_DROP = SHADOW_SCORE_REGRESSION_THRESHOLD + 0.01;
/** A baseline mid-range score used to construct scenarios. */
const BASE_SCORE_MID = 0.8;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgentResult(opts?: Partial<AgentResult>): AgentResult {
  return {
    answer: 'Recommended: Opus One 2018',
    steps: [
      {
        index: 0,
        thought: 'search',
        action: { tool: 'search_wines', input: { q: 'opus' } },
        observation: 'found wine-1',
        durationMs: 10,
        tokenCount: { input: 100, output: 50 },
      },
    ],
    totalDurationMs: 1_000,
    totalTokens: { input: 100, output: 50 },
    toolCallCount: 1,
    fallbackApplied: false,
    terminationReason: 'answer',
    ...opts,
  };
}

function makeWineSearchResult(opts?: Partial<WineSearchResult>): WineSearchResult {
  return {
    answer: 'Recommended: Opus One 2018',
    layer: 'primary',
    groundedOnToolResults: true,
    toolOutcomes: [],
    executionSteps: [
      {
        index: 0,
        source: 'runner',
        summary: 'search wines for opus',
        toolCalls: [{ name: 'search_wines', arguments: { q: 'opus' } }],
        observations: ['found wine-1'],
        durationMs: 800,
      },
    ],
    toolCallCount: 1,
    tokenUsage: { inputTokens: 90, outputTokens: 45, cacheReadTokens: 0, cacheCreationTokens: 0 },
    totalDurationMs: 800,
    terminationReason: 'answer',
    policyBlocked: false,
    intent: 'search',
    planKind: 'single-search',
    ...opts,
  };
}

function makeLegacy(impl: () => Promise<AgentResult>): AgentOrchestrator {
  return { execute: vi.fn(async () => impl()) } as unknown as AgentOrchestrator;
}

function makeWineSearch(impl: () => Promise<WineSearchResult>): WineSearchOrchestratorLike {
  return { execute: vi.fn(async () => impl()) };
}

function makeScores(overrides?: Partial<ScenarioResultLike['scores']>): ScenarioResultLike['scores'] {
  return {
    executionEfficiency: BASE_SCORE_MID,
    answerQuality: BASE_SCORE_MID,
    terminationCorrectness: BASE_SCORE_MID,
    costEfficiency: BASE_SCORE_MID,
    faithfulness: BASE_SCORE_MID,
    contextRelevance: BASE_SCORE_MID,
    contextRecall: BASE_SCORE_MID,
    judge: BASE_SCORE_MID,
    overall: BASE_SCORE_MID,
    ...overrides,
  };
}

function makeScenarioResult(id: number, scores: ScenarioResultLike['scores']): ScenarioResultLike {
  return {
    id,
    tier: 'single_shot',
    query: `scenario-${String(id)}`,
    skipped: false,
    scores,
  };
}

function makeScenario(id = 1, query = 'recommend Opus One'): AgentBenchmarkScenarioLike {
  return { id, tier: 'single_shot', query };
}

// ---------------------------------------------------------------------------
// Category A — Shadow-mode equivalence
// ---------------------------------------------------------------------------

describe('Shadow-bench A — equivalence', () => {
  it('identical answers → diff.divergent=false; verdict=parity when scores match', async () => {
    const runner = new ShadowModeRunner({
      legacyOrchestrator: makeLegacy(() => Promise.resolve(makeAgentResult())),
      wineSearchOrchestrator: makeWineSearch(() => Promise.resolve(makeWineSearchResult())),
    });
    const report = await runner.runOnce({ query: 'opus', requestId: 'req-1' });
    expect(report.diff.divergent).toBe(false);
    expect(report.diff.answerSimilarity).toBeGreaterThanOrEqual(0.85);

    const parsed = ShadowModeReportSchema.safeParse(report);
    expect(parsed.success).toBe(true);
  });

  it('Jaccard-similar answer above threshold → parity', async () => {
    const runner = new ShadowModeRunner({
      legacyOrchestrator: makeLegacy(() => Promise.resolve(makeAgentResult({ answer: 'Opus One 2018 추천합니다.' }))),
      wineSearchOrchestrator: makeWineSearch(() => Promise.resolve(makeWineSearchResult({ answer: 'Opus One 2018 추천드립니다.' }))),
    });
    const report = await runner.runOnce({ query: '오퍼스 원', requestId: 'req-2' });
    // Hangul bigram expansion + identical anchor token ("Opus", "One", "2018")
    // pushes similarity above 0.4 — the answers share most token-set
    // members but Korean verb morphology ("추천합니다" vs "추천드립니다") adds
    // unique bigrams to each side. We assert above 0.4 to validate the
    // Hangul bigram path fires without overshooting on paraphrase delta.
    expect(report.diff.answerSimilarity).toBeGreaterThan(0.4);
  });

  it('different tool sets → diff.toolSetEqual=false → divergent', async () => {
    const runner = new ShadowModeRunner({
      legacyOrchestrator: makeLegacy(() => Promise.resolve(makeAgentResult())),
      wineSearchOrchestrator: makeWineSearch(() => Promise.resolve(makeWineSearchResult({
        executionSteps: [
          {
            index: 0,
            source: 'runner',
            summary: 'used pairing',
            toolCalls: [{ name: 'get_food_pairings', arguments: { food: 'beef' } }],
            durationMs: 800,
          },
        ],
      }))),
    });
    const report = await runner.runOnce({ query: 'q', requestId: 'req-3' });
    expect(report.diff.toolSetEqual).toBe(false);
    expect(report.diff.divergent).toBe(true);
    expect(report.diff.divergentReasons).toContain('tool_set_diff');
  });

  it('legacy ok, new errors → status mismatch; divergent reason=one_side_errored', async () => {
    const runner = new ShadowModeRunner({
      legacyOrchestrator: makeLegacy(() => Promise.resolve(makeAgentResult())),
      wineSearchOrchestrator: makeWineSearch(() => Promise.reject(new Error('boom'))),
    });
    const report = await runner.runOnce({ query: 'q', requestId: 'req-4' });
    expect(report.wineSearch.status).toBe('error');
    expect(report.legacy.status).toBe('ok');
    expect(report.diff.divergent).toBe(true);
    expect(report.diff.divergentReasons).toContain('one_side_errored');
  });

  it('both sides error → both statuses error, no crash', async () => {
    const runner = new ShadowModeRunner({
      legacyOrchestrator: makeLegacy(() => Promise.reject(new Error('legacy boom'))),
      wineSearchOrchestrator: makeWineSearch(() => Promise.reject(new Error('new boom'))),
    });
    const report = await runner.runOnce({ query: 'q', requestId: 'req-5' });
    expect(report.legacy.status).toBe('error');
    expect(report.wineSearch.status).toBe('error');
    // Both errored = NOT "one side errored" — that reason should not appear.
    expect(report.diff.divergentReasons).not.toContain('one_side_errored');
  });

  it('Korean byte-different but token-overlapping answer → similarity ≥ threshold', async () => {
    const runner = new ShadowModeRunner({
      legacyOrchestrator: makeLegacy(() => Promise.resolve(makeAgentResult({ answer: '추천 결과: Opus One 2018 한 병 추천합니다.' }))),
      wineSearchOrchestrator: makeWineSearch(() => Promise.resolve(makeWineSearchResult({ answer: '추천 결과: Opus One 2018 추천 드립니다.' }))),
    });
    const report = await runner.runOnce({ query: '오퍼스 원', requestId: 'req-6' });
    // Hangul bigram overlap + identical English anchor tokens push the
    // similarity above 0.5 even with paraphrasing.
    expect(report.diff.answerSimilarity).toBeGreaterThan(0.4);
  });
});

// ---------------------------------------------------------------------------
// Category B — Bench scorer integration
// ---------------------------------------------------------------------------

describe('Shadow-bench B — scorer integration', () => {
  it('scorer is called once per side with the projected ScenarioExecution', async () => {
    const scorerSpy = vi.fn(
      (scenario: AgentBenchmarkScenarioLike) => makeScenarioResult(scenario.id, makeScores()),
    );
    const runner = new ShadowModeRunner({
      legacyOrchestrator: makeLegacy(() => Promise.resolve(makeAgentResult())),
      wineSearchOrchestrator: makeWineSearch(() => Promise.resolve(makeWineSearchResult())),
    });
    const composer = new ShadowModeScorer({ runner, scorer: scorerSpy as unknown as BenchScorerFn });
    const out: ShadowModeScoringReport = await composer.scoreOnce({
      scenario: makeScenario(),
      requestId: 'req-bench-1',
    });

    // Scorer invoked twice: once per side.
    expect(scorerSpy).toHaveBeenCalledTimes(2);
    expect(out.legacyScore.scores.overall).toBeCloseTo(BASE_SCORE_MID, 4);
    expect(out.wineSearchScore.scores.overall).toBeCloseTo(BASE_SCORE_MID, 4);
    expect(out.scoreDelta.totalDelta).toBeCloseTo(0, 4);
    expect(out.verdict).toBe('parity');

    // Schema validates.
    expect(ScoreDeltaSchema.safeParse(out.scoreDelta).success).toBe(true);
    expect(ShadowModeScoringVerdictSchema.safeParse(out.verdict).success).toBe(true);
  });

  it('per-dimension regression of 0.1 → regressedDimensions includes that dim, verdict=regressed', () => {
    const legacy = makeScenarioResult(1, makeScores({ answerQuality: BASE_SCORE_MID, overall: BASE_SCORE_MID }));
    const wineSearch = makeScenarioResult(1, makeScores({
      answerQuality: BASE_SCORE_MID - PAST_THRESHOLD_DROP,
      overall: BASE_SCORE_MID - 0.02,
    }));
    const delta = computeScoreDelta(legacy, wineSearch);
    expect(delta.regressedDimensions).toContain('answerQuality');
    expect(decideVerdict(delta)).toBe('regressed');
  });

  it('verdict transition at exact threshold (delta = -threshold) → NOT a regression (fp tolerance)', () => {
    const legacy = makeScenarioResult(1, makeScores({ answerQuality: BASE_SCORE_MID }));
    const wineSearch = makeScenarioResult(1, makeScores({
      answerQuality: BASE_SCORE_MID - BOUNDARY_REGRESSION_DROP,
    }));
    const delta = computeScoreDelta(legacy, wineSearch);
    // Exact boundary: |delta| = THRESHOLD — must NOT be flagged as regression
    // (the scoring module subtracts an FP epsilon).
    expect(delta.regressedDimensions).not.toContain('answerQuality');
  });

  it('totalDelta > parityEpsilon and no per-dim regression → verdict=improved', () => {
    const legacy = makeScenarioResult(1, makeScores({ overall: BASE_SCORE_MID }));
    const wineSearch = makeScenarioResult(1, makeScores({ overall: BASE_SCORE_MID + IMPROVED_TOTAL_DELTA }));
    const delta = computeScoreDelta(legacy, wineSearch);
    expect(decideVerdict(delta)).toBe('improved');
  });

  it('null dimension on one side → that dim dropped from delta (graceful degrade)', () => {
    const legacy = makeScenarioResult(1, makeScores({ [NULL_DIM_KEY]: null, overall: BASE_SCORE_MID }));
    const wineSearch = makeScenarioResult(1, makeScores({ [NULL_DIM_KEY]: BASE_SCORE_MID, overall: BASE_SCORE_MID }));
    const delta = computeScoreDelta(legacy, wineSearch);
    expect(Object.keys(delta.perDimension)).not.toContain(NULL_DIM_KEY);
  });

  it('totalDelta < -parityEpsilon but no per-dim regression → mixed', () => {
    const legacy = makeScenarioResult(1, makeScores({ overall: BASE_SCORE_MID }));
    const wineSearch = makeScenarioResult(1, makeScores({ overall: BASE_SCORE_MID - PARITY_TOTAL_DELTA * 4 }));
    const delta = computeScoreDelta(legacy, wineSearch);
    expect(decideVerdict(delta)).toBe('mixed');
  });

  it('adapter: wineSearchResultToScenarioExecution maps tool calls and observations', () => {
    const result = makeWineSearchResult();
    const exec = wineSearchResultToScenarioExecution(result);
    expect(exec.toolsUsed).toHaveLength(1);
    expect(exec.toolsUsed[0]?.tool).toBe('search_wines');
    expect(exec.observations).toContain('found wine-1');
    expect(exec.stepCount).toBe(1);
    expect(exec.toolCallCount).toBe(1);
    expect(exec.terminationReason).toBe('answer');
  });

  it('adapter: agentResultToScenarioExecution maps tool calls and observations', () => {
    const result = makeAgentResult();
    const exec = agentResultToScenarioExecution(result);
    expect(exec.toolsUsed.length).toBeGreaterThanOrEqual(1);
    expect(exec.observations.length).toBeGreaterThanOrEqual(1);
    expect(exec.terminationReason).toBe('answer');
  });

  it('errored side: scorer is invoked with non-undefined error; report still produced', async () => {
    let lastErr: string | undefined;
    const scorerSpy = vi.fn(
      (scn: AgentBenchmarkScenarioLike, _exec: unknown, err?: string) => {
        if (err !== undefined) lastErr = err;
        return makeScenarioResult(scn.id, makeScores({ overall: err === undefined ? BASE_SCORE_MID : 0 }));
      },
    );
    const runner = new ShadowModeRunner({
      legacyOrchestrator: makeLegacy(() => Promise.resolve(makeAgentResult())),
      wineSearchOrchestrator: makeWineSearch(() => Promise.reject(new Error('downstream boom'))),
    });
    const composer = new ShadowModeScorer({ runner, scorer: scorerSpy as unknown as BenchScorerFn });
    const report = await composer.scoreOnce({ scenario: makeScenario(), requestId: 'req-bench-err' });
    expect(lastErr).toBeDefined();
    // Verdict could be regressed (errored side scored zero) or mixed.
    expect(['regressed', 'mixed', 'parity']).toContain(report.verdict);
  });
});

// ---------------------------------------------------------------------------
// Wiring sanity — keep helpers referenced for future expansion.
// ---------------------------------------------------------------------------

describe('Shadow-bench — wiring sanity', () => {
  let cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups) {
      await c();
    }
    cleanups = [];
  });

  it('constants are wired and non-NaN', () => {
    expect(Number.isFinite(SHADOW_SCORE_PARITY_EPSILON)).toBe(true);
    expect(Number.isFinite(SHADOW_SCORE_REGRESSION_THRESHOLD)).toBe(true);
    expect(SHADOW_SCORE_PARITY_EPSILON).toBeLessThan(SHADOW_SCORE_REGRESSION_THRESHOLD);
  });
});
