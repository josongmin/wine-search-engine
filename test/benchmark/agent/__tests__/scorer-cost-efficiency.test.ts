import { describe, it, expect } from 'vitest';
import { scoreScenario } from '../scorer.js';
import { makeScenario, makeExecution } from './__helpers__/scorer-test-helpers.js';

describe('scoreCostEfficiency', () => {
  it('within default budget → 1', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ totalDurationMs: 3_000, totalTokens: { input: 1_000, output: 500 } }),
      undefined,
    );
    expect(r.scores.costEfficiency).toBe(1);
  });

  it('latency overshoot penalises', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, maxDurationMs: 1_000 }),
      makeExecution({ totalDurationMs: 1_500, totalTokens: { input: 100, output: 100 } }),
      undefined,
    );
    // max-overshoot model: durOvershoot = 500/1000 = 0.5 → cost = 1 - 0.5 = 0.5
    expect(r.scores.costEfficiency).toBeCloseTo(0.5, 3);
  });

  it('token overshoot penalises', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, maxTotalTokens: 1_000 }),
      makeExecution({ totalDurationMs: 100, totalTokens: { input: 800, output: 800 } }),
      undefined,
    );
    // max-overshoot model: tokOvershoot = 600/1000 = 0.6 → cost = 1 - 0.6 = 0.4
    expect(r.scores.costEfficiency).toBeCloseTo(0.4, 3);
  });

  it('Infinity budget disables the check', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        maxDurationMs: Number.POSITIVE_INFINITY,
        maxTotalTokens: Number.POSITIVE_INFINITY,
      }),
      makeExecution({ totalDurationMs: 999_999, totalTokens: { input: 99_999, output: 99_999 } }),
      undefined,
    );
    expect(r.scores.costEfficiency).toBe(1);
  });

  // S1.1: latency dimension MUST score against agentWorkMs (throttle-corrected),
  // not raw totalDurationMs/wall, so provider 429/503 backoff never penalizes.
  it('latency scores agentWorkMs when present, ignoring throttle-inflated totalDurationMs', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, maxDurationMs: 1_000 }),
      // totalDurationMs blown to 5x budget (throttle) but agentWorkMs within budget.
      makeExecution({
        totalDurationMs: 5_000,
        agentWorkMs: 800,
        totalTokens: { input: 100, output: 100 },
      }),
      undefined,
    );
    expect(r.scores.costEfficiency).toBe(1);
  });

  it('latency penalises agentWorkMs overshoot even when totalDurationMs is small', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, maxDurationMs: 1_000 }),
      makeExecution({
        totalDurationMs: 100,
        agentWorkMs: 1_500, // 0.5x overshoot → cost 0.5
        totalTokens: { input: 100, output: 100 },
      }),
      undefined,
    );
    expect(r.scores.costEfficiency).toBeCloseTo(0.5, 3);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Overall score (geometric mean)
// ─────────────────────────────────────────────────────────────────────

