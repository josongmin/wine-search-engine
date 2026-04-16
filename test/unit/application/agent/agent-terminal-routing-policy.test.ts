import { describe, expect, it } from 'vitest';
import { createAgentExecutionState } from '../../../../src/application/agent/agent-execution-state.js';
import { AgentTerminalRoutingPolicy } from '../../../../src/application/agent/agent-terminal-routing-policy.js';

describe('AgentTerminalRoutingPolicy', () => {
  it('routes to observation synthesis only for unresolved non-terminal runs', () => {
    const policy = new AgentTerminalRoutingPolicy();
    const state = createAgentExecutionState();
    state.terminationReason = 'max_steps';

    expect(policy.shouldRunObservationSynthesis({ state })).toBe(true);
  });

  it('does not route blocked, circuit-open, already-answered, or aborted runs to synthesis', () => {
    const policy = new AgentTerminalRoutingPolicy();

    const blocked = createAgentExecutionState();
    blocked.policyBlocked = true;
    blocked.terminationReason = 'blocked';
    expect(policy.shouldRunObservationSynthesis({ state: blocked })).toBe(false);

    const circuitOpen = createAgentExecutionState();
    circuitOpen.llmCircuitOpen = true;
    circuitOpen.terminationReason = 'error';
    expect(policy.shouldRunObservationSynthesis({ state: circuitOpen })).toBe(false);

    const answered = createAgentExecutionState();
    answered.answer = '이미 답변됨';
    answered.terminationReason = 'answer';
    expect(policy.shouldRunObservationSynthesis({ state: answered })).toBe(false);

    const abortController = new AbortController();
    abortController.abort();
    const aborted = createAgentExecutionState();
    aborted.terminationReason = 'max_steps';
    expect(policy.shouldRunObservationSynthesis({
      state: aborted,
      abortSignal: abortController.signal,
    })).toBe(false);
  });
});
