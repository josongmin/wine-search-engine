import { describe, expect, it } from 'vitest';
import { AgentContractExecutionResultPolicy } from '../../../../src/application/agent/agent-contract-execution-result-policy.js';
import { createAgentExecutionState } from '../../../../src/application/agent/agent-execution-state.js';
import { DomainError } from '../../../../src/domain/shared/error/domain-error.js';
import { PolicyBlockedError } from '../../../../src/domain/shared/error/policy-blocked.js';

const CHECK_CALLS = [
  { tool: 'check_drinking_window', input: { entity_id: 'wine-1' } },
];

describe('AgentContractExecutionResultPolicy', () => {
  it('records abort failures as aborted contract steps', () => {
    const policy = new AgentContractExecutionResultPolicy();
    const state = createAgentExecutionState();

    const handled = policy.applyFailure({
      err: new DOMException('aborted', 'AbortError'),
      requestId: 'req-abort',
      stepIndex: 0,
      checkCalls: CHECK_CALLS,
      durationMs: 3,
      state,
    });

    expect(handled).toBe(true);
    expect(state.terminationReason).toBe('aborted');
    expect(state.steps[0]?.observations?.[0]).toContain('[ABORTED]');
    expect(state.toolOutcomes[0]).toMatchObject({ kind: 'tool_error' });
  });

  it('records timeout failures and increments parallel batch timeout stats', () => {
    const policy = new AgentContractExecutionResultPolicy();
    const state = createAgentExecutionState();

    const handled = policy.applyFailure({
      err: Object.assign(new Error('timeout'), { code: 'TIMEOUT' }),
      requestId: 'req-timeout',
      stepIndex: 0,
      checkCalls: CHECK_CALLS,
      durationMs: 5,
      state,
    });

    expect(handled).toBe(true);
    expect(state.timeoutStats.parallelBatch).toBe(1);
    expect(state.terminationReason).toBe('timeout');
    expect(state.toolOutcomes[0]).toMatchObject({ kind: 'timeout' });
  });

  it('records policy blocked failures as blocked contract steps', () => {
    const policy = new AgentContractExecutionResultPolicy();
    const state = createAgentExecutionState();

    const handled = policy.applyFailure({
      err: new PolicyBlockedError('unsafe contract tool'),
      requestId: 'req-blocked',
      stepIndex: 0,
      checkCalls: CHECK_CALLS,
      durationMs: 7,
      state,
    });

    expect(handled).toBe(true);
    expect(state.policyBlocked).toBe(true);
    expect(state.terminationReason).toBe('blocked');
    expect(state.steps[0]?.observations?.[0]).toContain('Policy blocked');
    expect(state.toolOutcomes[0]).toMatchObject({ kind: 'policy_violation' });
  });

  it('maps unhandled errors to reasoning failure without fabricating a contract step', () => {
    const policy = new AgentContractExecutionResultPolicy();
    const state = createAgentExecutionState();

    const handled = policy.applyFailure({
      err: new DomainError('boom', 'GENERIC'),
      requestId: 'req-generic',
      stepIndex: 0,
      checkCalls: CHECK_CALLS,
      durationMs: 11,
      state,
    });

    expect(handled).toBe(false);
    expect(state.reasoningFailureDetected).toBe(true);
    expect(state.terminationReason).toBe('error');
    expect(state.steps).toHaveLength(0);
    expect(state.toolOutcomes).toHaveLength(0);
  });
});
