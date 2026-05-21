/**
 * Tests for `ShadowModeScorer` — the composer that runs both orchestrators
 * via `ShadowModeRunner` and folds the bench scorer over both outcomes.
 *
 * The scorer is mocked to a deterministic per-side numeric map so verdict
 * logic is testable without loading the 3k-line bench scorer module.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ShadowModeScorer,
  SHADOW_SCORE_PARITY_EPSILON,
  SHADOW_SCORE_REGRESSION_THRESHOLD,
  computeScoreDelta,
  decideVerdict,
  scoreRawResults,
  type BenchScorerFn,
  type ShadowModeScoringReport,
} from '../shadow-mode-scoring.js';
import {
  scoreScenario,
  type ScenarioResult,
  type ScenarioScores,
} from '../../../../test/benchmark/agent/scorer.js';
import type {
  AgentBenchmarkScenario,
  ScenarioExpectation,
} from '../../../../test/benchmark/agent/scenario.js';
import type {
  ShadowModeReport,
  ShadowModeOrchestratorOutcome,
} from '../shadow-mode-schemas.js';
import type { ShadowModeRunner } from '../shadow-mode-runner.js';
import type { LlmJudge, JudgeInput, JudgeResult } from '../llm-judge.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ZERO_DIM_SCORES: ScenarioScores = {
  executionEfficiency: 0,
  toolAccuracy: 0,
  stepEfficiency: 0,
  answerQuality: 0,
  terminationCorrectness: 0,
  costEfficiency: 0,
  faithfulness: null,
  contextRelevance: null,
  contextRecall: null,
  exactLookupHit: null,
  failClosedAccuracy: null,
  answerRelevancy: null,
  judge: null,
  overall: 0,
  criticalFailure: false,
  semanticConstraintRecall: null,
  scrHard: null,
  scrSoft: null,
  scrInferred: null,
  scrInferredGraph: null,
  entityLinkingAccuracy: null,
  slotF1Strict: null,
  slotF1Relaxed: null,
  csrOverall: null,
  csrHard: null,
  csrSoft: null,
  csrInferred: null,
  csrInferredGraph: null,
};

function makeScores(partial: Partial<ScenarioScores>): ScenarioScores {
  return { ...ZERO_DIM_SCORES, ...partial };
}

function makeScenarioResult(
  overrides: { id?: number; scores?: ScenarioScores; error?: string } = {},
): ScenarioResult {
  return {
    id: overrides.id ?? 1,
    tier: 'single_shot',
    query: 'q',
    skipped: false,
    scores: overrides.scores ?? makeScores({ overall: 0.5 }),
    judgeRequiredButSkipped: false,
    ...(overrides.error !== undefined ? { error: overrides.error } : {}),
  };
}

function makeScenario(): AgentBenchmarkScenario {
  const expectation: ScenarioExpectation = { maxSteps: 5 };
  return {
    id: 7,
    tier: 'single_shot',
    query: 'Opus One 2018',
    description: 'fixture',
    expectation,
  };
}

function makeOutcome(
  partial: Partial<ShadowModeOrchestratorOutcome>,
): ShadowModeOrchestratorOutcome {
  return {
    orchestrator: 'legacy_agent',
    status: 'ok',
    answer: 'a',
    toolCallCount: 1,
    toolNames: ['search_wines'],
    terminationReason: 'answer',
    totalDurationMs: 100,
    tokenUsage: { inputTokens: 10, outputTokens: 5 },
    ...partial,
  };
}

function makeReport(partial: Partial<ShadowModeReport> = {}): ShadowModeReport {
  return {
    requestId: 'req',
    query: 'q',
    queryPreview: 'q',
    legacy: makeOutcome({ orchestrator: 'legacy_agent' }),
    wineSearch: makeOutcome({ orchestrator: 'wine_search' }),
    diff: {
      answerEquivalent: true,
      answerSimilarity: 1,
      toolSetEqual: true,
      toolOrderEqual: true,
      terminationReasonEqual: true,
      durationDeltaMs: 0,
      tokenDeltaInput: 0,
      tokenDeltaOutput: 0,
      divergent: false,
      divergentReasons: [],
    },
    ...partial,
  };
}

function makeRunner(report: ShadowModeReport): Pick<ShadowModeRunner, 'runOnce'> {
  return {
    runOnce: vi.fn(async () => report),
  };
}

/**
 * Deterministic scorer: returns a side-dependent score map. Keyed off the
 * execution's `answer` field — `'legacy'` vs `'wine_search'` answers map to
 * the supplied score tables.
 */
