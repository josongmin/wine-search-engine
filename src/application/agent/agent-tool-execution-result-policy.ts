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
import { KNOWN_AGENT_TOOL_NAMES_DISPLAY } from './agent-tool-attempt-schema.js';

interface ToolCall {
  readonly tool: string;
  readonly input: Record<string, unknown>;
}

interface StepRecordInput {
  readonly requestId: string;
  readonly stepIndex: number;
  readonly thought: string;
  readonly durationMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly state: AgentExecutionState;
}

interface SingleToolStepInput extends StepRecordInput {
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly observation: string;
  readonly rawResult: unknown;
  readonly execError: boolean;
  readonly timedOut: boolean;
  readonly policyViolation: boolean;
}

interface BatchStepInput extends StepRecordInput {
  readonly calls: readonly ToolCall[];
  readonly observation: string;
  readonly execError: boolean;
  readonly timedOut: boolean;
  readonly policyViolation: boolean;
}

interface ApplySingleFailureInput extends StepRecordInput {
  readonly err: unknown;
  readonly tool: string;
  readonly input: Record<string, unknown>;
}

interface ApplyBatchFailureInput extends StepRecordInput {
  readonly err: unknown;
  readonly calls: readonly ToolCall[];
}

export type SingleToolFailureDisposition =
  | { readonly kind: 'terminal' }
  | { readonly kind: 'recoverable'; readonly observation: string; readonly rawResult: null };

export class AgentToolExecutionResultPolicy {
  recordSingleToolStep(input: SingleToolStepInput): void {
    const {
      requestId,
      stepIndex,
      thought,
      tool,
      input: toolInput,
      observation,
      rawResult,
      durationMs,
      inputTokens,
      outputTokens,
      state,
      execError,
      timedOut,
      policyViolation,
    } = input;

    state.toolOutcomes.push(
      buildToolOutcome(requestId, stepIndex, 0, tool, observation, rawResult, durationMs, execError, timedOut, policyViolation),
    );
    state.steps.push({
      index: stepIndex,
      thought,
      action: { tool, input: toolInput },
      observation,
      durationMs,
      tokenCount: { input: inputTokens, output: outputTokens },
    });
  }

  recordBatchStep(input: BatchStepInput): void {
    const {
      requestId,
      stepIndex,
      thought,
      calls,
      observation,
      durationMs,
      inputTokens,
      outputTokens,
      state,
      execError,
      timedOut,
      policyViolation,
    } = input;

    for (let i = 0; i < calls.length; i++) {
      state.toolOutcomes.push(
        buildToolOutcome(
          requestId,
          stepIndex,
          i,
          calls[i]!.tool,
          observation,
          null,
          durationMs,
          execError,
          timedOut,
          policyViolation,
        ),
      );
    }
    const { actionPairs, observations } = buildObservationPairs(calls, observation);
    state.steps.push({
      index: stepIndex,
      thought,
      actionPairs,
      actions: calls,
      observations,
      durationMs,
      tokenCount: { input: inputTokens, output: outputTokens },
    });
  }

  applyUnknownTool(input: {
    readonly requestId: string;
    readonly stepIndex: number;
    readonly thought: string;
    readonly tool: string;
    readonly toolInput: Record<string, unknown>;
    readonly durationMs: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly state: AgentExecutionState;
  }): boolean {
    const { state, tool } = input;
    state.reasoningFailureDetected = true;
    state.unknownToolAttempts += 1;
    if (state.unknownToolAttempts > 2) {
      state.terminationReason = 'error';
      return true;
    }
    this.recordSingleToolStep({
      ...input,
      input: input.toolInput,
      observation: this.buildUnknownToolObservation(tool),
      rawResult: null,
      execError: false,
      timedOut: false,
      policyViolation: true,
    });
    return false;
  }

  applyUnknownBatchTool(input: BatchStepInput & { readonly unknownTool: string }): boolean {
    const { state, unknownTool } = input;
    state.reasoningFailureDetected = true;
    state.unknownToolAttempts += 1;
    if (state.unknownToolAttempts > 2) {
      state.terminationReason = 'error';
      return true;
    }
    this.recordBatchStep({
      ...input,
      observation: this.buildUnknownToolObservation(unknownTool),
      execError: false,
      timedOut: false,
      policyViolation: true,
    });
    return false;
  }

  applySingleExecutionFailure(input: ApplySingleFailureInput): SingleToolFailureDisposition {
    const { err, state, tool } = input;

    if ((err as TimeoutErrorLike).code === 'TIMEOUT') {
      state.timeoutStats.tool += 1;
      state.terminationReason = 'timeout';
      this.recordSingleToolStep({
        ...input,
        observation: `[TIMEOUT] Tool "${tool}" timed out. Try a different approach or a narrower query.`,
        rawResult: null,
        execError: false,
        timedOut: true,
        policyViolation: false,
      });
      return { kind: 'terminal' };
    }

    if (isAbortError(err)) {
      state.terminationReason = 'aborted';
      this.recordSingleToolStep({
        ...input,
        observation: '[ABORTED] Request cancelled during tool execution.',
        rawResult: null,
        execError: true,
        timedOut: false,
        policyViolation: false,
      });
      return { kind: 'terminal' };
    }

    if (err instanceof DomainError && err.code === POLICY_BLOCKED_CODE) {
      state.policyBlocked = true;
      state.terminationReason = 'blocked';
      this.recordSingleToolStep({
        ...input,
        observation: formatPolicyBlockedObservation(err),
        rawResult: null,
        execError: false,
        timedOut: false,
        policyViolation: true,
      });
      return { kind: 'terminal' };
    }

    return {
      kind: 'recoverable',
      observation: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
      rawResult: null,
    };
  }

  applyBatchExecutionFailure(input: ApplyBatchFailureInput): boolean {
    const { err, state } = input;

    if (isAbortError(err)) {
      state.terminationReason = 'aborted';
      this.recordBatchStep({
        ...input,
        observation: '[ABORTED] Request cancelled during parallel tool execution.',
        execError: true,
        timedOut: false,
        policyViolation: false,
      });
      return true;
    }

    if ((err as TimeoutErrorLike).code === 'TIMEOUT') {
      state.reasoningFailureDetected = true;
      state.timeoutStats.parallelBatch += 1;
      state.terminationReason = 'timeout';
      this.recordBatchStep({
        ...input,
        observation: '[TIMEOUT] Parallel tool batch timed out.',
        execError: false,
        timedOut: true,
        policyViolation: false,
      });
      return true;
    }

    if (err instanceof DomainError && err.code === POLICY_BLOCKED_CODE) {
      state.policyBlocked = true;
      state.terminationReason = 'blocked';
      this.recordBatchStep({
        ...input,
        observation: formatPolicyBlockedObservation(err),
        execError: false,
        timedOut: false,
        policyViolation: true,
      });
      return true;
    }

    state.reasoningFailureDetected = true;
    state.terminationReason = 'error';
    return false;
  }

  private buildUnknownToolObservation(tool: string): string {
    return `Unknown tool: ${tool}. Available: ${KNOWN_AGENT_TOOL_NAMES_DISPLAY}`;
  }
}
