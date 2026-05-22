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

// ── RC3: high-fan-out synthesis robustness ───────────────────────────────
//
// Scenario class: "compare 3 vintages + drinking window" yields many tool
// outcomes (3 vintages × multiple dimensions). Two failure modes were
// observed: (a) the unbounded observation history overruns the context
// budget and degrades synthesis, and (b) the LLM collapses to a near-empty
// 1-sentence answer that can't possibly cover the comparison, yet the runner
// accepted ANY non-empty string and terminated as 'answer' — never letting
// the structured Layer-3 grounding preview recover.

/**
 * A synthesis is "high fan-out" when this many or more distinct grounded
 * search/comparison outcomes feed the prompt. At/above this count a single
 * short sentence cannot faithfully cover the material, so the min-answer
 * guarantee (below) applies. Below it, short answers stay legitimate
 * (single-entity yes/no queries like "is X drinkable now?").
 */
const HIGH_FAN_OUT_GROUNDED_OUTCOME_THRESHOLD = 2;

/**
 * Minimum acceptable answer length (chars) for a HIGH-FAN-OUT synthesis with
 * grounded material. An answer shorter than this when ≥2 grounded outcomes
 * exist is treated as a collapsed/near-empty answer (a failed attempt), so the
 * runner retries / falls through to the structured grounding preview rather
 * than terminating with an empty-feeling response. Calibrated against the
 * shortest legitimate multi-entity comparison answer (~2 short clauses).
 */
const MIN_HIGH_FAN_OUT_ANSWER_CHARS = 40;

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

/**
 * RC3: count distinct grounded outcomes that contribute synthesis material.
 *
 * A grounded outcome is a success/partial_result tool call that carries usable
 * data — search results with hits, or any non-search grounding tool (e.g.
 * check_drinking_window, compare_wines) that succeeded. This is the fan-out
 * signal: many grounded outcomes ⇒ a comparison/multi-entity answer is
 * expected, so a single short sentence is a collapse.
 */