function makeScorer(byAnswer: Readonly<Record<string, ScenarioScores>>): BenchScorerFn {
  return (scenario, execution, error) => {
    if (execution === null || error !== undefined) {
      return makeScenarioResult({ id: scenario.id, error: error ?? 'no exec' });
    }
    const scores = byAnswer[execution.answer] ?? makeScores({ overall: 0.5 });
    return {
      id: scenario.id,
      tier: scenario.tier,
      query: scenario.query,
      skipped: false,
      answer: execution.answer,
      stepCount: execution.stepCount,
      toolCallCount: execution.toolCallCount,
      toolsUsed: execution.toolsUsed.map((t) => t.tool),
      terminationReason: execution.terminationReason,
      totalDurationMs: execution.totalDurationMs,
      totalTokens: execution.totalTokens,
      scores,
      judgeRequiredButSkipped: false,
    };
  };
}

// ---------------------------------------------------------------------------
// computeScoreDelta + decideVerdict (unit-level)
// ---------------------------------------------------------------------------

describe('computeScoreDelta + decideVerdict', () => {
  it('identical scores → verdict parity', () => {
    const r = makeScenarioResult({ scores: makeScores({ overall: 0.7, answerQuality: 0.7 }) });
    const delta = computeScoreDelta(r, r);
    expect(delta.totalDelta).toBe(0);
    expect(delta.regressedDimensions).toEqual([]);
    expect(decideVerdict(delta)).toBe('parity');
  });

  it('wine-search better on all dimensions → verdict improved', () => {
    const legacy = makeScenarioResult({ scores: makeScores({ overall: 0.5, answerQuality: 0.5, executionEfficiency: 0.5 }) });
    const wineSearch = makeScenarioResult({ scores: makeScores({ overall: 0.8, answerQuality: 0.8, executionEfficiency: 0.8 }) });
    const delta = computeScoreDelta(legacy, wineSearch);
    expect(delta.totalDelta).toBeGreaterThan(0);
    expect(delta.regressedDimensions).toEqual([]);
    expect(decideVerdict(delta)).toBe('improved');
  });

  it('one dimension drops by > REGRESSION_THRESHOLD → verdict regressed', () => {
    const legacy = makeScenarioResult({ scores: makeScores({ overall: 0.8, answerQuality: 0.9 }) });
    // answerQuality drops by 0.20 (well past 0.05 threshold)
    const wineSearch = makeScenarioResult({ scores: makeScores({ overall: 0.7, answerQuality: 0.7 }) });
    const delta = computeScoreDelta(legacy, wineSearch);
    expect(delta.regressedDimensions).toContain('answerQuality');
    expect(decideVerdict(delta)).toBe('regressed');
  });

  it('per-dimension drop exactly AT threshold is NOT a regression (CLAUDE.md rule 18)', () => {
    // boundary: drop equal to threshold → still passes.
    const legacy = makeScenarioResult({ scores: makeScores({ overall: 0.8, answerQuality: 0.7 }) });
    const wineSearch = makeScenarioResult({
      scores: makeScores({ overall: 0.8, answerQuality: 0.7 - SHADOW_SCORE_REGRESSION_THRESHOLD }),
    });
    const delta = computeScoreDelta(legacy, wineSearch);
    expect(delta.regressedDimensions).toEqual([]);
  });

  it('per-dimension drop JUST OVER threshold IS a regression (boundary +epsilon)', () => {
    const legacy = makeScenarioResult({ scores: makeScores({ overall: 0.8, answerQuality: 0.7 }) });
    const wineSearch = makeScenarioResult({
      scores: makeScores({ overall: 0.8, answerQuality: 0.7 - SHADOW_SCORE_REGRESSION_THRESHOLD - 0.001 }),
    });
    const delta = computeScoreDelta(legacy, wineSearch);
    expect(delta.regressedDimensions).toContain('answerQuality');
  });

  it('small distributed degradation (no dim past threshold, total < 0) → verdict mixed', () => {
    const legacy = makeScenarioResult({ scores: makeScores({ overall: 0.80, answerQuality: 0.7, executionEfficiency: 0.7 }) });
    // small per-dim drop (0.02) below threshold; total drops too.
    const wineSearch = makeScenarioResult({ scores: makeScores({ overall: 0.78, answerQuality: 0.68, executionEfficiency: 0.68 }) });
    const delta = computeScoreDelta(legacy, wineSearch);
    expect(delta.regressedDimensions).toEqual([]);
    expect(delta.totalDelta).toBeLessThan(-SHADOW_SCORE_PARITY_EPSILON);
    expect(decideVerdict(delta)).toBe('mixed');
  });

  it('null-valued dims are skipped (RAGAS dropped semantics)', () => {
    const legacy = makeScenarioResult({ scores: makeScores({ overall: 0.5, faithfulness: null, answerQuality: 0.5 }) });
    const wineSearch = makeScenarioResult({ scores: makeScores({ overall: 0.6, faithfulness: 0.9, answerQuality: 0.6 }) });
    const delta = computeScoreDelta(legacy, wineSearch);
    // faithfulness is null on legacy → dropped from delta map entirely.
    expect(Object.keys(delta.perDimension)).not.toContain('faithfulness');
    expect(delta.perDimension['answerQuality']).toBeCloseTo(0.1, 6);
  });

  it('errored side uses zero sentinel for overall (no NaN propagation)', () => {
    const legacy = makeScenarioResult({ scores: makeScores({ overall: 0.8 }) });
    const errored = makeScenarioResult({ scores: ZERO_DIM_SCORES, error: 'boom' });
    const delta = computeScoreDelta(legacy, errored);
    expect(Number.isFinite(delta.totalDelta)).toBe(true);
    expect(delta.totalDelta).toBeCloseTo(-0.8, 6);
  });
});

