import type { AgentStep, AgentTerminationReason } from '../../domain/agent/model/agent-step.js';
import type { SearchRequest } from '../search/search-request.dto.js';
import type { NormalizedConstraint } from '../../domain/shared/types/index.js';
import { isAbortError } from '../../domain/shared/cooperative-abort.js';
import { containsHangul } from '../../domain/shared/utils/hangul.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import type { SynthesisContext } from './tool-outcome.js';
import type { AgentToolDeps } from './agent-tools.js';
import type { AgentExecutionState } from './agent-execution-state.js';
import {
  buildSearchToolStyleDerivedFilters,
  buildSearchToolStyleQueryTerms,
} from '../search/search-tool-contract.js';
import {
  getLastGroundingObservationText,
  hasGroundingToolObservations,
} from './agent-grounding-observation-policy.js';

const defaultLog = bootstrapLogger.child({ component: 'AgentAnswerRecoveryPolicy' });

/** Wall-clock budget for the Layer 2 single-shot fallback search. */
const FALLBACK_SEARCH_TIMEOUT_MS = 5_000;
/** Layer 3 fallback: max chars of observation to include in answer (prevents oversized responses). */
const LAYER3_OBSERVATION_SLICE_CHARS = 300;
const RECOVERY_FILTER_VERSION = 'agent_recovery_v1';
const LAYER3_PREVIEW_WINE_LIMIT = 3;
const GROUNDING_JSON_MARKER = 'GROUNDING_JSON: ';

interface GroundingPreviewWine {
  readonly canonical_label?: string;
  readonly region?: string;
  readonly grapes?: readonly string[];
  readonly price?: string;
}

interface GroundingPreviewPayload {
  readonly wines?: readonly GroundingPreviewWine[];
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function asStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value
    .map((entry) => asNonEmptyString(entry))
    .filter((entry): entry is string => entry !== undefined);
  return strings.length > 0 ? strings : undefined;
}

function appendRecoverySearchClauses(
  baseQuery: string,
  input: Record<string, unknown>,
): string {
  const clauses: string[] = [];
  for (const grape of asStringArray(input['exclude_grapes']) ?? []) {
    clauses.push(`not ${grape}`);
  }
  for (const region of asStringArray(input['exclude_regions']) ?? []) {
    clauses.push(`not ${region}`);
  }
  const maxPriceKrw = asPositiveInt(input['max_price_krw']);
  if (maxPriceKrw !== undefined) {
    clauses.push(`${maxPriceKrw}원 이하`);
  }
  clauses.push(...buildSearchToolStyleQueryTerms({
    style: asNonEmptyString(input['style']),
    styles: asStringArray(input['styles']),
  }));
  const certification = asNonEmptyString(input['certification']);
  if (certification !== undefined) {
    clauses.push(certification);
  }
  if (clauses.length === 0) {
    return baseQuery;
  }
  return baseQuery.length > 0 ? `${baseQuery}, ${clauses.join(', ')}` : clauses.join(', ');
}

