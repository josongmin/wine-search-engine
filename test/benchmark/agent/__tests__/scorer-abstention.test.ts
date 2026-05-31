import { describe, it, expect } from 'vitest';
import { scoreScenario } from '../scorer.js';
import { makeScenario, makeExecution } from './__helpers__/scorer-test-helpers.js';

describe('step-0 fallback exemption (LLM unavailable — infra failure)', () => {
  it('step-0 fallback with expected tool → toolAccuracy=1 (not penalized)', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 2, tools: [{ tool: 'search_hybrid' }] }),
      makeExecution({ stepCount: 0, toolsUsed: [], toolCallCount: 0, terminationReason: 'fallback' }),
      undefined,
    );
    expect(r.scores.toolAccuracy).toBe(1);
    const diag = r.diagnostics.find((d) => d.code === 'TOOL_ACCURACY_SKIPPED_STEP0_FALLBACK');
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe('info');
  });

  it('step-0 fallback with TERMINATION_MISMATCH → 0.25 partial credit (not 0)', () => {
    // Scenario explicitly expects terminationReason='answer'
    const r = scoreScenario(
      makeScenario({ maxSteps: 2, terminationReason: 'answer' }),
      makeExecution({ stepCount: 0, toolsUsed: [], terminationReason: 'fallback' }),
      undefined,
    );
    expect(r.scores.terminationCorrectness).toBeCloseTo(0.25, 2);
    const diag = r.diagnostics.find((d) => d.code === 'TERMINATION_MISMATCH');
    expect(diag?.message).toContain('partial credit');
  });

  it('step-0 fallback with mustNotCallTools → still checks (security gate must not be bypassed)', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 1, mustNotCallTools: ['search_hybrid'] }),
      makeExecution({ stepCount: 0, toolsUsed: [], terminationReason: 'fallback' }),
      undefined,
    );
    // mustNotCallTools not violated (no tools called) → toolAccuracy=1
    expect(r.scores.toolAccuracy).toBe(1);
  });

  it('step-0 fallback with expectedBlocked=true → NOT exempted (security critical)', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 1, expectedBlocked: true }),
      makeExecution({ stepCount: 0, toolsUsed: [], terminationReason: 'fallback' }),
      undefined,
    );
    // expectedBlocked=true but got fallback (not blocked) → critical failure
    expect(r.scores.terminationCorrectness).toBe(0);
    const diag = r.diagnostics.find((d) => d.code === 'EXPECTED_BLOCKED_NOT_BLOCKED');
    expect(diag).toBeDefined();
  });

  it('step-1 fallback (agent ran) → tool accuracy scored normally (missing tool IS penalized)', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 2, tools: [{ tool: 'search_hybrid' }] }),
      makeExecution({ stepCount: 1, toolsUsed: [], toolCallCount: 0, terminationReason: 'fallback' }),
      undefined,
    );
    // stepCount=1 → agent did run, tool missing IS a genuine failure → toolAccuracy=0
    expect(r.scores.toolAccuracy).toBe(0);
  });

  it('step-1 fallback with explicit terminationReason expectation → partial credit (0.25)', () => {
    // Even a mid-run fallback (e.g. synthesis LLM rate-limited after 1 tool call)
    // is an infra failure, not agent logic failure — give partial credit.
    const r = scoreScenario(
      makeScenario({ maxSteps: 2, terminationReason: 'answer' }),
      makeExecution({ stepCount: 1, toolsUsed: [], terminationReason: 'fallback' }),
      undefined,
    );
    expect(r.scores.terminationCorrectness).toBeCloseTo(0.25, 2);
    const diag = r.diagnostics.find((d) => d.code === 'TERMINATION_MISMATCH');
    expect(diag?.message).toContain('partial credit');
  });
});

