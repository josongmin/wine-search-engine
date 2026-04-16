import { describe, expect, it } from 'vitest';
import { createAgentExecutionState } from '../../../../src/application/agent/agent-execution-state.js';
import { AgentRunLoopTerminationPolicy } from '../../../../src/application/agent/agent-run-loop-termination-policy.js';
import { CircuitBreakerOpenError } from '../../../../src/domain/shared/error/circuit-breaker-open-error.js';
import { DomainError } from '../../../../src/domain/shared/error/domain-error.js';
import { PolicyBlockedError } from '../../../../src/domain/shared/error/policy-blocked.js';

describe('AgentRunLoopTerminationPolicy', () => {
  it('maps budget and preflight abort reasons', () => {
    const policy = new AgentRunLoopTerminationPolicy();
    const state = createAgentExecutionState();

    policy.applyBudgetExhausted(state, undefined);
    expect(state.terminationReason).toBe('max_steps');

    policy.applyTokenBudgetExhausted(state);
    expect(state.terminationReason).toBe('budget');

    policy.applyPreflightAbort(state);
    expect(state.terminationReason).toBe('error');
  });

  it('maps blocked, breaker-open, and generic errors', () => {
    const policy = new AgentRunLoopTerminationPolicy();

    const blocked = createAgentExecutionState();
    policy.applyUnexpectedError(blocked, new PolicyBlockedError('blocked'));
    expect(blocked.policyBlocked).toBe(true);
    expect(blocked.terminationReason).toBe('blocked');

    const breaker = createAgentExecutionState();
    policy.applyUnexpectedError(breaker, new CircuitBreakerOpenError('llm.openai.chat'));
    expect(breaker.reasoningFailureDetected).toBe(true);
    expect(breaker.llmCircuitOpen).toBe(true);
    expect(breaker.terminationReason).toBe('error');

    const generic = createAgentExecutionState();
    policy.applyUnexpectedError(generic, new DomainError('generic failure', 'GENERIC'));
    expect(generic.reasoningFailureDetected).toBe(true);
    expect(generic.terminationReason).toBe('error');
  });
});
