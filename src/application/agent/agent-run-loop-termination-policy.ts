import type { AgentExecutionState } from './agent-execution-state.js';
import type { AgentTerminationReason } from '../../domain/agent/model/agent-step.js';
import { CIRCUIT_BREAKER_OPEN_CODE } from '../../domain/shared/error/circuit-breaker-open-error.js';
import { DomainError } from '../../domain/shared/error/domain-error.js';
import { POLICY_BLOCKED_CODE } from '../../domain/shared/error/policy-blocked.js';

export class AgentRunLoopTerminationPolicy {
  applyBudgetExhausted(state: AgentExecutionState, reason?: AgentTerminationReason): void {
    state.terminationReason = reason ?? 'max_steps';
  }

  applyTokenBudgetExhausted(state: AgentExecutionState): void {
    state.terminationReason = 'budget';
  }

  applyPreflightAbort(state: AgentExecutionState): void {
    state.terminationReason = 'error';
  }

  applyUnexpectedError(state: AgentExecutionState, err: unknown): void {
    if (err instanceof DomainError && err.code === POLICY_BLOCKED_CODE) {
      state.policyBlocked = true;
      state.terminationReason = 'blocked';
      return;
    }
    if (err instanceof DomainError && err.code === CIRCUIT_BREAKER_OPEN_CODE) {
      state.reasoningFailureDetected = true;
      state.llmCircuitOpen = true;
      state.terminationReason = 'error';
      return;
    }
    state.reasoningFailureDetected = true;
    state.terminationReason = 'error';
  }
}
