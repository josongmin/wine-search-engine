import type { ChatLlmPort, ChatMessage } from '../../domain/ai/port/chat-llm.port.js';
import type { AgentConfig } from '../../domain/agent/model/agent-config.js';
import type { AgentStep } from '../../domain/agent/model/agent-step.js';
import { DomainError } from '../../domain/shared/error/domain-error.js';
import { CIRCUIT_BREAKER_OPEN_CODE } from '../../domain/shared/error/circuit-breaker-open-error.js';
import { isAbortError } from '../../domain/shared/cooperative-abort.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import {
  buildSynthesisSystemMessage,
  buildUserMessage,
} from './agent-prompt.js';
import type { AgentExecutionState } from './agent-execution-state.js';
import type { ToolOutcome } from './tool-outcome.js';
import {
  estimateTokenCount,
  isValidLlmResult,
  parseLlmJsonObject,
  type LlmResult,
} from './agent-llm-output.js';

const defaultLog = bootstrapLogger.child({ component: 'AgentObservationSynthesisRunner' });
const SYNTHESIS_TIMEOUT_MS = 12_000;
const SYNTHESIS_TOKENS_ATTEMPT_1 = 512;
const SYNTHESIS_TOKENS_ATTEMPT_2 = 256;

interface ObservationSynthesisMessages {
  readonly messages: readonly ChatMessage[];
  readonly sentinel: string;
}

function buildObservationOnlyMessages(steps: readonly AgentStep[]): readonly ChatMessage[] {
  const messages: ChatMessage[] = [];

  for (const step of steps) {
    if (step.actionPairs !== undefined) {
      for (const pair of step.actionPairs) {
        messages.push({
          role: 'user',
          content: `[Tool Result: ${pair.action.tool}]\n${pair.observation}`,
        });
      }
      continue;
    }

    if (step.action !== undefined && step.observation !== undefined && step.observation.length > 0) {
      messages.push({
        role: 'user',
        content: `[Tool Result: ${step.action.tool}]\n${step.observation}`,
      });
    }
  }

  return messages;
}

function buildObservationSynthesisMessages(
  query: string,
  steps: readonly AgentStep[],
  toolOutcomes: readonly ToolOutcome[],
  requestId: string,
): ObservationSynthesisMessages {
  const synthSentinel = `[SYSTEM:${requestId}:FINAL_ANSWER_REQUIRED]\nYou have exhausted your step budget. Synthesize the tool results above into a final answer now.\nOutput ONLY this JSON — no other text, no code fences:\n{"thought":"one-sentence summary of findings","answer":"your complete, grounded response in the user's language (Korean if query was Korean)"}\nRules:\n- "answer" must reference specific wines, regions, or prices from the tool results above.\n- Do NOT call any tool. Do NOT output "action" or "actions".\n- If results were empty, tell the user no match was found and suggest broadening the search.`;
  const nonSuccessToolOutcomes = toolOutcomes.filter((outcome) =>
    outcome.kind !== 'success'
    || outcome.errorMessage !== undefined
    || (outcome.postconditionViolations?.length ?? 0) > 0,
  );
  const typedOutcomeMessage: ChatMessage | undefined = nonSuccessToolOutcomes.length > 0
    ? {
        role: 'user',
        content: `[Typed Tool Outcomes]\n${JSON.stringify(nonSuccessToolOutcomes.map((outcome) => ({
          stepId: outcome.stepId,
          tool: outcome.tool,
          kind: outcome.kind,
          errorMessage: outcome.errorMessage,
          postconditionViolations: outcome.postconditionViolations,
        })))}`
      }
    : undefined;
  return {
    messages: [
      buildSynthesisSystemMessage(),
      buildUserMessage(query),
      ...buildObservationOnlyMessages(steps),
      ...(typedOutcomeMessage !== undefined ? [typedOutcomeMessage] : []),
      {
        role: 'user',
        content: synthSentinel,
      },
    ],
    sentinel: synthSentinel,
  };
}

interface AgentObservationSynthesisRunnerDeps {
  readonly chatLlm: ChatLlmPort;
  readonly logger?: Pick<typeof defaultLog, 'error' | 'info' | 'warn'> | undefined;
}

export class AgentObservationSynthesisRunner {
  private readonly logger: Pick<typeof defaultLog, 'error' | 'info' | 'warn'>;

  constructor(private readonly deps: AgentObservationSynthesisRunnerDeps) {
    this.logger = deps.logger ?? defaultLog;
  }