// ---------------------------------------------------------------------------
// ShadowModeScorer.scoreOnce
// ---------------------------------------------------------------------------

describe('ShadowModeScorer.scoreOnce', () => {
  it('both sides succeed identically → verdict parity', async () => {
    const report = makeReport({
      legacy: makeOutcome({ orchestrator: 'legacy_agent', answer: 'legacy' }),
      wineSearch: makeOutcome({ orchestrator: 'wine_search', answer: 'wine_search' }),
    });
    const scorer = makeScorer({
      legacy: makeScores({ overall: 0.7, answerQuality: 0.7 }),
      wine_search: makeScores({ overall: 0.7, answerQuality: 0.7 }),
    });
    const composer = new ShadowModeScorer({ runner: makeRunner(report), scorer });
    const out = await composer.scoreOnce({ scenario: makeScenario(), requestId: 'req' });
    expect(out.verdict).toBe('parity');
    expect(out.shadowDiff.requestId).toBe('req');
  });

  it('wine-search beats legacy on every dim → verdict improved', async () => {
    const report = makeReport({
      legacy: makeOutcome({ orchestrator: 'legacy_agent', answer: 'legacy' }),
      wineSearch: makeOutcome({ orchestrator: 'wine_search', answer: 'wine_search' }),
    });
    const scorer = makeScorer({
      legacy: makeScores({ overall: 0.5, answerQuality: 0.5, executionEfficiency: 0.5 }),
      wine_search: makeScores({ overall: 0.85, answerQuality: 0.9, executionEfficiency: 0.85 }),
    });
    const composer = new ShadowModeScorer({ runner: makeRunner(report), scorer });
    const out = await composer.scoreOnce({ scenario: makeScenario(), requestId: 'req' });
    expect(out.verdict).toBe('improved');
    expect(out.scoreDelta.regressedDimensions).toEqual([]);
  });

  it('wine-search worse on one dim past threshold → verdict regressed', async () => {
    const report = makeReport({
      legacy: makeOutcome({ orchestrator: 'legacy_agent', answer: 'legacy' }),
      wineSearch: makeOutcome({ orchestrator: 'wine_search', answer: 'wine_search' }),
    });
    const scorer = makeScorer({
      legacy: makeScores({ overall: 0.7, executionEfficiency: 0.9 }),
      wine_search: makeScores({ overall: 0.5, executionEfficiency: 0.4 }),
    });
    const composer = new ShadowModeScorer({ runner: makeRunner(report), scorer });
    const out = await composer.scoreOnce({ scenario: makeScenario(), requestId: 'req' });
    expect(out.verdict).toBe('regressed');
    expect(out.scoreDelta.regressedDimensions).toContain('executionEfficiency');
  });

  it('legacy errored → verdict still computable (zero sentinel)', async () => {
    const report = makeReport({
      legacy: makeOutcome({
        orchestrator: 'legacy_agent',
        status: 'error',
        answer: undefined,
        errorMessage: 'boom',
      }),
      wineSearch: makeOutcome({ orchestrator: 'wine_search', answer: 'wine_search' }),
    });
    const scorer = makeScorer({
      wine_search: makeScores({ overall: 0.6, answerQuality: 0.6 }),
    });
    const composer = new ShadowModeScorer({ runner: makeRunner(report), scorer });
    const out = await composer.scoreOnce({ scenario: makeScenario(), requestId: 'req' });
    expect(out.legacyScore.error).toBe('boom');
    expect(Number.isFinite(out.scoreDelta.totalDelta)).toBe(true);
  });

  it('Korean query preserved through composer (CLAUDE.md rule 5)', async () => {
    const koreanQuery = '한우와 어울리는 와인 추천해줘';
    const report = makeReport({
      query: koreanQuery,
      queryPreview: koreanQuery,
      legacy: makeOutcome({ orchestrator: 'legacy_agent', answer: '한국어 응답' }),
      wineSearch: makeOutcome({ orchestrator: 'wine_search', answer: '한국어 응답' }),
    });
    const scorer = makeScorer({ '한국어 응답': makeScores({ overall: 0.6 }) });
    const composer = new ShadowModeScorer({ runner: makeRunner(report), scorer });
    const out = await composer.scoreOnce({
      scenario: { ...makeScenario(), query: koreanQuery },
      requestId: 'req',
    });
    expect(out.shadowDiff.query).toBe(koreanQuery);
  });

  it('abortSignal is forwarded to runner.runOnce', async () => {
    const controller = new AbortController();
    const report = makeReport();
    const runOnceSpy = vi.fn(async () => report);
    const composer = new ShadowModeScorer({
      runner: { runOnce: runOnceSpy },
      scorer: makeScorer({}),
    });
    await composer.scoreOnce({
      scenario: makeScenario(),
      requestId: 'req',
      abortSignal: controller.signal,
    });
    const arg = (runOnceSpy.mock.calls[0]?.[0] ?? {}) as { abortSignal?: AbortSignal };
    expect(arg.abortSignal).toBe(controller.signal);
  });

  it('result conforms to ShadowModeScoringReport shape', async () => {
    const report = makeReport();
    const scorer = makeScorer({ a: makeScores({ overall: 0.5 }) });
    const composer = new ShadowModeScorer({ runner: makeRunner(report), scorer });
    const out: ShadowModeScoringReport = await composer.scoreOnce({
      scenario: makeScenario(),
      requestId: 'req',
    });
    expect(out).toHaveProperty('shadowDiff');
    expect(out).toHaveProperty('legacyScore');
    expect(out).toHaveProperty('wineSearchScore');
    expect(out).toHaveProperty('scoreDelta');
    expect(out).toHaveProperty('verdict');
  });
});

