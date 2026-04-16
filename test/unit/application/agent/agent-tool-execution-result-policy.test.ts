import { describe, expect, it } from 'vitest';
import { AgentToolExecutionResultPolicy } from '../../../../src/application/agent/agent-tool-execution-result-policy.js';
import { createAgentExecutionState } from '../../../../src/application/agent/agent-execution-state.js';
import { PolicyBlockedError } from '../../../../src/domain/shared/error/policy-blocked.js';

function baseInput() {
  return {
    requestId: 'req-tool-policy',
    stepIndex: 0,
    thought: 'execute tool',
    durationMs: 7,
    inputTokens: 11,
    outputTokens: 13,
  };
}

describe('AgentToolExecutionResultPolicy', () => {
  it('records single-tool timeouts as terminal typed outcomes', () => {
    const policy = new AgentToolExecutionResultPolicy();
    const state = createAgentExecutionState();

    const disposition = policy.applySingleExecutionFailure({
      ...baseInput(),
      err: Object.assign(new Error('timed out'), { code: 'TIMEOUT' }),
      tool: 'search_wines',
      input: { query: 'opus one' },
      state,
    });

    expect(disposition).toEqual({ kind: 'terminal' });
    expect(state.terminationReason).toBe('timeout');
    expect(state.timeoutStats.tool).toBe(1);
    expect(state.steps[0]?.observation).toContain('[TIMEOUT]');
    expect(state.toolOutcomes[0]).toMatchObject({
      stepId: 'req-tool-policy:0:0',
      tool: 'search_wines',
      kind: 'timeout',
    });
  });

  it('returns generic single-tool failures as recoverable tool errors', () => {
    const policy = new AgentToolExecutionResultPolicy();
    const state = createAgentExecutionState();

    const disposition = policy.applySingleExecutionFailure({
      ...baseInput(),
      err: new Error('backend failed'),
      tool: 'search_wines',
      input: { query: 'opus one' },
      state,
    });

    expect(disposition).toEqual({
      kind: 'recoverable',
      observation: 'Tool error: backend failed',
      rawResult: null,
    });
    expect(state.steps).toHaveLength(0);
    expect(state.toolOutcomes).toHaveLength(0);
  });

  it('records batch policy blocks as blocked typed outcomes and paired observations', () => {
    const policy = new AgentToolExecutionResultPolicy();
    const state = createAgentExecutionState();

    const handled = policy.applyBatchExecutionFailure({
      ...baseInput(),
      err: new PolicyBlockedError('unsafe query', { layer: 'SYSTEM', reason: 'SYSTEM_PROMPT_INJECTION' }),
      calls: [
        { tool: 'search_wines', input: { query: 'blocked a' } },
        { tool: 'search_wines', input: { query: 'blocked b' } },
      ],
      state,
    });

    expect(handled).toBe(true);
    expect(state.policyBlocked).toBe(true);
    expect(state.terminationReason).toBe('blocked');
    expect(state.steps[0]?.actionPairs).toHaveLength(2);
    expect(state.steps[0]?.observations?.[0]).toContain('Policy blocked');
    expect(state.toolOutcomes).toEqual([
      expect.objectContaining({ stepId: 'req-tool-policy:0:0', kind: 'policy_violation' }),
      expect.objectContaining({ stepId: 'req-tool-policy:0:1', kind: 'policy_violation' }),
    ]);
  });
});
