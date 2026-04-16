import type { AgentResult } from '../../domain/agent/model/agent-result.js';
import type { AgentExecutionObserver } from '../../domain/agent/port/agent-execution-observer.port.js';
import type { StepBudget } from '../../domain/agent/service/step-budget.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import type { AgentExecutionState } from './agent-execution-state.js';
import { buildSynthesisContext } from './tool-outcome.js';

const log = bootstrapLogger.child({ component: 'AgentResultFinalizer' });

interface AgentResultFinalizerDeps {
  readonly executionObserver?: AgentExecutionObserver | undefined;
}

interface FinalizeAgentResultInput {
  readonly query: string;
  readonly requestId: string;
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

export class AgentResultFinalizer {
  constructor(private readonly deps: AgentResultFinalizerDeps) {}

  finalize(input: FinalizeAgentResultInput): AgentResult {
    const { query, requestId, answer, observedToolOutput, budget, state } = input;
    const toolCallCount = countToolCalls(state);
    const totalDurationMs = budget.getElapsedMs();
    const reasoningFailure = hasReasoningFailure(state, observedToolOutput);

    log.info(
      {
        requestId,
        steps: state.steps.length,
        toolCalls: toolCallCount,
        terminationReason: state.terminationReason,
        timeoutStats: state.timeoutStats,
        failureTags: buildFailureTags(state),
        totalDurationMs,
        fallbackApplied: state.fallbackApplied,
      },
      'Agent execution complete',
    );

    this.deps.executionObserver?.onExecutionComplete({
      terminationReason: state.terminationReason,
      fallbackApplied: state.fallbackApplied,
      toolCallCount,
      totalDurationMs,
      timeoutStats: state.timeoutStats,
      synthesis: {
        reasoningFailure,
        fallbackApplied: state.fallbackLayer,
      },
    });

    const synthesisContext = buildSynthesisContext(
      query,
      state.toolOutcomes,
      reasoningFailure,
      state.fallbackLayer,
    );

    return {
      answer: answer.trim(),
      steps: state.steps,
      totalDurationMs,
      totalTokens: { input: state.totalInputTokens, output: state.totalOutputTokens },
      toolCallCount,
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
              reasoningFailure,
              failedSynthesisAttempts: state.failedSynthesisAttempts,
              fallbackSearchUsed: state.fallbackSearchUsed,
            },
          }
        : {}),
    };
  }
}
