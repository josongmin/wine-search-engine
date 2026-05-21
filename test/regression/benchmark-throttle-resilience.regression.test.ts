/**
 * S1.1 regression — throttle-resilient timing in the agent benchmark harness.
 *
 * Invariants under test:
 *  - `withRetry` retries retryable infra failures (e.g. 503) and eventually succeeds.
 *  - The wrapper returns the resolved value plus a `throttleWaitMs` field that
 *    accumulates the backoff sleep time.
 *  - The latency/cost scorer dimension scores against `agentWorkMs` (agent work),
 *    NOT raw wall — so throttle backoff is EXCLUDED from the latency penalty.
 *
 * These are the measurement-integrity guarantees that make a 69.8%-vs-63.6%
 * comparison trustworthy: infra throttling must never masquerade as agent latency.
 */
import { describe, expect, it, vi } from 'vitest';
import { withRetry } from '../benchmark/agent/runner.js';
import { scoreScenario, type ScenarioExecution } from '../benchmark/agent/scorer.js';
import type { AgentBenchmarkScenario } from '../benchmark/agent/scenario.js';

describe('S1.1 throttle-resilient timing — withRetry', () => {
  it('retries twice on 503 then succeeds, recording throttle wait', async () => {
    const fn = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('HTTP 503 Service Unavailable'))
      .mockRejectedValueOnce(new Error('HTTP 503 Service Unavailable'))
      .mockResolvedValueOnce('answer');

    // shouldRetry mirrors the runner's isTransient for 503.
    const outcome = await withRetry(
      fn,
      3,
      (err) => err instanceof Error && err.message.toLowerCase().includes('503'),
    );

    expect(outcome.value).toBe('answer');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
    // Two backoff sleeps happened → throttleWaitMs is tracked (>= 0; full jitter
    // can yield very small sleeps, so assert it is a finite non-negative number).
    expect(Number.isFinite(outcome.throttleWaitMs)).toBe(true);
    expect(outcome.throttleWaitMs).toBeGreaterThanOrEqual(0);
  });

  it('does not retry non-retryable errors and records zero throttle wait', async () => {
    const fn = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('HTTP 400 Bad Request'));

    await expect(
      withRetry(fn, 3, (err) => err instanceof Error && err.message.includes('503')),
    ).rejects.toThrow('400');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('succeeds first try → throttleWaitMs is exactly zero', async () => {
    const outcome = await withRetry(async () => 'ok', 3, () => true);
    expect(outcome.value).toBe('ok');
    expect(outcome.throttleWaitMs).toBe(0);
  });
});

describe('S1.1 measurement integrity — latency scores agentWorkMs, not throttle wall', () => {
  function makeScenario(maxDurationMs: number): AgentBenchmarkScenario {
    return {
      id: 9001,
      tier: 'single_shot',
      description: 'throttle latency isolation',
      query: 'test',
      expectation: {
        // Only a latency budget — cost dimension is the one we want to probe.
        maxDurationMs,
      },
    } as unknown as AgentBenchmarkScenario;
  }

  function makeExecution(opts: {
    totalDurationMs: number;
    agentWorkMs?: number;
  }): ScenarioExecution {
    return {
      answer: 'A wine answer.',
      stepCount: 1,
      toolCallCount: 1,
      toolsUsed: [{ tool: 'search_wines', input: '{}' }],
      observations: ['some observation'],
      terminationReason: 'answer',
      totalDurationMs: opts.totalDurationMs,
      ...(opts.agentWorkMs !== undefined ? { agentWorkMs: opts.agentWorkMs } : {}),
      totalTokens: { input: 100, output: 100 },
    };
  }

  it('throttled run: agentWorkMs within budget scores full cost even though wall blew the budget', () => {
    const budget = 25_000;
    // Wall (totalDurationMs as a proxy) was 80s purely from throttle backoff, but
    // the agent's actual work was 8s. Scoring agentWorkMs must NOT penalize.
    const execution = makeExecution({ totalDurationMs: 80_000, agentWorkMs: 8_000 });
    const result = scoreScenario(makeScenario(budget), execution, undefined, undefined);

    expect(result.scores.costEfficiency).toBe(1);
    // The result also surfaces agentWorkMs for the report.
    expect(result.agentWorkMs).toBe(8_000);
    // No latency-budget diagnostic should fire — agent work was within budget.
    const latencyDiag = result.diagnostics?.find(
      (d) => d.code === 'LATENCY_BUDGET_EXCEEDED' || d.code === 'LATENCY_BUDGET_BLOWN',
    );
    expect(latencyDiag).toBeUndefined();
  });

  it('genuinely slow agent (no throttle): agentWorkMs over budget DOES penalize cost', () => {
    const budget = 25_000;
    // Agent itself took 50s (2x budget) with no throttling → cost must drop.
    const execution = makeExecution({ totalDurationMs: 50_000, agentWorkMs: 50_000 });
    const result = scoreScenario(makeScenario(budget), execution, undefined, undefined);

    expect(result.scores.costEfficiency).toBeLessThan(1);
    const latencyDiag = result.diagnostics?.find(
      (d) => d.code === 'LATENCY_BUDGET_EXCEEDED' || d.code === 'LATENCY_BUDGET_BLOWN',
    );
    expect(latencyDiag).toBeDefined();
  });

  it('legacy execution without agentWorkMs falls back to totalDurationMs', () => {
    const budget = 25_000;
    const execution = makeExecution({ totalDurationMs: 50_000 });
    const result = scoreScenario(makeScenario(budget), execution, undefined, undefined);
    // Falls back to totalDurationMs (50s > 25s budget) → penalized.
    expect(result.scores.costEfficiency).toBeLessThan(1);
  });
});
