import { describe, it, expect } from 'vitest';
import { scoreScenario } from '../scorer.js';
import { makeScenario, makeExecution } from './__helpers__/scorer-test-helpers.js';

describe('scoreStepEfficiency', () => {
  it('full credit when within budget', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ stepCount: 3 }),
      undefined,
    );
    expect(r.scores.stepEfficiency).toBe(1);
  });

  it('penalises overshoot proportionally', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 4 }),
      makeExecution({ stepCount: 6 }),
      undefined,
    );
    // 1 - (6-4)/4 = 0.5
    expect(r.scores.stepEfficiency).toBe(0.5);
  });

  it('zero at 2x budget', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 3 }),
      makeExecution({ stepCount: 6 }),
      undefined,
    );
    expect(r.scores.stepEfficiency).toBe(0);
  });

  it('NaN-safe: invalid stepCount → 0', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ stepCount: Number.NaN }),
      undefined,
    );
    expect(r.scores.stepEfficiency).toBe(0);
  });

  it('maxSteps=0: passes only when stepCount=0', () => {
    const passed = scoreScenario(
      makeScenario({ maxSteps: 0 }),
      makeExecution({ stepCount: 0 }),
      undefined,
    );
    expect(passed.scores.stepEfficiency).toBe(1);

    const failed = scoreScenario(
      makeScenario({ maxSteps: 0 }),
      makeExecution({ stepCount: 1 }),
      undefined,
    );
    expect(failed.scores.stepEfficiency).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Answer quality
// ─────────────────────────────────────────────────────────────────────

