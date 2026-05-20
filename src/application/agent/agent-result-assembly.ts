import type { AgentResult } from '../../domain/agent/model/agent-result.js';
import type { StepBudget } from '../../domain/agent/service/step-budget.js';
import type { AgentExecutionState } from './agent-execution-state.js';
import { buildSynthesisContext } from '../../domain/agent/model/tool-outcome.js';

export interface AgentResultMetrics {
  readonly toolCallCount: number;
  readonly totalDurationMs: number;
  readonly reasoningFailure: boolean;
  readonly failureTags: readonly string[];
}

interface BuildAgentResultInput {
  readonly query: string;
  readonly answer: string;
  readonly observedToolOutput: boolean;
  readonly budget: StepBudget;
  readonly state: AgentExecutionState;
}

function countToolCalls(state: AgentExecutionState): number {
  return state.steps.reduce((n, s) => n + (s.action !== undefined ? 1 : 0) + (s.actionPairs?.length ?? 0), 0);
}

function buildFailureTags(state: AgentExecutionState): readonly string[] {
  return [
    ...(state.timeoutStats.llmStep > 0 ? ['llm_step_timeout'] : []),
    ...(state.timeoutStats.parallelBatch > 0 ? ['parallel_batch_timeout'] : []),
    ...(state.timeoutStats.tool > 0 ? ['tool_timeout'] : []),
  ];
}

function hasReasoningFailure(state: AgentExecutionState, observedToolOutput: boolean): boolean {
  return (
    state.reasoningFailureDetected ||
    state.timeoutStats.llmStep > 0 ||
    state.timeoutStats.parallelBatch > 0 ||
    state.llmCircuitOpen ||
    state.failedSynthesisAttempts > 0 ||
    (observedToolOutput && state.fallbackLayer !== null)
  );
}

export function buildAgentResultMetrics(input: BuildAgentResultInput): AgentResultMetrics {
  return {
    toolCallCount: countToolCalls(input.state),
    totalDurationMs: input.budget.getElapsedMs(),
    reasoningFailure: hasReasoningFailure(input.state, input.observedToolOutput),
    failureTags: buildFailureTags(input.state),
  };
}

export class AgentResultAssembler {
  build(input: BuildAgentResultInput, metrics: AgentResultMetrics): AgentResult {
    const { query, answer, state } = input;
    const synthesisContext = buildSynthesisContext(
      query,
      state.toolOutcomes,
      metrics.reasoningFailure,
      state.fallbackLayer,
    );

    return {
      answer: answer.trim(),
      steps: state.steps,
      totalDurationMs: metrics.totalDurationMs,
      totalTokens: { input: state.totalInputTokens, output: state.totalOutputTokens },
      toolCallCount: metrics.toolCallCount,
      fallbackApplied: state.fallbackApplied,
      terminationReason: state.terminationReason,
      ...(state.lastSearchResult !== undefined ? { searchResults: state.lastSearchResult } : {}),
      ...(state.toolOutcomes.length > 0 ? { toolOutcomes: state.toolOutcomes } : {}),
      ...(state.collectedFrames.length > 0 ? { evidenceFrames: state.collectedFrames } : {}),
      synthesisContext,
      ...(state.fallbackApplied
        ? {
            fallbackTrace: {
              fallbackApplied: state.fallbackLayer,
              reasoningFailure: metrics.reasoningFailure,
              failedSynthesisAttempts: state.failedSynthesisAttempts,
              fallbackSearchUsed: state.fallbackSearchUsed,
            },
          }
        : {}),
    };
  }
}
