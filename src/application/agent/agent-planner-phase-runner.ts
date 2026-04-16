import type { ChatLlmPort, ChatMessage } from '../../domain/ai/port/chat-llm.port.js';
import type { AgentConfig } from '../../domain/agent/model/agent-config.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import {
  buildPlannerSystemMessage,
  buildStepMessages,
  buildUserMessage,
} from './agent-prompt.js';
import type { AgentExecutionState } from './agent-execution-state.js';
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateTokenCount,
  isValidLlmResult,
  parseLlmOutput,
  type LlmResult,
  type LlmAction,
} from './agent-llm-output.js';
import {
  AGENT_LLM_STEP_TIMEOUT_MESSAGE,
  AgentPlannerPhaseResultPolicy,
} from './agent-planner-phase-result-policy.js';

const log = bootstrapLogger.child({ component: 'AgentPlannerPhaseRunner' });
const STEP_LOG_PREVIEW_CHARS = 500;
const PLANNER_MAX_OUTPUT_TOKENS_DEFAULT = 1_024;
const PLANNER_MAX_OUTPUT_TOKENS_LAST_STEP = 1_536;

export interface PlannerPhaseResult {
  readonly stepStartMs: number;
  readonly parsed: LlmAction;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly wasTruncated: boolean;
}

function buildPlannerLoopMessages(
  query: string,
  steps: AgentExecutionState['steps'],
  pendingRefinementHint: string | undefined,
  isLastStep: boolean,
  remainingSteps: number,
  maxContextChars: number,
): readonly ChatMessage[] {
  const baseUserContentRaw = pendingRefinementHint !== undefined
    ? `${pendingRefinementHint}\n\n${query}`
    : query;
  const baseUserContent = baseUserContentRaw.length > maxContextChars
    ? baseUserContentRaw.slice(0, maxContextChars)
    : baseUserContentRaw;
  const messages = [
    buildPlannerSystemMessage(),
    buildUserMessage(baseUserContent),
    ...buildStepMessages(steps),
  ];
  if (isLastStep) {
    messages.push({
      role: 'user',
      content: remainingSteps === 1
        ? `[LAST_STEP] Step budget exhausted. You MUST produce a final {"thought":"…","answer":"…"} JSON now using the information above. Do NOT call another tool.`
        : `[BUDGET_WARNING] Only ${remainingSteps} steps remain. Synthesize your current search results into a final {"thought":"…","answer":"…"} NOW — do not call another tool unless you have no results yet.`,
    });
  }
  return messages;
}

interface AgentPlannerPhaseRunnerDeps {
  readonly chatLlm: ChatLlmPort;
}

function resolvePlannerMaxOutputTokens(isLastStep: boolean): number {
  return isLastStep
    ? PLANNER_MAX_OUTPUT_TOKENS_LAST_STEP
    : PLANNER_MAX_OUTPUT_TOKENS_DEFAULT;
}

export class AgentPlannerPhaseRunner {
  private readonly resultPolicy = new AgentPlannerPhaseResultPolicy();

  constructor(private readonly deps: AgentPlannerPhaseRunnerDeps) {}

  async run(
    query: string,
    requestId: string,
    effectiveConfig: AgentConfig,
    state: AgentExecutionState,
    remainingSteps: number,
    isLastStep: boolean,
    abortSignal?: AbortSignal,
  ): Promise<PlannerPhaseResult | null> {
    const stepStartMs = Date.now();
    const messages = buildPlannerLoopMessages(
      query,
      state.steps,
      state.pendingRefinementHint,
      isLastStep,
      remainingSteps,
      effectiveConfig.maxContextChars,
    );
    state.pendingRefinementHint = undefined;

    if (abortSignal?.aborted) {
      this.resultPolicy.applyPreflightAbort(state);
      return null;
    }

    const stepAbortController = new AbortController();
    const propagateAbort = (): void => { stepAbortController.abort(); };
    abortSignal?.addEventListener('abort', propagateAbort, { once: true });
    if (abortSignal?.aborted) {
      abortSignal.removeEventListener('abort', propagateAbort);
      this.resultPolicy.applyPreflightAbort(state);
      return null;
    }

    let stepTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let llmResult: LlmResult;
    const plannerMaxOutputTokens = resolvePlannerMaxOutputTokens(isLastStep);
    try {
      const racedResult: unknown = await Promise.race([
        this.deps.chatLlm.complete({
          messages,
          temperature: 0,
          maxOutputTokens: plannerMaxOutputTokens,
          ...(effectiveConfig.seed !== undefined ? { seed: effectiveConfig.seed } : {}),
          abortSignal: stepAbortController.signal,
        }),
        new Promise<never>((_resolve, reject) => {
          stepTimeoutHandle = setTimeout(
            () => {
              stepAbortController.abort();
              reject(new Error(AGENT_LLM_STEP_TIMEOUT_MESSAGE));
            },
            effectiveConfig.perStepTimeoutMs,
          );
        }),
      ]);
      if (!isValidLlmResult(racedResult)) {
        log.warn(
          { requestId, stepIndex: state.steps.length, rawType: typeof racedResult },
          'Agent LLM returned malformed step result',
        );
        this.resultPolicy.applyMalformedLlmResult(state);
        return null;
      }
      llmResult = racedResult;
    } catch (err) {
      log.warn({ err, requestId, stepIndex: state.steps.length }, 'Agent LLM call failed');
      this.resultPolicy.applyLlmFailure(state, err);
      return null;
    } finally {
      abortSignal?.removeEventListener('abort', propagateAbort);
      if (stepTimeoutHandle !== undefined) {
        clearTimeout(stepTimeoutHandle);
      }
    }

    const wasTruncated = llmResult.finishReason === 'length';
    if (wasTruncated) {
      log.warn({ requestId, stepIndex: state.steps.length }, 'Agent LLM output truncated (finish_reason=length) — attempting recovery');
    }

    const inputChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    const inputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN_ESTIMATE);
    const outputTokens = estimateTokenCount(llmResult.text);
    state.totalInputTokens += inputTokens;
    state.totalOutputTokens += outputTokens;

    if (state.totalInputTokens + state.totalOutputTokens >= effectiveConfig.maxTotalTokens) {
      log.warn(
        { requestId, totalTokens: state.totalInputTokens + state.totalOutputTokens, budget: effectiveConfig.maxTotalTokens },
        'agent token budget exceeded — terminating',
      );
      this.resultPolicy.applyTokenBudgetExceeded(state);
      return null;
    }

    const parsed = parseLlmOutput(llmResult.text);
    if (state.steps.length === 0) {
      log.info(
        {
          requestId,
          textPreview: llmResult.text.slice(0, STEP_LOG_PREVIEW_CHARS),
          finishReason: llmResult.finishReason,
          hasAction: parsed.action !== undefined,
          hasActions: parsed.actions !== undefined,
          hasAnswer: parsed.answer !== undefined && parsed.answer.length > 0,
          wasTruncated,
        },
        '[RCA] step0 LLM output',
      );
    }

    return {
      stepStartMs,
      parsed,
      inputTokens,
      outputTokens,
      wasTruncated,
    };
  }
}
