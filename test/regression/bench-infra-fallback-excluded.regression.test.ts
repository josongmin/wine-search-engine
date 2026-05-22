/**
 * Regression (FIX A2): INFRA-FALLBACK scenarios must be excluded from the
 * benchmark's headline aggregates while remaining visible in `results[]`.
 *
 * Background:
 *   A step-0 `fallback` termination means the LLM was unavailable (rate-limit /
 *   timeout / provider 5xx) BEFORE the agent ran a single step. The agent never
 *   executed its own logic, so the resulting `score=0` measures the provider's
 *   outage, not the agent. One such scenario previously dragged `overallScore`
 *   down AND exploded the bootstrap CI (observed 21.6–80.1%, ~58pp width from a
 *   single infra-failed scenario), and inflated `criticalFailureCount`.
 *
 * Contract:
 *   - `isInfraFallbackResult` recognizes `terminationReason==='fallback' &&
 *     stepCount===0` (and nothing else).
 *   - `buildReport` EXCLUDES infra-fallback results from `overallScore`,
 *     `overallBootstrapCi95`, `overallCi95`, and `criticalFailureCount`,
 *     exactly the way `judgeRequiredButSkipped` scenarios are excluded.
 *   - Infra-fallback results REMAIN in `report.results[]` and are still counted
 *     in `report.infraFallbackCount`.
 *   - The aggregate-eligible (non-infra) scenarios drive `overallScore`.
 *
 * The test constructs a synthetic batch (no real infra) and drives the exported
 * `buildReport` factory directly.
 *
 * Append-only regression suite — never delete cases.
 */
import { describe, it, expect } from 'vitest';
import {
  buildReport,
  isInfraFallbackResult,
  type BenchmarkWallClock,
} from '../benchmark/agent/runner.js';
import type { ScenarioResult, ScenarioScores } from '../benchmark/agent/scorer.js';
import type { AgentBenchmarkScenario } from '../benchmark/agent/scenario.js';

const ZERO_SCORES_BASE: ScenarioScores = {
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
  extractedHardConstraintCount: null,
};

interface ResultOpts {
  readonly id: number;
  readonly overall: number;
  readonly criticalFailure?: boolean;
  readonly terminationReason: string;
  readonly stepCount: number;
  readonly hardConstraintCount?: number | null;
}

function makeResult(opts: ResultOpts): ScenarioResult {
  return {
    id: opts.id,
    tier: 'single_shot',
    query: `q${opts.id}`,
    skipped: false,
    stepCount: opts.stepCount,
    toolCallCount: opts.stepCount,
    terminationReason: opts.terminationReason,
    totalDurationMs: 1000,
    totalTokens: { input: 100, output: 50 },
    ...(opts.hardConstraintCount !== undefined ? { hardConstraintCount: opts.hardConstraintCount } : {}),
    scores: {
      ...ZERO_SCORES_BASE,
      overall: opts.overall,
      criticalFailure: opts.criticalFailure ?? false,
    },
    judgeRequiredButSkipped: false,
  };
}

const WALL_CLOCK: BenchmarkWallClock = {
  initMs: 0,
  scenariosPhaseMs: 0,
  shutdownMs: 0,
  totalMs: 0,
  meanScenarioWallMs: 0,
  sumScenarioWallMs: 0,
  scenarioWallSampleCount: 0,
  concurrency: 1,
};

// buildReport only reads `args.container`, `args.judgeSamples`, `args.runs`,
// and `args.seed` from CliArgs — a minimal cast is sufficient for this test.
const ARGS = {
  container: 'real',
  judgeSamples: 1,
  runs: 1,
  enableJudge: true,
  concurrency: 1,
  maxRetries: 1,
} as unknown as Parameters<typeof buildReport>[6];

const SCENARIOS: readonly AgentBenchmarkScenario[] = [];

describe('isInfraFallbackResult — step-0 fallback detector', () => {
  it('R-INFRA-01: terminationReason=fallback + stepCount=0 is an infra fallback', () => {
    expect(isInfraFallbackResult(makeResult({ id: 56, overall: 0, terminationReason: 'fallback', stepCount: 0 }))).toBe(true);
  });

  it('R-INFRA-02: fallback with stepCount>0 is NOT infra (agent ran, then fell back)', () => {
    expect(isInfraFallbackResult(makeResult({ id: 1, overall: 0.4, terminationReason: 'fallback', stepCount: 3 }))).toBe(false);
  });

  it('R-INFRA-03: normal answer termination is NOT infra', () => {
    expect(isInfraFallbackResult(makeResult({ id: 2, overall: 0.9, terminationReason: 'answer', stepCount: 2 }))).toBe(false);
  });

  it('R-INFRA-04: undefined stepCount (legacy/error result) is NOT infra', () => {
    const r: ScenarioResult = {
      id: 3,
      tier: 'single_shot',
      query: 'q3',
      skipped: false,
      terminationReason: 'fallback',
      scores: ZERO_SCORES_BASE,
      judgeRequiredButSkipped: false,
    };
    expect(isInfraFallbackResult(r)).toBe(false);
  });
});

