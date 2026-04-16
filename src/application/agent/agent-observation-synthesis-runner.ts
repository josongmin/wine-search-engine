import type { ChatLlmPort, ChatMessage } from '../../domain/ai/port/chat-llm.port.js';
import type { AgentConfig } from '../../domain/agent/model/agent-config.js';
import { DomainError } from '../../domain/shared/error/domain-error.js';
import { CIRCUIT_BREAKER_OPEN_CODE } from '../../domain/shared/error/circuit-breaker-open-error.js';
import { isAbortError } from '../../domain/shared/cooperative-abort.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import {
  buildSynthesisSystemMessage,
  buildStepMessages,
  buildUserMessage,
} from './agent-prompt.js';
import type { AgentExecutionState } from './agent-execution-state.js';
import {
  isValidLlmResult,
  parseLlmOutput,
} from './agent-llm-output.js';

const log = bootstrapLogger.child({ component: 'AgentObservationSynthesisRunner' });
const SYNTHESIS_TIMEOUT_MS = 60_000;
const SYNTHESIS_TOKENS_ATTEMPT_1 = 512;
const SYNTHESIS_TOKENS_ATTEMPT_2 = 256;
const CHARS_PER_TOKEN_ESTIMATE = 4;

interface ObservationSynthesisMessages {
  readonly messages: readonly ChatMessage[];
  readonly sentinel: string;
}

function buildObservationSynthesisMessages(
  query: string,
  steps: AgentExecutionState['steps'],
  requestId: string,
): ObservationSynthesisMessages {
  const synthSentinel = `[SYSTEM:${requestId}:FINAL_ANSWER_REQUIRED]\nYou have exhausted your step budget. Synthesize the tool results above into a final answer now.\nOutput ONLY this JSON — no other text, no code fences:\n{"thought":"one-sentence summary of findings","answer":"your complete, grounded response in the user's language (Korean if query was Korean)"}\nRules:\n- "answer" must reference specific wines, regions, or prices from the tool results above.\n- Do NOT call any tool. Do NOT output "action" or "actions".\n- If results were empty, tell the user no match was found and suggest broadening the search.`;
  return {
    messages: [
      buildSynthesisSystemMessage(),
      buildUserMessage(query),
      ...buildStepMessages(steps),
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
}

export class AgentObservationSynthesisRunner {
  constructor(private readonly deps: AgentObservationSynthesisRunnerDeps) {}

  async run(
    query: string,
    requestId: string,
    effectiveConfig: AgentConfig,
    state: AgentExecutionState,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    if (state.totalInputTokens + state.totalOutputTokens >= effectiveConfig.maxTotalTokens) {
      log.warn({ requestId, totalInputTokens: state.totalInputTokens, totalOutputTokens: state.totalOutputTokens, budget: effectiveConfig.maxTotalTokens }, '[agent] token budget exhausted — skipping final answer synthesis to prevent overrun');
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

    const { messages: synthMessages, sentinel: synthSentinel } = buildObservationSynthesisMessages(query, state.steps, requestId);
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
        const synthResult = await this.deps.chatLlm.complete({
          messages: synthMessages,
          temperature: 0,
          maxOutputTokens,
          ...(effectiveConfig.seed !== undefined ? { seed: effectiveConfig.seed } : {}),
          abortSignal: synthAbort.signal,
        });
        if (!isValidLlmResult(synthResult)) {
          log.warn({ requestId }, 'synthesis LLM returned malformed result');
          return undefined;
        }
        state.totalInputTokens += Math.ceil(synthSentinel.length / CHARS_PER_TOKEN_ESTIMATE);
        state.totalOutputTokens += Math.ceil(synthResult.text.length / CHARS_PER_TOKEN_ESTIMATE);
        const parsedSynth = parseLlmOutput(synthResult.text);
        if (parsedSynth.action !== undefined || parsedSynth.actions !== undefined) {
          log.warn({ requestId }, 'synthesis LLM returned tool call — ignoring, falling to next layer');
          return undefined;
        }
        const candidate = parsedSynth.answer?.trim() ?? '';
        const isShell = /^[{[\s]*[}\]]*$/.test(candidate);
        return candidate.length > 10 && !isShell ? candidate : undefined;
      } finally {
        abortSignal?.removeEventListener('abort', propagateSynthAbort);
        clearTimeout(synthTimer);
      }
    };

    let synthAnswer: string | undefined;
    try {
      synthAnswer = await attemptSynthesis(SYNTHESIS_TOKENS_ATTEMPT_1);
    } catch (synthErr1) {
      if (synthErr1 instanceof DomainError && synthErr1.code === CIRCUIT_BREAKER_OPEN_CODE) {
        state.llmCircuitOpen = true;
      } else if (isAbortError(synthErr1)) {
        state.terminationReason = 'aborted';
      }
      log.error({ err: synthErr1, requestId }, `synthesis retry attempt 1 failed (timeout/error) — retrying with maxOutputTokens=${SYNTHESIS_TOKENS_ATTEMPT_2}`);
    }
    if (synthAnswer === undefined) {
      state.failedSynthesisAttempts += 1;
    }
    if (
      synthAnswer === undefined &&
      !(abortSignal?.aborted) &&
      !state.llmCircuitOpen &&
      state.totalInputTokens + state.totalOutputTokens < effectiveConfig.maxTotalTokens
    ) {
      try {
        log.info({ requestId, obsSteps: obsSteps.length }, `synthesis attempt 1 returned empty — retrying with maxOutputTokens=${SYNTHESIS_TOKENS_ATTEMPT_2}`);
        synthAnswer = await attemptSynthesis(SYNTHESIS_TOKENS_ATTEMPT_2);
      } catch (synthErr2) {
        if (synthErr2 instanceof DomainError && synthErr2.code === CIRCUIT_BREAKER_OPEN_CODE) {
          state.llmCircuitOpen = true;
        } else if (isAbortError(synthErr2)) {
          state.terminationReason = 'aborted';
        }
        log.error({ err: synthErr2, requestId }, 'synthesis retry attempt 2 failed — proceeding to fallback search');
      }
      if (synthAnswer === undefined) {
        state.failedSynthesisAttempts += 1;
      }
    }
    if (synthAnswer !== undefined) {
      state.answer = synthAnswer;
      state.terminationReason = 'answer';
      log.info({ requestId, obsSteps: obsSteps.length }, 'synthesized answer from observations');
    }
  }
}