  async run(
    query: string,
    requestId: string,
    effectiveConfig: AgentConfig,
    state: AgentExecutionState,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    if (state.totalInputTokens + state.totalOutputTokens >= effectiveConfig.maxTotalTokens) {
      this.logger.warn({ requestId, totalInputTokens: state.totalInputTokens, totalOutputTokens: state.totalOutputTokens, budget: effectiveConfig.maxTotalTokens }, '[agent] token budget exhausted — skipping final answer synthesis to prevent overrun');
      return;
    }

    const obsSteps = state.steps.filter(
      (s) =>
        (s.observation !== undefined && s.observation.length > 0) ||
        (s.actionPairs !== undefined && s.actionPairs.some((p) => p.observation.length > 0)),
    );
    if (obsSteps.length === 0) {
      return;
    }

    const { messages: synthMessages, sentinel: synthSentinel } = buildObservationSynthesisMessages(query, obsSteps, state.toolOutcomes, requestId);
    const attemptSynthesis = async (maxOutputTokens: number): Promise<string | undefined> => {
      if (abortSignal?.aborted) return undefined;
      const synthAbort = new AbortController();
      const propagateSynthAbort = (): void => { synthAbort.abort(); };
      abortSignal?.addEventListener('abort', propagateSynthAbort, { once: true });
      if (abortSignal?.aborted) {
        synthAbort.abort();
        abortSignal.removeEventListener('abort', propagateSynthAbort);
        return undefined;
      }
      const synthTimer = setTimeout(() => {
        synthAbort.abort();
      }, SYNTHESIS_TIMEOUT_MS);
      try {
        const synthResult: LlmResult = await this.deps.chatLlm.complete({
          messages: synthMessages,
          temperature: 0,
          maxOutputTokens,
          ...(effectiveConfig.seed !== undefined ? { seed: effectiveConfig.seed } : {}),
          abortSignal: synthAbort.signal,
        });
        if (!isValidLlmResult(synthResult)) {
          this.logger.warn({ requestId }, 'synthesis LLM returned malformed result');
          return undefined;
        }
        state.totalInputTokens += estimateTokenCount(synthSentinel);
        state.totalOutputTokens += estimateTokenCount(synthResult.text);
        const parsedSynth = parseLlmJsonObject(synthResult.text);
        if (parsedSynth === null) {
          this.logger.warn({ requestId }, 'synthesis LLM returned non-JSON output — ignoring, falling to next layer');
          return undefined;
        }
        if (
          parsedSynth['action'] !== undefined ||
          parsedSynth['actions'] !== undefined ||
          parsedSynth['tool'] !== undefined
        ) {
          this.logger.warn({ requestId }, 'synthesis LLM returned tool call — ignoring, falling to next layer');
          return undefined;
        }
        const answer = parsedSynth['answer'];
        if (typeof answer !== 'string') {
          this.logger.warn({ requestId }, 'synthesis LLM returned JSON without answer — ignoring, falling to next layer');
          return undefined;
        }
        const candidate = answer.trim();
        return candidate.length > 0 ? candidate : undefined;
      } finally {
        abortSignal?.removeEventListener('abort', propagateSynthAbort);
        clearTimeout(synthTimer);
      }
    };

    let synthAnswer: string | undefined;
    let shouldRetrySynthesis = true;
    try {
      synthAnswer = await attemptSynthesis(SYNTHESIS_TOKENS_ATTEMPT_1);
    } catch (synthErr1) {
      if (synthErr1 instanceof DomainError && synthErr1.code === CIRCUIT_BREAKER_OPEN_CODE) {
        state.llmCircuitOpen = true;
      } else if (isAbortError(synthErr1)) {
        state.terminationReason = 'aborted';
      }
      shouldRetrySynthesis = false;
      this.logger.error(
        { err: synthErr1, requestId },
        'synthesis attempt 1 failed — skipping retry and falling through to recovery layers',
      );
    }
    if (synthAnswer === undefined) {
      state.failedSynthesisAttempts += 1;
    }
    if (
      synthAnswer === undefined &&
      shouldRetrySynthesis &&
      !(abortSignal?.aborted) &&
      !state.llmCircuitOpen &&
      state.totalInputTokens + state.totalOutputTokens < effectiveConfig.maxTotalTokens
    ) {
      try {
        this.logger.info({ requestId, obsSteps: obsSteps.length }, `synthesis attempt 1 returned empty — retrying with maxOutputTokens=${SYNTHESIS_TOKENS_ATTEMPT_2}`);
        synthAnswer = await attemptSynthesis(SYNTHESIS_TOKENS_ATTEMPT_2);
      } catch (synthErr2) {
        if (synthErr2 instanceof DomainError && synthErr2.code === CIRCUIT_BREAKER_OPEN_CODE) {
          state.llmCircuitOpen = true;
        } else if (isAbortError(synthErr2)) {
          state.terminationReason = 'aborted';
        }
        this.logger.error({ err: synthErr2, requestId }, 'synthesis retry attempt 2 failed — proceeding to fallback search');
      }
      if (synthAnswer === undefined) {
        state.failedSynthesisAttempts += 1;
      }
    }
    if (synthAnswer !== undefined) {
      state.answer = synthAnswer;
      state.terminationReason = 'answer';
      this.logger.info({ requestId, obsSteps: obsSteps.length }, 'synthesized answer from observations');
    }
  }
}
