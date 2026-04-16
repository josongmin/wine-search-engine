import { describe, expect, it } from 'vitest';
import {
  AGENT_LLM_STEP_TIMEOUT_MESSAGE,
  AgentPlannerPhaseResultPolicy,
} from '../../../../src/application/agent/agent-planner-phase-result-policy.js';
import { createAgentExecutionState } from '../../../../src/application/agent/agent-execution-state.js';
import { CircuitBreakerOpenError } from '../../../../src/domain/shared/error/circuit-breaker-open-error.js';
import { DomainError } from '../../../../src/domain/shared/error/domain-error.js';

describe('AgentPlannerPhaseResultPolicy', () => {
  it('maps malformed llm results to reasoning failure', () => {
    const state = createAgentExecutionState();
    new AgentPlannerPhaseResultPolicy().applyMalformedLlmResult(state);

    expect(state.reasoningFailureDetected).toBe(true);
    expect(state.terminationReason).toBe('error');
  });

  it('maps abort, timeout, breaker-open, and generic failures', () => {
    const policy = new AgentPlannerPhaseResultPolicy();

    const aborted = createAgentExecutionState();
    policy.applyLlmFailure(aborted, new DOMException('aborted', 'AbortError'));
    expect(aborted.terminationReason).toBe('aborted');

    const timedOut = createAgentExecutionState();
    policy.applyLlmFailure(timedOut, new Error(AGENT_LLM_STEP_TIMEOUT_MESSAGE));
    expect(timedOut.reasoningFailureDetected).toBe(true);
    expect(timedOut.timeoutStats.llmStep).toBe(1);
    expect(timedOut.terminationReason).toBe('timeout');

    const breaker = createAgentExecutionState();
    policy.applyLlmFailure(breaker, new CircuitBreakerOpenError('llm.openai.chat'));
    expect(breaker.reasoningFailureDetected).toBe(true);
    expect(breaker.llmCircuitOpen).toBe(true);
    expect(breaker.terminationReason).toBe('error');

    const generic = createAgentExecutionState();
    policy.applyLlmFailure(generic, new DomainError('boom', 'GENERIC'));
    expect(generic.reasoningFailureDetected).toBe(true);
    expect(generic.terminationReason).toBe('error');
  });

  it('maps token budget and preflight abort states', () => {
    const policy = new AgentPlannerPhaseResultPolicy();
    const state = createAgentExecutionState();

    policy.applyTokenBudgetExceeded(state);
    expect(state.terminationReason).toBe('budget');

    policy.applyPreflightAbort(state);
    expect(state.terminationReason).toBe('aborted');
  });
});
