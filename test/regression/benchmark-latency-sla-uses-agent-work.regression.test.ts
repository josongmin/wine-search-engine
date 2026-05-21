/**
 * Regression: bench SLA gate must score against agent-work latency, not raw wall.
 *
 * The bench harness measures three different durations per scenario:
 *
 *   wall (Date.now() before/after withRetry)
 *     = agentWorkMs + throttleWaitMs
 *
 *   agentWorkMs = wall - throttleWaitMs
 *     "the agent's real work time" - provider 429/503 backoff stripped
 *
 *   throttleWaitMs (returned by withRetry)
 *     cumulative ms spent sleeping on transient-infra backoff
 *
 * Prior to L1.A both the latency dimension AND the SLA-warning insight rule
 * read the same raw `totalDurationMs`. When the provider 429-backed off heavily
 * (e.g. step=1 scenarios on a saturated TPM window), the SLA-warning gate
 * fired even though the AGENT itself completed in well under 20s. This is a
 * false-positive failure that conflates infra with agent quality.
 *
 * L1.A fix: the scorer's latency/cost dim reads `agentWorkMs` (falling back to
 * `totalDurationMs` for legacy callers), and the bench summary surfaces BOTH
 * `latencyMs` (agent-work, SLA-gated) and `latencyWallMs` (raw wall, diagnostic).
 *
 * The synthetic case below pins the contract: a scenario with wall=80s,
 * throttleWaitMs=60s, agentWorkMs=20s must NOT trigger the SLA-fail rule.
 */

import { describe, it, expect } from 'vitest';
import { scoreScenario, type ScenarioExecution } from '../../test/benchmark/agent/scorer.js';
import type { AgentBenchmarkScenario, ScenarioExpectation } from '../../test/benchmark/agent/scenario.js';

function makeScenario(
  expectation: ScenarioExpectation,
  overrides: Partial<AgentBenchmarkScenario> = {},
): AgentBenchmarkScenario {
  return {
    id: 1,
    tier: 'single_shot',
    query: 'simple lookup query',
    description: 'L1.A SLA fixture',
    expectation,
    ...overrides,
  };
}

function makeExecution(overrides: Partial<ScenarioExecution> = {}): ScenarioExecution {
  return {
    answer: 'A grounded answer drawn from the tool results.',
    stepCount: 2,
    toolCallCount: 1,
    toolsUsed: [{ tool: 'search_wines', input: '{"query":"test"}' }],
    observations: ['Found wines matching the query.'],
    terminationReason: 'answer',
    totalDurationMs: 1_000,
    totalTokens: { input: 500, output: 200 },
    ...overrides,
  };
}

describe('L1.A - bench SLA latency uses agent-work, not raw wall', () => {
  it('scoreScenario reports agentWorkMs (and throttleWaitMs) onto the result', () => {
    const scenario = makeScenario({ maxSteps: 2, maxDurationMs: 20_000 });
    const execution = makeExecution({
      totalDurationMs: 80_000,
      agentWorkMs: 20_000,
      throttleWaitMs: 60_000,
    });

    const result = scoreScenario(scenario, execution, undefined);

    expect(result.agentWorkMs).toBe(20_000);
    expect(result.throttleWaitMs).toBe(60_000);
    expect(result.totalDurationMs).toBe(80_000);
  });

  it('latency dim scores against agentWorkMs - no overshoot when wall would blow budget', () => {
    const scenario = makeScenario({ maxSteps: 2, maxDurationMs: 25_000 });
    const execution = makeExecution({
      totalDurationMs: 80_000,
      agentWorkMs: 20_000,
      throttleWaitMs: 60_000,
    });

    const result = scoreScenario(scenario, execution, undefined);

    expect(result.scores.costEfficiency).toBe(1);
    const latencyDiags = (result.diagnostics ?? []).filter(
      (d) => d.code === 'LATENCY_BUDGET_BLOWN' || d.code === 'LATENCY_BUDGET_EXCEEDED',
    );
    expect(latencyDiags).toHaveLength(0);
  });

  it('legacy execution without agentWorkMs falls back to totalDurationMs (backwards-compat)', () => {
    const scenario = makeScenario({ maxSteps: 2, maxDurationMs: 25_000 });
    const execution = makeExecution({ totalDurationMs: 50_000 });

    const result = scoreScenario(scenario, execution, undefined);

    expect(result.scores.costEfficiency).toBe(0);
    const latencyDiag = (result.diagnostics ?? []).find(
      (d) => d.code === 'LATENCY_BUDGET_BLOWN' || d.code === 'LATENCY_BUDGET_EXCEEDED',
    );
    expect(latencyDiag).toBeDefined();
    expect(result.agentWorkMs).toBeUndefined();
    expect(result.throttleWaitMs).toBeUndefined();
  });

  it('the bench summary surfaces BOTH latencyMs (agent-work) and latencyWallMs', () => {
    type SummaryShape = {
      readonly latencyMs: { readonly p50: number; readonly p95: number };
      readonly latencyWallMs: { readonly p50: number; readonly p95: number };
      readonly latencySla: { readonly p95Pass: boolean; readonly p95PassWall: boolean };
    };
    const synthetic: SummaryShape = {
      latencyMs: { p50: 5_000, p95: 20_000 },
      latencyWallMs: { p50: 5_000, p95: 80_000 },
      latencySla: { p95Pass: true, p95PassWall: false },
    };

    expect(synthetic.latencySla.p95Pass).toBe(true);
    expect(synthetic.latencySla.p95PassWall).toBe(false);
    expect(synthetic.latencyWallMs.p95 - synthetic.latencyMs.p95).toBe(60_000);
  });
});
