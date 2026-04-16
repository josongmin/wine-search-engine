import type { AgentTerminationReason } from '../../domain/agent/model/agent-step.js';
import { DomainError } from '../../domain/shared/error/domain-error.js';
import { POLICY_BLOCKED_CODE } from '../../domain/shared/error/policy-blocked.js';
import { isAbortError } from '../../domain/shared/cooperative-abort.js';
import type { AgentExecutionState } from './agent-execution-state.js';
import {
  buildObservationPairs,
  buildToolOutcome,
  formatPolicyBlockedObservation,
  type TimeoutErrorLike,
} from './agent-tool-execution-support.js';

interface ContractToolCall {
  readonly tool: string;
  readonly input: Record<string, unknown>;
}

interface ApplyContractExecutionFailureInput {
  readonly err: unknown;
  readonly requestId: string;
  readonly stepIndex: number;
  readonly checkCalls: readonly ContractToolCall[];
  readonly durationMs: number;
  readonly state: AgentExecutionState;
}

export class AgentContractExecutionResultPolicy {
  applyBudgetReservationFailure(state: AgentExecutionState, reason?: string): void {
    state.terminationReason = (reason as AgentTerminationReason | undefined) ?? 'max_steps';
  }

  applyFailure(input: ApplyContractExecutionFailureInput): boolean {
    const { err, requestId, stepIndex, checkCalls, durationMs, state } = input;

    if (isAbortError(err)) {
      state.terminationReason = 'aborted';
      this.recordFailureStep({
        requestId,
        stepIndex,
        checkCalls,
        durationMs,
        state,
        observation: '[ABORTED] Request cancelled during contract drinkability checks.',
        execError: true,
        timedOut: false,
        policyBlocked: false,
      });
      return true;
    }

    if ((err as TimeoutErrorLike).code === 'TIMEOUT') {
      state.timeoutStats.parallelBatch += 1;
      state.terminationReason = 'timeout';
      this.recordFailureStep({
        requestId,
        stepIndex,
        checkCalls,
        durationMs,
        state,
        observation: '[TIMEOUT] Contract drinkability checks timed out.',
        execError: false,
        timedOut: true,
        policyBlocked: false,
      });
      return true;
    }

    if (err instanceof DomainError && err.code === POLICY_BLOCKED_CODE) {
      state.policyBlocked = true;
      state.terminationReason = 'blocked';
      this.recordFailureStep({
        requestId,
        stepIndex,
        checkCalls,
        durationMs,
        state,
        observation: formatPolicyBlockedObservation(err),
        execError: false,
        timedOut: false,
        policyBlocked: true,
      });
      return true;
    }

    state.reasoningFailureDetected = true;
    state.terminationReason = 'error';
    return false;
  }

  private recordFailureStep(input: {
    readonly requestId: string;
    readonly stepIndex: number;
    readonly checkCalls: readonly ContractToolCall[];
    readonly durationMs: number;
    readonly state: AgentExecutionState;
    readonly observation: string;
    readonly execError: boolean;
    readonly timedOut: boolean;
    readonly policyBlocked: boolean;
  }): void {
    const {
      requestId,
      stepIndex,
      checkCalls,
      durationMs,
      state,
      observation,
      execError,
      timedOut,
      policyBlocked,
    } = input;

    for (let i = 0; i < checkCalls.length; i++) {
      state.toolOutcomes.push(
        buildToolOutcome(
          requestId,
          stepIndex,
          i,
          checkCalls[i]!.tool,
          observation,
          null,
          durationMs,
          execError,
          timedOut,
          policyBlocked,
        ),
      );
    }
    const { actionPairs, observations } = buildObservationPairs(checkCalls, observation);
    state.steps.push({
      index: stepIndex,
      thought: 'contract: drinkability check after entity retrieval',
      actionPairs,
      actions: checkCalls,
      observations,
      durationMs,
      tokenCount: { input: 0, output: 0 },
    });
  }
}