// ---------------------------------------------------------------------------
// scoreRawResults (raw-results path)
// ---------------------------------------------------------------------------

describe('scoreRawResults', () => {
  it('produces a verdict when both raw results provided', () => {
    const scorer = makeScorer({
      legacy_answer: makeScores({ overall: 0.6, answerQuality: 0.6 }),
      wine_answer: makeScores({ overall: 0.7, answerQuality: 0.7 }),
    });
    const out = scoreRawResults({
      scorer,
      scenario: makeScenario(),
      legacy: {
        answer: 'legacy_answer',
        steps: [],
        totalDurationMs: 0,
        totalTokens: { input: 0, output: 0 },
        toolCallCount: 0,
        fallbackApplied: false,
        terminationReason: 'answer',
      },
      wineSearch: {
        answer: 'wine_answer',
        layer: 'primary',
        groundedOnToolResults: true,
        toolOutcomes: [],
        executionSteps: [],
        toolCallCount: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        totalDurationMs: 0,
        terminationReason: 'answer',
        policyBlocked: false,
        degradedReason: undefined,
        intent: 'search',
        planKind: 'single-search',
      },
    });
    expect(out.verdict).toBe('improved');
  });

  it('missing one side → that side scored as error sentinel', () => {
    const scorer = makeScorer({
      wine_answer: makeScores({ overall: 0.8 }),
    });
    const out = scoreRawResults({
      scorer,
      scenario: makeScenario(),
      wineSearch: {
        answer: 'wine_answer',
        layer: 'primary',
        groundedOnToolResults: true,
        toolOutcomes: [],
        executionSteps: [],
        toolCallCount: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        totalDurationMs: 0,
        terminationReason: 'answer',
        policyBlocked: false,
        degradedReason: undefined,
        intent: 'search',
        planKind: 'single-search',
      },
    });
    expect(out.legacyScore.error).toBe('no legacy result');
    expect(out.scoreDelta.totalDelta).toBeCloseTo(0.8, 6);
  });
});