function buildRecoveryFilters(input: Record<string, unknown>): readonly NormalizedConstraint[] {
  const filters: NormalizedConstraint[] = [];

  for (const grape of asStringArray(input['exclude_grapes']) ?? []) {
    filters.push({ attribute: 'grape_primary', operator: 'exclude', value: grape, source_phrase: grape, confidence: 1.0, mapping_version: RECOVERY_FILTER_VERSION });
  }
  for (const region of asStringArray(input['exclude_regions']) ?? []) {
    filters.push({ attribute: 'region', operator: 'exclude', value: region, source_phrase: region, confidence: 1.0, mapping_version: RECOVERY_FILTER_VERSION });
  }

  const wineType = asNonEmptyString(input['wine_type']);
  if (wineType !== undefined) {
    filters.push({ attribute: 'wine_type', operator: '=', value: wineType, source_phrase: wineType, confidence: 1.0, mapping_version: RECOVERY_FILTER_VERSION });
  }

  const maxAlcoholPct = typeof input['max_alcohol_pct'] === 'number' && Number.isFinite(input['max_alcohol_pct']) && input['max_alcohol_pct'] > 0
    ? input['max_alcohol_pct']
    : undefined;
  if (maxAlcoholPct !== undefined) {
    filters.push({ attribute: 'alcohol_pct', operator: '<=', value: maxAlcoholPct, source_phrase: `${maxAlcoholPct}% 이하`, confidence: 1.0, mapping_version: RECOVERY_FILTER_VERSION });
  }

  const country = asNonEmptyString(input['country']);
  if (country !== undefined) {
    filters.push({ attribute: 'country', operator: '=', value: country, source_phrase: country, confidence: 1.0, mapping_version: RECOVERY_FILTER_VERSION });
  }

  const vintageMin = asPositiveInt(input['vintage_min']);
  if (vintageMin !== undefined) {
    filters.push({ attribute: 'vintage_year', operator: '>=', value: vintageMin, source_phrase: `${vintageMin}년 이후`, confidence: 1.0, mapping_version: RECOVERY_FILTER_VERSION });
  }

  const vintageMax = asPositiveInt(input['vintage_max']);
  if (vintageMax !== undefined) {
    filters.push({ attribute: 'vintage_year', operator: '<=', value: vintageMax, source_phrase: `${vintageMax}년 이전`, confidence: 1.0, mapping_version: RECOVERY_FILTER_VERSION });
  }

  const appellation = asNonEmptyString(input['appellation']);
  if (appellation !== undefined) {
    filters.push({ attribute: 'appellation', operator: '=', value: appellation, source_phrase: appellation, confidence: 1.0, mapping_version: RECOVERY_FILTER_VERSION });
  }

  filters.push(...buildSearchToolStyleDerivedFilters({
    style: asNonEmptyString(input['style']),
    styles: asStringArray(input['styles']),
  }));

  return filters;
}

function buildRecoveredSearchRequest(input: Record<string, unknown>): SearchRequest | undefined {
  const query = asNonEmptyString(input['query']);
  if (query === undefined) {
    return undefined;
  }

  const rebuiltQuery = appendRecoverySearchClauses(query, input);
  const filters = buildRecoveryFilters(input);
  const retrievalMode = asNonEmptyString(input['retrieval_mode']);
  const request: SearchRequest = {
    query: rebuiltQuery,
    ...(asPositiveInt(input['limit']) !== undefined ? { limit: asPositiveInt(input['limit']) } : {}),
    ...(retrievalMode !== undefined
      ? { options: { mode: retrievalMode as NonNullable<SearchRequest['options']>['mode'], explain: false, clarification: false } }
      : {}),
    ...(filters.length > 0 ? { filters } : {}),
  };
  return request;
}

function recoverLastSearchInput(steps: readonly AgentStep[]): SearchRequest | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (step.actionPairs !== undefined) {
      for (let j = step.actionPairs.length - 1; j >= 0; j--) {
        const pair = step.actionPairs[j]!;
        if (pair.action.tool === 'search_wines') {
          return buildRecoveredSearchRequest(pair.action.input);
        }
      }
    }
    if (step.action?.tool === 'search_wines') {
      return buildRecoveredSearchRequest(step.action.input);
    }
  }
  return undefined;
}

function parseGroundingPayload(observation: string): GroundingPreviewPayload | undefined {
  const markerIndex = observation.lastIndexOf(GROUNDING_JSON_MARKER);
  if (markerIndex < 0) {
    return undefined;
  }
  const rawJson = observation.slice(markerIndex + GROUNDING_JSON_MARKER.length).trim();
  try {
    const parsed: unknown = JSON.parse(rawJson);
    return typeof parsed === 'object' && parsed !== null
      ? parsed as GroundingPreviewPayload
      : undefined;
  } catch {
    return undefined;
  }
}

