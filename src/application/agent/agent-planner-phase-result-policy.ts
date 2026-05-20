import { CIRCUIT_BREAKER_OPEN_CODE } from '../../domain/shared/error/circuit-breaker-open-error.js';
import { DomainError } from '../../domain/shared/error/domain-error.js';
import { isAbortError } from '../../domain/shared/cooperative-abort.js';
import { transitionTerminationReason } from '../../domain/agent/service/termination-state-machine.js';
import type { AgentExecutionState } from './agent-execution-state.js';

export const AGENT_LLM_STEP_TIMEOUT_MESSAGE = 'Agent LLM step timed out';

export class AgentPlannerPhaseResultPolicy {
  applyPreflightAbort(state: AgentExecutionState): void {
    state.terminationReason = transitionTerminationReason(state.terminationReason, 'aborted');
  }

  applyMalformedLlmResult(state: AgentExecutionState): void {
    state.reasoningFailureDetected = true;
    state.terminationReason = transitionTerminationReason(state.terminationReason, 'error');
  }

  applyLlmFailure(state: AgentExecutionState, err: unknown): void {
    if (isAbortError(err)) {
      state.terminationReason = transitionTerminationReason(state.terminationReason, 'aborted');
      return;
    }
    if (err instanceof Error && err.message === AGENT_LLM_STEP_TIMEOUT_MESSAGE) {
      state.reasoningFailureDetected = true;
      state.timeoutStats.llmStep += 1;
      state.terminationReason = transitionTerminationReason(state.terminationReason, 'timeout');
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

  applyTokenBudgetExceeded(state: AgentExecutionState): void {
    state.terminationReason = transitionTerminationReason(state.terminationReason, 'budget');
  }
}