function countGroundedOutcomes(outcomes: readonly ToolOutcome[]): number {
  let count = 0;
  for (const outcome of outcomes) {
    if (outcome.kind !== 'success' && outcome.kind !== 'partial_result') {
      continue;
    }
    if (outcome.tool === 'search_wines') {
      if (isSearchSuccessWithData(outcome)) {
        count += 1;
      }
      continue;
    }
    // Non-search grounding tool that succeeded contributes one grounded leg.
    count += 1;
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

function compactObservationForSynthesis(observation: string): string {
  const groundingIndex = observation.lastIndexOf(GROUNDING_JSON_MARKER);
  if (groundingIndex < 0) {
    return observation;
  }
  const groundingOnly = observation.slice(groundingIndex).trim();
  return groundingOnly.length > 0 ? groundingOnly : observation;
}

interface RankedObservationMessage {
  readonly content: string;
  /** True when the observation carries a GROUNDING_JSON payload (highest priority). */
  readonly hasGrounding: boolean;
}

function collectObservationMessages(steps: readonly AgentStep[]): RankedObservationMessage[] {
  const messages: RankedObservationMessage[] = [];

  for (const step of steps) {
    if (step.actionPairs !== undefined) {
      for (const pair of step.actionPairs) {
        const compacted = compactObservationForSynthesis(pair.observation);
        messages.push({
          content: `[Tool Result: ${pair.action.tool}]\n${compacted}`,
          hasGrounding: pair.observation.includes(GROUNDING_JSON_MARKER),
        });
      }
      continue;
    }

    if (step.action !== undefined && step.observation !== undefined && step.observation.length > 0) {
      const compacted = compactObservationForSynthesis(step.observation);
      messages.push({
        content: `[Tool Result: ${step.action.tool}]\n${compacted}`,
        hasGrounding: step.observation.includes(GROUNDING_JSON_MARKER),
      });
    }
  }

  return messages;
}

/**
 * RC3: deterministically budget observation messages against maxContextChars.
 *
 * High-fan-out synthesis (3 vintages × multiple dimensions) can produce far
 * more observation text than the context budget. Rather than letting the tail
 * silently overrun (which degrades synthesis and can collapse the answer), we:
 *   1. preserve insertion order (chronological tool history — stable & readable),
 *   2. prioritize grounding-bearing observations so they are never dropped to
 *      fit lower-value raw-text observations,
 *   3. include messages until the running char budget is exhausted.
 *
 * The selection is fully deterministic (no scoring randomness): grounding-first,
 * then chronological, capped at maxContextChars. When a single grounding message
 * alone exceeds the budget it is still included (truncated by the model side via
 * the existing compaction) so we never strip away the material synthesis needs.
 */
function budgetObservationMessages(
  ranked: readonly RankedObservationMessage[],
  maxContextChars: number,
): readonly ChatMessage[] {
  if (ranked.length === 0) return [];

  // Stable order index so the partition preserves chronological order within
  // each priority tier (CLAUDE.md: deterministic tie-breaking, no iteration-order reliance).
  const indexed = ranked.map((message, index) => ({ message, index }));
  const groundingFirst = [...indexed].sort((a, b) => {
    if (a.message.hasGrounding !== b.message.hasGrounding) {
      return a.message.hasGrounding ? -1 : 1;
    }
    return a.index - b.index;
  });

  const selectedIndexes = new Set<number>();
  let usedChars = 0;
  for (const { message, index } of groundingFirst) {
    const cost = message.content.length;
    // Always include at least the first (highest-priority) message even if it
    // alone exceeds the budget — dropping all grounding would cause the very
    // collapse this guards against.
    if (selectedIndexes.size > 0 && usedChars + cost > maxContextChars) {
      continue;
    }
    selectedIndexes.add(index);
    usedChars += cost;
  }

  // Emit in original chronological order for a coherent tool-history narrative.
  return indexed
    .filter(({ index }) => selectedIndexes.has(index))
    .map(({ message }) => ({ role: 'user', content: message.content } satisfies ChatMessage));
}

function buildObservationOnlyMessages(
  steps: readonly AgentStep[],
  maxContextChars: number,
): readonly ChatMessage[] {
  return budgetObservationMessages(collectObservationMessages(steps), maxContextChars);
}

function buildObservationSynthesisMessages(
  query: string,
  steps: readonly AgentStep[],
  toolOutcomes: readonly ToolOutcome[],
  requestId: string,
  maxContextChars: number,
): ObservationSynthesisMessages {
  const synthSentinel = `[SYSTEM:${requestId}:FINAL_ANSWER_REQUIRED]\nYou have exhausted your step budget. Synthesize the tool results above into a final answer now.\nOutput ONLY this JSON — no other text, no code fences:\n{"thought":"one-sentence summary of findings","answer":"your complete, grounded response in the user's language (Korean if query was Korean)"}\nRules:\n- "answer" must reference specific wines, regions, or prices from the tool results above.\n- Do NOT call any tool. Do NOT output "action" or "actions".\n- If results were empty, tell the user no match was found and suggest broadening the search.`;
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
      ...buildObservationOnlyMessages(steps, maxContextChars),
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
      state.terminationReason = 'fallback';
      state.fallbackApplied = true;
      state.fallbackLayer = 'layer3';
      this.logger.warn({ requestId, obsSteps: obsSteps.length }, 'all search outcomes were empty or failed — short-circuiting synthesis to no-match response');
      return;
    }

    // RC3: high-fan-out detection drives the min-answer guarantee. ≥2 grounded
    // outcomes (e.g. 3-vintage compare + drinking window) means a single short
    // sentence cannot faithfully cover the material — a collapsed answer is a
    // failure that should retry / fall through, not terminate as 'answer'.
    const groundedOutcomeCount = countGroundedOutcomes(state.toolOutcomes);
    const isHighFanOut = groundedOutcomeCount >= HIGH_FAN_OUT_GROUNDED_OUTCOME_THRESHOLD;

    const { messages: synthMessages, sentinel: synthSentinel } = buildObservationSynthesisMessages(
      query,
      obsSteps,
      state.toolOutcomes,
      requestId,
      effectiveConfig.maxContextChars,
    );
    // RC3: structured per-entity retry. On high-fan-out, the second attempt
    // swaps the terminal instruction for an explicit per-entity summarization
    // directive so the LLM enumerates each grounded wine/vintage rather than
    // collapsing to one sentence.
    const structuredSentinel = `[SYSTEM:${requestId}:STRUCTURED_FINAL_ANSWER_REQUIRED]\nYour previous answer was too short to cover the ${groundedOutcomeCount} grounded results above. Produce a COMPLETE answer that summarizes EACH wine/vintage from the tool results as its own clause or bullet (name + the key facts: region/price/vintage/drinking window where present), then a one-line comparative takeaway.\nOutput ONLY this JSON — no other text, no code fences:\n{"thought":"one-sentence summary","answer":"per-entity grounded answer in the user's language (Korean if the query was Korean)"}\nRules:\n- Reference every grounded wine by name; do NOT omit any leg of the comparison.\n- Do NOT call any tool. Do NOT output "action" or "actions".`;
    const structuredMessages: readonly ChatMessage[] = synthMessages.map((message) =>
      message.content === synthSentinel ? { ...message, content: structuredSentinel } : message,
    );
    const attemptSynthesis = async (
      maxOutputTokens: number,
      messages: readonly ChatMessage[] = synthMessages,
      sentinel: string = synthSentinel,
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
          messages,
          temperature: 0,
          maxOutputTokens,
          ...(effectiveConfig.seed !== undefined ? { seed: effectiveConfig.seed } : {}),
          abortSignal: synthAbort.signal,
        });
        if (!isValidLlmResult(synthResult)) {
          this.logger.warn({ requestId }, 'synthesis LLM returned malformed result');
          return undefined;
        }
        state.totalInputTokens += estimateTokenCount(sentinel);
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
        // RC3 min-answer guarantee: on high-fan-out grounded synthesis, reject a
        // collapsed answer that cannot cover the material. Returning undefined
        // makes this count as a failed attempt so the retry (with the structured
        // per-entity prompt) runs, and failing that, the orchestrator's Layer-3
        // structured grounding preview recovers — instead of terminating with a
        // near-empty 'answer'. Single-entity / low-fan-out answers are NOT gated,
        // preserving legitimate short responses (e.g. "지금 마셔도 됩니다.").
        if (isHighFanOut && candidate.length < MIN_HIGH_FAN_OUT_ANSWER_CHARS) {
          this.logger.warn(
            { requestId, groundedOutcomeCount, answerChars: candidate.length, minChars: MIN_HIGH_FAN_OUT_ANSWER_CHARS },
            'high-fan-out synthesis produced a collapsed near-empty answer — treating as failed attempt to trigger retry/structured fallback',
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
        // RC3: on high-fan-out, retry with the structured per-entity prompt and
        // the larger token budget (a per-entity summary needs more room than the
        // shrunk attempt-2 budget). Low-fan-out keeps the original cheaper retry.
        if (isHighFanOut) {
          this.logger.info({ requestId, obsSteps: obsSteps.length, groundedOutcomeCount }, 'synthesis attempt 1 collapsed/empty on high-fan-out — retrying with structured per-entity prompt');
          synthAnswer = await attemptSynthesis(SYNTHESIS_TOKENS_ATTEMPT_1, structuredMessages, structuredSentinel);
        } else {
          this.logger.info({ requestId, obsSteps: obsSteps.length }, `synthesis attempt 1 returned empty — retrying with maxOutputTokens=${SYNTHESIS_TOKENS_ATTEMPT_2}`);
          synthAnswer = await attemptSynthesis(SYNTHESIS_TOKENS_ATTEMPT_2);
        }
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