describe('buildReport — INFRA-FALLBACK excluded from headline aggregates (FIX A2)', () => {
  // One infra fallback (score 0, critical-shaped) + three healthy scenarios.
  const infra = makeResult({ id: 56, overall: 0, criticalFailure: true, terminationReason: 'fallback', stepCount: 0 });
  const normalA = makeResult({ id: 1, overall: 0.9, terminationReason: 'answer', stepCount: 2 });
  const normalB = makeResult({ id: 2, overall: 0.8, terminationReason: 'answer', stepCount: 2 });
  const normalC = makeResult({ id: 3, overall: 0.85, terminationReason: 'answer', stepCount: 2 });
  const results = [infra, normalA, normalB, normalC];

  const report = buildReport(
    results,
    SCENARIOS,
    'test-model',
    'test-judge', // judge available → judgeRequired exclusion path not triggered
    'test-embed',
    'api.test',
    ARGS,
    0,
    0,
    WALL_CLOCK,
    1, // infraFallbackCount
  );

  it('R-INFRA-05: overallScore is the mean of the non-infra scenarios only', () => {
    // Mean over {0.9, 0.8, 0.85} = 0.85. The infra 0 is excluded.
    expect(report.summary.overallScore).toBeCloseTo(0.85, 6);
  });

  it('R-INFRA-06: including the infra 0 would have lowered overallScore — proving exclusion matters', () => {
    const naiveMeanWithInfra = (0 + 0.9 + 0.8 + 0.85) / 4; // 0.6375
    expect(report.summary.overallScore).toBeGreaterThan(naiveMeanWithInfra);
  });

  it('R-INFRA-07: criticalFailureCount excludes the infra fallback', () => {
    // The infra fallback carries criticalFailure=true but must NOT be counted.
    expect(report.criticalFailureCount).toBe(0);
  });

  it('R-INFRA-08: the infra fallback REMAINS visible in results[] and infraFallbackCount', () => {
    expect(report.results.map((r) => r.id)).toContain(56);
    expect(report.infraFallbackCount).toBe(1);
  });

  it('R-INFRA-09: bootstrap CI mean reflects the non-infra population (no infra-0 contamination)', () => {
    // The bootstrap resamples from {0.9, 0.8, 0.85}; its mean stays near 0.85,
    // far from the ~0.64 that an infra-0-contaminated sample would produce, and
    // the interval is narrow (the 58pp blow-up came entirely from the infra 0).
    expect(report.summary.overallBootstrapCi95.mean).toBeGreaterThan(0.75);
    const width = report.summary.overallBootstrapCi95.upper - report.summary.overallBootstrapCi95.lower;
    expect(width).toBeLessThan(0.3);
  });

  it('R-INFRA-10: a critical failure in a NON-infra scenario is still counted', () => {
    const withRealCritical = buildReport(
      [
        makeResult({ id: 56, overall: 0, criticalFailure: true, terminationReason: 'fallback', stepCount: 0 }),
        makeResult({ id: 22, overall: 0, criticalFailure: true, terminationReason: 'answer', stepCount: 1 }),
        normalA,
      ],
      SCENARIOS,
      'test-model',
      'test-judge',
      'test-embed',
      'api.test',
      ARGS,
      0,
      0,
      WALL_CLOCK,
      1,
    );
    // Only #22 (a real agent critical failure) is counted; #56 (infra) is not.
    expect(withRealCritical.criticalFailureCount).toBe(1);
  });
});

describe('buildReport — meanHardConstraints reflects aggregated per-scenario counts (FIX B3)', () => {
  it('R-INFRA-11: meanHardConstraints is non-null and equals the mean of per-scenario hardConstraintCount', () => {
    // Two scenarios with known planner hard-constraint sums: 2 and 4.
    // A third with null (no search outcomes) is dropped from the denominator.
    const results = [
      makeResult({ id: 1, overall: 0.9, terminationReason: 'answer', stepCount: 2, hardConstraintCount: 2 }),
      makeResult({ id: 2, overall: 0.8, terminationReason: 'answer', stepCount: 2, hardConstraintCount: 4 }),
      makeResult({ id: 3, overall: 0.85, terminationReason: 'answer', stepCount: 0, hardConstraintCount: null }),
    ];
    const report = buildReport(
      results,
      SCENARIOS,
      'test-model',
      'test-judge',
      'test-embed',
      'api.test',
      ARGS,
      0,
      0,
      WALL_CLOCK,
      0,
    );
    // Mean over the non-null samples {2, 4} = 3 — NOT 0 (the old hardcoded bug).
    expect(report.summary.meanHardConstraints).not.toBeNull();
    expect(report.summary.meanHardConstraints).toBeCloseTo(3, 6);
  });

  it('R-INFRA-12: a scenario with hardConstraintCount=0 (search ran, no hard constraints) participates in the mean', () => {
    const results = [
      makeResult({ id: 1, overall: 0.9, terminationReason: 'answer', stepCount: 2, hardConstraintCount: 0 }),
      makeResult({ id: 2, overall: 0.8, terminationReason: 'answer', stepCount: 2, hardConstraintCount: 4 }),
    ];
    const report = buildReport(
      results,
      SCENARIOS,
      'test-model',
      'test-judge',
      'test-embed',
      'api.test',
      ARGS,
      0,
      0,
      WALL_CLOCK,
      0,
    );
    // Mean over {0, 4} = 2 — the zero is a real under-filtered signal, not excluded.
    expect(report.summary.meanHardConstraints).toBeCloseTo(2, 6);
  });
});
