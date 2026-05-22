import { z } from 'zod';
import type { ChatLlmPort, ChatMessage } from '../../domain/ai/port/chat-llm.port.js';
import type { AgentConfig } from '../../domain/agent/model/agent-config.js';
import type { AgentStep } from '../../domain/agent/model/agent-step.js';
import { DomainError } from '../../domain/shared/error/domain-error.js';
import { CIRCUIT_BREAKER_OPEN_CODE } from '../../domain/shared/error/circuit-breaker-open-error.js';
import { isAbortError } from '../../domain/shared/cooperative-abort.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import {
  buildSynthesisSystemMessage,
  buildUserMessage,
} from './agent-prompt.js';
import type { AgentExecutionState } from './agent-execution-state.js';
import type { ToolOutcome } from '../../domain/agent/model/tool-outcome.js';
import {
  estimateTokenCount,
  isValidLlmResult,
  parseLlmJsonObject,
  type LlmResult,
} from './agent-llm-output.js';
import { transitionTerminationReason } from '../../domain/agent/service/termination-state-machine.js';

const defaultLog = bootstrapLogger.child({ component: 'AgentObservationSynthesisRunner' });
const SYNTHESIS_TIMEOUT_MS = 12_000;
const SYNTHESIS_TOKENS_ATTEMPT_1 = 512;
const SYNTHESIS_TOKENS_ATTEMPT_2 = 256;
// RC3 high-fan-out collapse guard. When the agent collected this many grounded
// search outcomes, a one-word answer like "좋습니다." is a synthesis COLLAPSE
// (the model ignored the per-entity findings), not a legitimate terse reply —
// reject it and retry with the structured per-entity directive. The minimum
// acceptable answer length scales with the number of grounded outcomes
// (groundedCount × MIN_CHARS_PER_OUTCOME) so a 3-vintage comparison must be at
// least ~30 chars; below that the per-entity content provably cannot be present.
const HIGH_FAN_OUT_GROUNDED_OUTCOME_THRESHOLD = 3;
const HIGH_FAN_OUT_MIN_CHARS_PER_OUTCOME = 10;

function hasKoreanText(text: string): boolean {
  return /[\p{Script=Hangul}]/u.test(text);
}

function extractSearchResultCount(rawResult: unknown): number | undefined {
  if (rawResult === null || rawResult === undefined || typeof rawResult !== 'object') {
    return undefined;
  }

  const result = rawResult as Record<string, unknown>;

  if (
    typeof result['queryType'] === 'string'
    && result['queryType'] === 'search'
    && Array.isArray(result['results'])
  ) {
    return result['results'].length;
  }

  if (result['kind'] === 'search_result_set' && typeof result['resultCount'] === 'number') {
    return result['resultCount'];
  }

  if (Array.isArray(result['resultSet'])) {
    return result['resultSet'].length;
  }

  return undefined;
}

function isSearchSuccessWithData(outcome: ToolOutcome): boolean {
  if (outcome.tool !== 'search_wines') {
    return false;
  }

  if (outcome.kind !== 'success' && outcome.kind !== 'partial_result') {
    return false;
  }

  const searchResultCount = extractSearchResultCount(outcome.result);
  return searchResultCount === undefined ? true : searchResultCount > 0;
}

function hasNoGroundedSearchResults(outcomes: readonly ToolOutcome[]): boolean {
  const searchOutcomes = outcomes.filter((outcome) => outcome.tool === 'search_wines');
  if (searchOutcomes.length === 0) {
    return false;
  }
  return !searchOutcomes.some(isSearchSuccessWithData);
}

/** Number of grounded (non-empty) search outcomes — drives the fan-out class. */
function countGroundedSearchOutcomes(outcomes: readonly ToolOutcome[]): number {
  let count = 0;
  for (const outcome of outcomes) {
    if (isSearchSuccessWithData(outcome)) {
      count += 1;
    }
  }
  return count;
}

function buildNoMatchSynthesisAnswer(query: string): string {
  return hasKoreanText(query)
    ? '현재 조건으로는 검색 결과를 찾지 못했습니다. 핵심 조건을 하나씩 완화해 다시 검색해보세요.'
    : 'No matching wine was found under the provided constraints. Relax one constraint and retry.';
}

