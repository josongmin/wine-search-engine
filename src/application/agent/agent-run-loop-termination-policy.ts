import type { AgentExecutionState } from './agent-execution-state.js';
import type { AgentTerminationReason } from '../../domain/agent/model/agent-step.js';
import { CIRCUIT_BREAKER_OPEN_CODE } from '../../domain/shared/error/circuit-breaker-open-error.js';
import { DomainError } from '../../domain/shared/error/domain-error.js';
import { POLICY_BLOCKED_CODE } from '../../domain/shared/error/policy-blocked.js';
import { transitionTerminationReason } from '../../domain/agent/service/termination-state-machine.js';

export class AgentRunLoopTerminationPolicy {
  applyBudgetExhausted(state: AgentExecutionState, reason?: AgentTerminationReason): void {
    state.terminationReason = transitionTerminationReason(state.terminationReason, reason ?? 'max_steps');
  }

  applyTokenBudgetExhausted(state: AgentExecutionState): void {
    state.terminationReason = transitionTerminationReason(state.terminationReason, 'budget');
  }

  applyPreflightAbort(state: AgentExecutionState): void {
    state.terminationReason = transitionTerminationReason(state.terminationReason, 'aborted');
  }

  applyUnexpectedError(state: AgentExecutionState, err: unknown): void {
    if (err instanceof DomainError && err.code === POLICY_BLOCKED_CODE) {
      state.policyBlocked = true;
      state.terminationReason = transitionTerminationReason(state.terminationReason, 'blocked');
      return;
    }
    if (err instanceof DomainError && err.code === CIRCUIT_BREAKER_OPEN_CODE) {
      state.reasoningFailureDetected = true;
      state.llmCircuitOpen = true;
      state.terminationReason = transitionTerminationReason(state.terminationReason, 'error');
      return;
    }
    state.reasoningFailureDetected = true;
    state.terminationReason = transitionTerminationReason(state.terminationReason, 'error');
  }
}