// ---------------------------------------------------------------------------
// End-to-end provenance: observations flow into ScenarioExecution and drive
// the bench scorer's contextRecall dimension (Gap-4 close-out).
//
// These tests use the REAL `scoreScenario` (not a mock) so they prove the
// full chain: runner outcome.observations → projectOutcome → ScenarioExecution
// → scorer.contextRecall. faithfulness in `scoreScenario` derives from the
// injected `faithfulnessScore` param (LLM judge), so the observation-driven
// dimension we can assert deterministically here is contextRecall; a separate
// capturing-scorer test below proves observations reach the execution object
// that faithfulness scoring consumes downstream.
// ---------------------------------------------------------------------------

/**
 * Production wiring shape — threads the composer's judge / faithfulness args
 * into the real scoreScenario positions:
 * `scoreScenario(scenario, execution, judgeScore, faithfulnessScore, error, undefined, judgeReasoning)`.
 * judge/faithfulness are undefined unless a judge is wired into the composer.
 */
const realScorer: BenchScorerFn = (
  scenario,
  execution,
  error,
  judgeScore,
  faithfulnessScore,
  judgeReasoning,
) =>
  scoreScenario(
    scenario,
    execution,
    judgeScore,
    faithfulnessScore,
    error,
    undefined,
    judgeReasoning,
  );

function makeGoldenScenario(): AgentBenchmarkScenario {
  const expectation: ScenarioExpectation = { maxSteps: 5 };
  return {
    id: 42,
    tier: 'single_shot',
    query: '바롤로 추천',
    description: 'context-recall fixture with golden keywords',
    expectation,
    goldenKeywords: ['barolo', 'nebbiolo'],
  };
}

function makeReportWithObservations(
  legacyObs: readonly string[],
  wineSearchObs: readonly string[],
): ShadowModeReport {
  return makeReport({
    legacy: makeOutcome({
      orchestrator: 'legacy_agent',
      answer: 'Barolo from Nebbiolo grapes',
      observations: [...legacyObs],
    }),
    wineSearch: makeOutcome({
      orchestrator: 'wine_search',
      answer: 'Barolo from Nebbiolo grapes',
      observations: [...wineSearchObs],
    }),
  });
}

describe('observation provenance → contextRecall (real scorer)', () => {
  it('contextRecall is NON-NULL when observations contain golden keywords', async () => {
    const report = makeReportWithObservations(
      ['Barolo is made from Nebbiolo in Piedmont'],
      ['Barolo is made from Nebbiolo in Piedmont'],
    );
    const scorer = new ShadowModeScorer({
      runner: makeRunner(report),
      scorer: realScorer,
    });
    const out: ShadowModeScoringReport = await scorer.scoreOnce({
      scenario: makeGoldenScenario(),
      requestId: 'req-e2e-recall',
    });
    // Both golden keywords (barolo, nebbiolo) appear → recall = 1.0, non-null.
    expect(out.legacyScore.scores.contextRecall).not.toBeNull();
    expect(out.legacyScore.scores.contextRecall).toBeCloseTo(1, 6);
    expect(out.wineSearchScore.scores.contextRecall).not.toBeNull();
    expect(out.wineSearchScore.scores.contextRecall).toBeCloseTo(1, 6);
  });

  it('contextRecall is NULL when observations are empty (no grounding surface)', async () => {
    const report = makeReportWithObservations([], []);
    const scorer = new ShadowModeScorer({
      runner: makeRunner(report),
      scorer: realScorer,
    });
    const out = await scorer.scoreOnce({
      scenario: makeGoldenScenario(),
      requestId: 'req-e2e-norecall',
    });
    // No observations → scorer drops contextRecall from the geo-mean (null).
    expect(out.legacyScore.scores.contextRecall).toBeNull();
    expect(out.wineSearchScore.scores.contextRecall).toBeNull();
  });

  it('partial keyword coverage → fractional, finite contextRecall', async () => {
    const report = makeReportWithObservations(
      ['Barolo is a great wine'], // contains "barolo" only, missing "nebbiolo"
      ['Barolo is a great wine'],
    );
    const scorer = new ShadowModeScorer({
      runner: makeRunner(report),
      scorer: realScorer,
    });
    const out = await scorer.scoreOnce({
      scenario: makeGoldenScenario(),
      requestId: 'req-e2e-partial',
    });
    expect(out.legacyScore.scores.contextRecall).toBeCloseTo(0.5, 6);
    expect(out.wineSearchScore.scores.contextRecall).toBeCloseTo(0.5, 6);
  });
});