interface ObservationSynthesisMessages {
  readonly messages: readonly ChatMessage[];
  readonly sentinel: string;
}

const GROUNDING_JSON_MARKER = 'GROUNDING_JSON: ';

/**
 * Fence schema for the GROUNDING_JSON payload embedded in tool observations.
 *
 * Why this fence exists: agent observation strings end with a synthetic
 * `GROUNDING_JSON: {…}` envelope produced by `agent-tools.ts`. The synthesis
 * prompt builder previously forwarded that envelope verbatim. If the embedded
 * JSON was malformed (truncated by an observation cap, mutated by a buggy
 * upstream pass, or shaped wrong by a future tool), the LLM would hallucinate
 * against corrupted ground truth. The fence parses + validates the payload
 * shape before the frame is admitted to the synthesis prompt; failures cause
 * the frame to be dropped with a structured logger warning.
 *
 * `.passthrough()` is used because the wine entries carry many optional
 * domain fields (price_krw_approx, claimable_attributes, profile_evidence …)
 * and we don't want the fence to false-positive on legitimate new fields.
 */
const GroundingJsonWineSchema = z.object({}).passthrough();
const GroundingJsonPayloadSchema = z.object({
  wines: z.array(GroundingJsonWineSchema),
}).passthrough();

type GroundingFenceWarn = (
  ctx: { readonly requestId: string; readonly stepIndex: number; readonly tool: string; readonly reason: string },
) => void;

function extractGroundingForSynthesis(
  observation: string,
  ctx: { readonly requestId: string; readonly stepIndex: number; readonly tool: string },
  onMalformed: GroundingFenceWarn,
): string | undefined {
  const groundingIndex = observation.lastIndexOf(GROUNDING_JSON_MARKER);
  if (groundingIndex < 0) {
    return observation;
  }
  const groundingOnly = observation.slice(groundingIndex).trim();
  if (groundingOnly.length === 0) {
    return observation;
  }
  const rawJson = groundingOnly.slice(GROUNDING_JSON_MARKER.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    onMalformed({ ...ctx, reason: `JSON.parse failed: ${(err as Error).message}` });
    return undefined;
  }
  const validation = GroundingJsonPayloadSchema.safeParse(parsed);
  if (!validation.success) {
    onMalformed({ ...ctx, reason: `schema validation failed: ${validation.error.issues[0]?.message ?? 'unknown'}` });
    return undefined;
  }
  return groundingOnly;
}

function buildObservationOnlyMessages(
  steps: readonly AgentStep[],
  ctx: { readonly requestId: string; readonly maxContextChars?: number },
  onMalformed: GroundingFenceWarn,
): readonly ChatMessage[] {
  const candidates: ChatMessage[] = [];

  for (const step of steps) {
    if (step.actionPairs !== undefined) {
      for (const pair of step.actionPairs) {
        const compact = extractGroundingForSynthesis(
          pair.observation,
          { requestId: ctx.requestId, stepIndex: step.index, tool: pair.action.tool },
          onMalformed,
        );
        if (compact === undefined) {
          continue;
        }
        candidates.push({
          role: 'user',
          content: `[Tool Result: ${pair.action.tool}]\n${compact}`,
        });
      }
      continue;
    }

    if (step.action !== undefined && step.observation !== undefined && step.observation.length > 0) {
      const compact = extractGroundingForSynthesis(
        step.observation,
        { requestId: ctx.requestId, stepIndex: step.index, tool: step.action.tool },
        onMalformed,
      );
      if (compact === undefined) {
        continue;
      }
      candidates.push({
        role: 'user',
        content: `[Tool Result: ${step.action.tool}]\n${compact}`,
      });
    }
  }

  // Budget the observation context to maxContextChars: admit messages (in step
  // order, so the earliest grounded observations win) until the running total
  // would exceed the budget. Always keep at least one so synthesis never runs
  // blind, and never truncate a message body — each kept message preserves its
  // full GROUNDING_JSON payload. Unset/non-positive budget = no limit.
  const budget = ctx.maxContextChars;
  if (budget === undefined || budget <= 0 || candidates.length === 0) {
    return candidates;
  }
  const budgeted: ChatMessage[] = [];
  let runningChars = 0;
  for (const message of candidates) {
    const nextChars = runningChars + message.content.length;
    if (budgeted.length > 0 && nextChars > budget) {
      break;
    }
    budgeted.push(message);
    runningChars = nextChars;
  }
  return budgeted;
}