function buildGroundingPreview(observation: string, queryHasHangul: boolean): string | undefined {
  const payload = parseGroundingPayload(observation);
  const wines = payload?.wines
    ?.slice(0, LAYER3_PREVIEW_WINE_LIMIT);
  if (wines === undefined || wines.length === 0) {
    return undefined;
  }

  const summary = wines.map((wine) => {
    const label = asNonEmptyString(wine.canonical_label) ?? (queryHasHangul ? '이름 미상 와인' : 'Unnamed wine');
    const details = [
      asNonEmptyString(wine.region),
      wine.grapes?.slice(0, 2).map((grape) => asNonEmptyString(grape)).filter((grape): grape is string => grape !== undefined).join(', '),
      asNonEmptyString(wine.price),
    ].filter((detail): detail is string => detail !== undefined);
    return details.length > 0 ? `${label} (${details.join(' / ')})` : label;
  }).join('; ');

  return queryHasHangul
    ? `검색 결과 요약: ${summary}`
    : `Search result summary: ${summary}`;
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
  return hasGroundingToolObservations(state);
}

interface AgentAnswerRecoveryPolicyDeps {
  readonly toolDeps: Pick<AgentToolDeps, 'searchUseCase'>;
  readonly logger?: Pick<typeof defaultLog, 'error'> | undefined;
}

export class AgentAnswerRecoveryPolicy {
  private readonly logger: Pick<typeof defaultLog, 'error'>;

  constructor(private readonly deps: AgentAnswerRecoveryPolicyDeps) {
    this.logger = deps.logger ?? defaultLog;
  }

  async recoverAnswer(
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
        const fallbackResult = await this.deps.toolDeps.searchUseCase.execute(
          lastSearchInput ?? { query },
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
          this.logger.error({ err, requestId }, 'agent fallback search failed');
        }
      } finally {
        abortSignal?.removeEventListener('abort', propagateFallbackAbort);
        clearTimeout(fallbackTimer);
      }
    }

    if (!state.policyBlocked && state.terminationReason !== 'aborted' && !(abortSignal?.aborted) && answer === '') {
      const lastObsText = getLastGroundingObservationText(state);
      if (lastObsText !== undefined) {
        const queryHasHangul = containsHangul(query);
        answer = buildGroundingPreview(lastObsText, queryHasHangul)
          ?? (queryHasHangul
            ? '검색 결과 요약: ' + lastObsText.slice(0, LAYER3_OBSERVATION_SLICE_CHARS)
            : 'Search result summary: ' + lastObsText.slice(0, LAYER3_OBSERVATION_SLICE_CHARS));
        answer = applyFallbackAnswer(state, answer, 'layer3', observedToolOutput ? 'answer' : 'fallback');
        this.logger.error({ requestId, hasToolObservations: observedToolOutput }, 'Layer 3 fallback: all LLM synthesis paths failed — using structured grounding preview');
      }
    }

    if (state.policyBlocked && answer === '') {
      answer = '이 요청은 처리할 수 없습니다. 와인 검색과 관련된 질문을 해주세요.';
      state.answer = answer;
      this.logger.error({ requestId }, 'policy-blocked agent run ended without explicit answer; returning blocked template');
    }

    // Layer 4: absolute guarantee — return a non-empty Korean answer template.
    // Layer 4 fallback template: keep the literal assignment directly below this comment.
    if (!state.policyBlocked && state.terminationReason !== 'aborted' && !(abortSignal?.aborted) && answer === '') {
      answer = '요청하신 와인 정보를 현재 처리하지 못했습니다. 검색어를 바꿔서 다시 시도해주세요.';
      answer = applyFallbackAnswer(state, answer, 'layer4', observedToolOutput ? 'answer' : 'fallback');
      this.logger.error({ requestId, query, steps: state.steps.length }, 'Layer 4 fallback: all synthesis paths exhausted — returning template answer');
    }

    return answer;
  }
}