describe('projection propagates observations to ScenarioExecution', () => {
  it('projectLegacy / projectWineSearch forward outcome.observations to the scorer', async () => {
    const captured: Array<readonly string[] | null> = [];
    const capturingScorer: BenchScorerFn = (scenario, execution) => {
      captured.push(execution === null ? null : execution.observations);
      return makeScenarioResult({ id: scenario.id, scores: makeScores({ overall: 0.5 }) });
    };
    const report = makeReportWithObservations(['legacy-grounding'], ['wine-grounding']);
    const scorer = new ShadowModeScorer({
      runner: makeRunner(report),
      scorer: capturingScorer,
    });
    await scorer.scoreOnce({ scenario: makeScenario(), requestId: 'req-capture' });
    // Scorer invoked legacy first, then wine-search (scoreOnce ordering).
    expect(captured).toEqual([['legacy-grounding'], ['wine-grounding']]);
  });

  it('defaults to [] when outcome.observations is absent (pre-Gap-4 report)', async () => {
    const captured: Array<readonly string[] | null> = [];
    const capturingScorer: BenchScorerFn = (scenario, execution) => {
      captured.push(execution === null ? null : execution.observations);
      return makeScenarioResult({ id: scenario.id });
    };
    // Outcomes without an `observations` field (optional in the schema).
    const report = makeReport({
      legacy: makeOutcome({ orchestrator: 'legacy_agent', answer: 'a' }),
      wineSearch: makeOutcome({ orchestrator: 'wine_search', answer: 'a' }),
    });
    expect(report.legacy.observations).toBeUndefined();
    const scorer = new ShadowModeScorer({
      runner: makeRunner(report),
      scorer: capturingScorer,
    });
    await scorer.scoreOnce({ scenario: makeScenario(), requestId: 'req-default' });
    expect(captured).toEqual([[], []]);
  });
});

// ---------------------------------------------------------------------------
// LlmJudge wiring → judge + faithfulness dimensions populate (real scorer)
// ---------------------------------------------------------------------------

// Reuses the `realScorer` defined above (production wiring shape) which now
// threads judge / faithfulness args into the real scoreScenario.

/** Stub judge: returns fixed scores, records each call's input. */
function makeJudge(
  byAnswer: Readonly<Record<string, { score: number; faithfulness: number }>>,
  calls?: JudgeInput[],
): LlmJudge {
  return {
    evaluate: async (input: JudgeInput): Promise<JudgeResult> => {
      calls?.push(input);
      const hit = byAnswer[input.answer];
      if (hit === undefined) {
        return { available: false, reason: 'unexpected', tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } };
      }
      return {
        available: true,
        score: hit.score,
        faithfulness: hit.faithfulness,
        reasoning: 'stub',
        tokenUsage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 0, cacheCreationTokens: 0 },
      };
    },
  };
}