function buildObservationSynthesisMessages(
  query: string,
  steps: readonly AgentStep[],
  toolOutcomes: readonly ToolOutcome[],
  requestId: string,
  onMalformedGrounding: GroundingFenceWarn,
  options?: { readonly maxContextChars?: number; readonly structured?: boolean },
): ObservationSynthesisMessages {
  // Structured retry sentinel (RC3): used after a high-fan-out synthesis
  // COLLAPSE. It forces an answer that summarizes EACH wine/vintage so the
  // per-entity findings cannot be flattened into a single content-free reply.
  const synthSentinel = options?.structured === true
    ? `[SYSTEM:${requestId}:STRUCTURED_FINAL_ANSWER_REQUIRED]\nYour previous answer collapsed the multiple grounded results into a single content-free reply. Produce a FINAL answer that summarizes EACH wine/vintage in the tool results above.\nOutput ONLY this JSON — no other text, no code fences:\n{"thought":"one-sentence summary","answer":"a per-entity summary in the user's language (Korean if query was Korean) that names EACH wine/vintage and its key attribute (region/price/drinking window)"}\nRules:\n- "answer" MUST reference every distinct wine/vintage from the tool results above by name.\n- Do NOT call any tool. Do NOT output "action" or "actions".`
    : `[SYSTEM:${requestId}:FINAL_ANSWER_REQUIRED]\nYou have exhausted your step budget. Synthesize the tool results above into a final answer now.\nOutput ONLY this JSON — no other text, no code fences:\n{"thought":"one-sentence summary of findings","answer":"your complete, grounded response in the user's language (Korean if query was Korean)"}\nRules:\n- "answer" must reference specific wines, regions, or prices from the tool results above.\n- Do NOT call any tool. Do NOT output "action" or "actions".\n- If results were empty, tell the user no match was found and suggest broadening the search.`;
  const nonSuccessToolOutcomes = toolOutcomes.filter((outcome) =>
    outcome.kind !== 'success'
    || outcome.errorMessage !== undefined
    || (outcome.postconditionViolations?.length ?? 0) > 0,
  );
  const typedOutcomeRows = nonSuccessToolOutcomes.map((outcome) => {
    const searchResultCount = extractSearchResultCount(outcome.result);
    return {
      stepId: outcome.stepId,
      tool: outcome.tool,
      kind: outcome.kind,
      errorMessage: outcome.errorMessage,
      postconditionViolations: outcome.postconditionViolations,
      ...(searchResultCount !== undefined ? { searchResultCount } : {}),
    };
  });
  const typedOutcomeMessage: ChatMessage | undefined = typedOutcomeRows.length > 0
    ? {
        role: 'user',
        content: `[Typed Tool Outcomes]\n${JSON.stringify(typedOutcomeRows)}`
      }
    : undefined;
  return {
    messages: [
      buildSynthesisSystemMessage(),
      buildUserMessage(query),
      ...buildObservationOnlyMessages(
        steps,
        {
          requestId,
          ...(options?.maxContextChars !== undefined ? { maxContextChars: options.maxContextChars } : {}),
        },
        onMalformedGrounding,
      ),
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
    if (hasNoGroundedSearchResults(state.toolOutcomes)) {
      state.answer = buildNoMatchSynthesisAnswer(query);
      state.failedSynthesisAttempts += 1;
      state.reasoningFailureDetected = true;
      state.terminationReason = transitionTerminationReason(state.terminationReason, 'fallback');
      state.fallbackApplied = true;
      state.fallbackLayer = 'layer3';
      this.logger.warn({ requestId, obsSteps: obsSteps.length }, 'all search outcomes were empty or failed — short-circuiting synthesis to no-match response');
      return;
    }

    const onMalformedGrounding: GroundingFenceWarn = (ctx) => {
      this.logger.warn(
        {
          requestId: ctx.requestId,
          stepIndex: ctx.stepIndex,
          tool: ctx.tool,
          malformedGrounding: true,
          reason: ctx.reason,
        },
        'grounding JSON failed validation — dropping frame from synthesis prompt',
      );
    };
    // RC3 high-fan-out class: when several grounded outcomes were collected, a
    // one-word answer is a synthesis COLLAPSE — reject it and retry with the
    // per-entity structured directive (leaving recovery to the orchestrator if
    // both attempts collapse).
    const groundedCount = countGroundedSearchOutcomes(state.toolOutcomes);
    const isHighFanOut = groundedCount >= HIGH_FAN_OUT_GROUNDED_OUTCOME_THRESHOLD;
    const minAnswerChars = isHighFanOut ? groundedCount * HIGH_FAN_OUT_MIN_CHARS_PER_OUTCOME : 0;
    const isCollapsedAnswer = (candidate: string): boolean =>
      isHighFanOut && candidate.length < minAnswerChars;

    const defaultMessages = buildObservationSynthesisMessages(
      query, obsSteps, state.toolOutcomes, requestId, onMalformedGrounding,
      { maxContextChars: effectiveConfig.maxContextChars },
    );
    const structuredMessages = buildObservationSynthesisMessages(
      query, obsSteps, state.toolOutcomes, requestId, onMalformedGrounding,
      { maxContextChars: effectiveConfig.maxContextChars, structured: true },
    );
    const attemptSynthesis = async (
      maxOutputTokens: number,
      messageSet: ObservationSynthesisMessages,
    ): Promise<string | undefined> => {
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
          messages: messageSet.messages,
          temperature: 0,
          maxOutputTokens,
          ...(effectiveConfig.seed !== undefined ? { seed: effectiveConfig.seed } : {}),
          abortSignal: synthAbort.signal,
        });
        if (!isValidLlmResult(synthResult)) {
          this.logger.warn({ requestId }, 'synthesis LLM returned malformed result');
          return undefined;
        }
        state.totalInputTokens += estimateTokenCount(messageSet.sentinel);
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
        if (candidate.length === 0) {
          return undefined;
        }
        if (isCollapsedAnswer(candidate)) {
          this.logger.warn(
            { requestId, groundedCount, answerChars: candidate.length, minAnswerChars },
            'high-fan-out synthesis collapsed into a near-empty answer — rejecting',
          );
          return undefined;
        }
        return candidate;
      } finally {
        abortSignal?.removeEventListener('abort', propagateSynthAbort);
        clearTimeout(synthTimer);
      }
    };

    let synthAnswer: string | undefined;
    let shouldRetrySynthesis = true;
    try {
      synthAnswer = await attemptSynthesis(SYNTHESIS_TOKENS_ATTEMPT_1, defaultMessages);
    } catch (synthErr1) {
      if (synthErr1 instanceof DomainError && synthErr1.code === CIRCUIT_BREAKER_OPEN_CODE) {
        state.llmCircuitOpen = true;
      } else if (isAbortError(synthErr1)) {
        state.terminationReason = transitionTerminationReason(state.terminationReason, 'aborted');
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
        // On high fan-out, attempt 1 was rejected as a collapse → retry with the
        // structured per-entity directive; otherwise retry the default prompt.
        const retryMessages = isHighFanOut ? structuredMessages : defaultMessages;
        this.logger.info({ requestId, obsSteps: obsSteps.length, structuredRetry: isHighFanOut }, `synthesis attempt 1 returned empty — retrying with maxOutputTokens=${SYNTHESIS_TOKENS_ATTEMPT_2}`);
        synthAnswer = await attemptSynthesis(SYNTHESIS_TOKENS_ATTEMPT_2, retryMessages);
      } catch (synthErr2) {
        if (synthErr2 instanceof DomainError && synthErr2.code === CIRCUIT_BREAKER_OPEN_CODE) {
          state.llmCircuitOpen = true;
        } else if (isAbortError(synthErr2)) {
          state.terminationReason = transitionTerminationReason(state.terminationReason, 'aborted');
        }
        this.logger.error({ err: synthErr2, requestId }, 'synthesis retry attempt 2 failed — proceeding to fallback search');
      }
      if (synthAnswer === undefined) {
        state.failedSynthesisAttempts += 1;
      }
    }
    if (synthAnswer !== undefined) {
      state.answer = synthAnswer;
      state.terminationReason = transitionTerminationReason(state.terminationReason, 'answer');
      this.logger.info({ requestId, obsSteps: obsSteps.length }, 'synthesized answer from observations');
    }
  }
}
