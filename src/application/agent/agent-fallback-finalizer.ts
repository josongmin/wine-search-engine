import type { AgentStep, AgentTerminationReason } from '../../domain/agent/model/agent-step.js';
import { isAbortError } from '../../domain/shared/cooperative-abort.js';
import { containsHangul } from '../../domain/shared/utils/hangul.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import type { SynthesisContext } from './tool-outcome.js';
import type { AgentToolDeps } from './agent-tools.js';
import type { AgentExecutionState } from './agent-execution-state.js';

const log = bootstrapLogger.child({ component: 'AgentFallbackFinalizer' });

/** Wall-clock budget for the Layer 2 single-shot fallback search. */
const FALLBACK_SEARCH_TIMEOUT_MS = 5_000;
/** Layer 3 fallback: max chars of observation to include in answer (prevents oversized responses). */
const LAYER3_OBSERVATION_SLICE_CHARS = 300;

/**
 * Recover the most recent search_wines input from the agent's step history.
 * Used by Layer 2 fallback to preserve constraints from failed/aborted attempts.
 *
 * Walks the steps in reverse order, returning the input of the last `search_wines`
 * action found (in either the legacy `action` field or the parallel `actionPairs`
 * field). Returns undefined if no search_wines was ever attempted.
 *
 * Returns the validated subset that searchUseCase needs (currently `query` only —
 * extending this to forward `wine_type`, `country`, `vintage_min/max`, `max_price_krw`
 * etc. requires changing searchUseCase to accept structured constraints in addition
 * to the NL query, which is a separate refactor).
 */
function recoverLastSearchInput(steps: readonly AgentStep[]): { query: string } | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (step.actionPairs !== undefined) {
      for (let j = step.actionPairs.length - 1; j >= 0; j--) {
        const pair = step.actionPairs[j]!;
        if (pair.action.tool === 'search_wines') {
          const q = pair.action.input['query'];
          if (typeof q === 'string' && q.trim().length > 0) return { query: q };
        }
      }
    }
    if (step.action?.tool === 'search_wines') {
      const q = step.action.input['query'];
      if (typeof q === 'string' && q.trim().length > 0) return { query: q };
    }
  }
  return undefined;
}

function applyFallbackAnswer(
  state: AgentExecutionState,
  answer: string,
  layer: NonNullable<SynthesisContext['fallbackApplied']>,
  terminationReason: AgentTerminationReason,
): string {
  state.answer = answer;
  state.fallbackApplied = true;
  state.fallbackLayer = layer;
  state.terminationReason = terminationReason;
  return answer;
}

export function hasToolObservations(state: AgentExecutionState): boolean {
  return state.steps.some(
    (s) =>
      (s.observation !== undefined && s.observation.length > 0) ||
      (s.actionPairs !== undefined && s.actionPairs.some((p) => p.observation.length > 0)),
  );
}

export interface AgentFallbackFinalizerDeps {
  readonly toolDeps: Pick<AgentToolDeps, 'searchUseCase'>;
}

export class AgentFallbackFinalizer {
  constructor(private readonly deps: AgentFallbackFinalizerDeps) {}