describe('LlmJudge wiring (real scorer)', () => {
  it('WITHOUT judge → judge + faithfulness dims stay null', async () => {
    const report = makeReportWithObservations(['Barolo Nebbiolo'], ['Barolo Nebbiolo']);
    const scorer = new ShadowModeScorer({ runner: makeRunner(report), scorer: realScorer });
    const out = await scorer.scoreOnce({ scenario: makeScenario(), requestId: 'no-judge' });
    expect(out.legacyScore.scores.judge).toBeNull();
    expect(out.legacyScore.scores.faithfulness).toBeNull();
    expect(out.wineSearchScore.scores.judge).toBeNull();
    expect(out.wineSearchScore.scores.faithfulness).toBeNull();
  });

  it('WITH judge → judge + faithfulness dims non-null on both sides', async () => {
    const report = makeReportWithObservations(['Barolo Nebbiolo'], ['Barolo Nebbiolo']);
    const judge = makeJudge({ 'Barolo from Nebbiolo grapes': { score: 0.8, faithfulness: 0.7 } });
    const scorer = new ShadowModeScorer({ runner: makeRunner(report), scorer: realScorer, judge });
    const out = await scorer.scoreOnce({ scenario: makeScenario(), requestId: 'with-judge' });
    expect(out.legacyScore.scores.judge).not.toBeNull();
    expect(out.legacyScore.scores.faithfulness).toBe(0.7);
    expect(out.wineSearchScore.scores.judge).not.toBeNull();
    expect(out.wineSearchScore.scores.faithfulness).toBe(0.7);
  });

  it('judge runs per-side independently — each side gets its own answer + observations', async () => {
    const calls: JudgeInput[] = [];
    const report = makeReport({
      legacy: makeOutcome({ orchestrator: 'legacy_agent', answer: 'legacy answer', observations: ['legacy-obs'] }),
      wineSearch: makeOutcome({ orchestrator: 'wine_search', answer: 'wine answer', observations: ['wine-obs'] }),
    });
    const judge = makeJudge(
      { 'legacy answer': { score: 0.6, faithfulness: 0.6 }, 'wine answer': { score: 0.9, faithfulness: 0.8 } },
      calls,
    );
    const scorer = new ShadowModeScorer({ runner: makeRunner(report), scorer: realScorer, judge });
    const out = await scorer.scoreOnce({ scenario: makeScenario(), requestId: 'per-side' });
    expect(calls.map((c) => c.answer)).toEqual(['legacy answer', 'wine answer']);
    expect(calls.map((c) => c.groundingObservations)).toEqual([['legacy-obs'], ['wine-obs']]);
    expect(out.legacyScore.scores.faithfulness).toBe(0.6);
    expect(out.wineSearchScore.scores.faithfulness).toBe(0.8);
  });

  it('judge unavailable on one side → that side stays null, other side populates', async () => {
    const report = makeReport({
      legacy: makeOutcome({ orchestrator: 'legacy_agent', answer: 'good', observations: ['o'] }),
      wineSearch: makeOutcome({ orchestrator: 'wine_search', answer: 'bad', observations: ['o'] }),
    });
    // Only 'good' is judged; 'bad' falls through to the unavailable sentinel.
    const judge = makeJudge({ good: { score: 0.85, faithfulness: 0.9 } });
    const scorer = new ShadowModeScorer({ runner: makeRunner(report), scorer: realScorer, judge });
    const out = await scorer.scoreOnce({ scenario: makeScenario(), requestId: 'partial-judge' });
    expect(out.legacyScore.scores.faithfulness).toBe(0.9);
    expect(out.wineSearchScore.scores.judge).toBeNull();
    expect(out.wineSearchScore.scores.faithfulness).toBeNull();
  });

  it('rubric is forwarded to the judge when provided', async () => {
    const calls: JudgeInput[] = [];
    const report = makeReportWithObservations(['o'], ['o']);
    const judge = makeJudge({ 'Barolo from Nebbiolo grapes': { score: 0.7, faithfulness: 0.7 } }, calls);
    const scorer = new ShadowModeScorer({ runner: makeRunner(report), scorer: realScorer, judge });
    await scorer.scoreOnce({ scenario: makeScenario(), requestId: 'rubric', rubric: 'must cite vintage' });
    expect(calls.every((c) => c.rubric === 'must cite vintage')).toBe(true);
  });

  it('errored side is NOT judged (no answer to judge)', async () => {
    const calls: JudgeInput[] = [];
    const report = makeReport({
      legacy: makeOutcome({ orchestrator: 'legacy_agent', status: 'error', errorMessage: 'boom' }),
      wineSearch: makeOutcome({ orchestrator: 'wine_search', answer: 'ok', observations: ['o'] }),
    });
    const judge = makeJudge({ ok: { score: 0.8, faithfulness: 0.8 } }, calls);
    const scorer = new ShadowModeScorer({ runner: makeRunner(report), scorer: realScorer, judge });
    await scorer.scoreOnce({ scenario: makeScenario(), requestId: 'err-side' });
    // Only the wine-search side reached the judge.
    expect(calls.map((c) => c.answer)).toEqual(['ok']);
  });
});