  async runFallbackCascade(
    query: string,
    requestId: string,
    state: AgentExecutionState,
    observedToolOutput: boolean,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    let answer = state.answer;

    const shouldRunLayer2Fallback =
      !state.policyBlocked &&
      answer === '' &&
      state.terminationReason !== 'answer' &&
      !observedToolOutput &&
      !(abortSignal?.aborted);

    if (shouldRunLayer2Fallback) {
      const fallbackController = new AbortController();
      const propagateFallbackAbort = (): void => { fallbackController.abort(); };
      abortSignal?.addEventListener('abort', propagateFallbackAbort, { once: true });
      const fallbackTimer = setTimeout(() => {
        fallbackController.abort();
      }, FALLBACK_SEARCH_TIMEOUT_MS);
      try {
        const lastSearchInput = recoverLastSearchInput(state.steps);
        const fallbackQuery = lastSearchInput?.query ?? query;
        const fallbackResult = await this.deps.toolDeps.searchUseCase.execute(
          { query: fallbackQuery },
          requestId + '-fallback',
          { abortSignal: fallbackController.signal },
        );
        state.fallbackSearchUsed = true;
        const topResult = fallbackResult.queryType === 'search' ? fallbackResult.results.at(0) : undefined;
        if (topResult !== undefined) {
          const producer = topResult.entity.producer ?? '';
          const region = topResult.entity.region ?? '';
          const detail = [producer, region].filter(Boolean).join(', ');
          const queryHasHangul = containsHangul(query);
          answer = queryHasHangul
            ? '검색 결과: ' + topResult.entity.canonicalLabel + (detail ? ' (' + detail + ')' : '') + '. (참고: 처리 제약으로 간단히 표시되었습니다.)'
            : 'Based on your query, I found: ' + topResult.entity.canonicalLabel + (detail ? ' (' + detail + ')' : '') + '. (Note: simplified result due to processing constraints.)';
          state.lastSearchResult = fallbackResult.queryType === 'search' ? fallbackResult : undefined;
          answer = applyFallbackAnswer(state, answer, 'layer2', 'fallback');
        } else {
          const queryHasHangul = containsHangul(query);
          answer = queryHasHangul
            ? '"' + query + '"에 대한 검색 결과를 찾지 못했습니다. 검색어를 더 간단하게 바꾸거나 다른 와인명이나 품종으로 다시 시도해보세요.'
            : 'No results found for "' + query + '". Try simplifying the query or using a different wine name or grape variety.';
          answer = applyFallbackAnswer(state, answer, 'layer2', 'fallback');
        }
      } catch (err) {
        if (isAbortError(err)) {
          state.terminationReason = 'aborted';
        } else {
          log.error({ err, requestId }, 'agent fallback search failed');
        }
      } finally {
        abortSignal?.removeEventListener('abort', propagateFallbackAbort);
        clearTimeout(fallbackTimer);
      }
    }

    if (!state.policyBlocked && state.terminationReason !== 'aborted' && answer === '') {
      const lastObs = state.steps.findLast(
        (s) =>
          (s.observation !== undefined && s.observation.length > 0) ||
          (s.actionPairs !== undefined && s.actionPairs.some((p) => p.observation.length > 0)),
      );
      const lastObsText =
        lastObs?.observation ??
        lastObs?.actionPairs?.find((p) => p.observation.length > 0)?.observation;
      if (lastObsText !== undefined) {
        const queryHasHangul = containsHangul(query);
        const preview = lastObsText.slice(0, LAYER3_OBSERVATION_SLICE_CHARS);
        answer = queryHasHangul
          ? '검색 결과 요약: ' + preview
          : 'Search result summary: ' + preview;
        answer = applyFallbackAnswer(state, answer, 'layer3', observedToolOutput ? 'answer' : 'fallback');
        log.error({ requestId, hasToolObservations: observedToolOutput }, 'Layer 3 fallback: all LLM synthesis paths failed — using raw observation');
      }
    }

    if (state.policyBlocked && answer === '') {
      answer = '이 요청은 처리할 수 없습니다. 와인 검색과 관련된 질문을 해주세요.';
      state.answer = answer;
      log.error({ requestId }, 'policy-blocked agent run ended without explicit answer; returning blocked template');
    }

    // Layer 4: absolute guarantee — return a non-empty Korean answer template.
    // Layer 4 fallback template: keep the literal assignment directly below this comment.
    if (!state.policyBlocked && state.terminationReason !== 'aborted' && answer === '') {
      answer = '요청하신 와인 정보를 현재 처리하지 못했습니다. 검색어를 바꿔서 다시 시도해주세요.';
      answer = applyFallbackAnswer(state, answer, 'layer4', observedToolOutput ? 'answer' : 'fallback');
      log.error({ requestId, query, steps: state.steps.length }, 'Layer 4 fallback: all synthesis paths exhausted — returning template answer');
    }

    return answer;
  }
}
