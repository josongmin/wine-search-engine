/**
 * Shared adapter helpers for wine agent/tool input -> search use-case input.
 *
 * The same analyzer tool payload is used by both:
 * - internal tool executor (`WineToolExecutor`)
 * - wine-agent-loop native tool-use runner (`WineAgentLoopRunner`)
 */

import type { QueryClass } from '../../domain/shared/types/query-class.js';
import type { QueryIntent } from '../../domain/query/model/query-intent.js';
import type { NormalizedConstraint } from '../../domain/shared/types/constraint-bundle.js';
import type { SearchRequest } from './search-request.dto.js';
import {
  buildFoodPairingFilters,
  buildFoodPairingPreferences,
  buildFoodPairingQuery,
  type FoodPairingToolInputLike,
} from './tool-execution-support.js';
import {
  buildSearchToolStructuredFilters,
  buildSearchToolStructuredPreferences,
} from './search-tool-contract.js';

type SearchToolRetrievalMode = 'auto' | 'entity' | 'hybrid' | 'mixed';

const SEARCH_TOOL_RETRIEVAL_MODES = new Set<SearchToolRetrievalMode>(['auto', 'entity', 'hybrid', 'mixed']);
const FOOD_PAIRING_RETRIEVAL_MODE = 'hybrid' as const;
const CALLER_CONTROLLED_TOOL_QUERY_CLASS = 'semantic_preference' as const;

export const CALLER_CONTROLLED_SEARCH_INTENT = 'semantic_discovery' as const;
export const CALLER_CONTROLLED_FOOD_PAIRING_INTENT = 'pairing_search' as const;

export const TOOL_PAIRING_SEARCH_RETRIEVAL_MODE: SearchToolRetrievalMode = FOOD_PAIRING_RETRIEVAL_MODE;

export interface AgentToolCallerInterpretation {
  readonly authority: 'caller';
  readonly intent: QueryIntent;
  readonly queryClass: QueryClass;
}

export interface AgentToolSearchUseCaseInput {
  readonly query: string;
  readonly limit?: number | undefined;
  readonly mode?: SearchToolRetrievalMode | undefined;
  readonly filters?: NormalizedConstraint[] | undefined;
  readonly preferences?: NormalizedConstraint[] | undefined;
  readonly callerInterpretation?: AgentToolCallerInterpretation | undefined;
}

export interface BuildSearchWinesToolUseCaseInputOptions {
  readonly mappingVersion: string;
  readonly adaptiveRetrievalKDefault?: number | undefined;
  /**
   * If set, this mode is used for both planner-bypass detection and as
   * `mode` when LLM input doesn't provide one.
   */
  readonly fallbackMode?: SearchToolRetrievalMode | undefined;
  /**
   * Whether to add caller authority to bypass planner fallback on tool routes.
   */
  readonly includeCallerInterpretation?: boolean | undefined;
  /**
   * Caller intent when bypassing planner. Defaults to semantic discovery.
   */
  readonly callerIntent?: AgentToolCallerInterpretation['intent'] | undefined;
}

export interface BuildFoodPairingToolUseCaseInputOptions {
  readonly mappingVersion: string;
  readonly includeCallerInterpretation?: boolean | undefined;
  /**
   * Caller intent when bypassing planner. Defaults to pairing search.
   */
  readonly callerIntent?: AgentToolCallerInterpretation['intent'] | undefined;
}

export interface BuildAgentToolSearchRequestOptions {
  readonly overrideLimit?: number | undefined;
  readonly defaultMode?: SearchToolRetrievalMode | undefined;
}

function isSearchToolRetrievalMode(value: unknown): value is SearchToolRetrievalMode {
  return typeof value === 'string' && SEARCH_TOOL_RETRIEVAL_MODES.has(value as SearchToolRetrievalMode);
}

function resolveSearchToolMode(raw: Record<string, unknown>, fallbackMode?: SearchToolRetrievalMode): SearchToolRetrievalMode {
  const explicit = isSearchToolRetrievalMode(raw['mode']) ? raw['mode'] as SearchToolRetrievalMode
    : isSearchToolRetrievalMode(raw['retrieval_mode']) ? raw['retrieval_mode'] as SearchToolRetrievalMode
      : fallbackMode;
  return explicit ?? 'auto';
}

export function shouldBypassPlannerForToolRetrievalMode(retrievalMode: SearchToolRetrievalMode): boolean {
  return retrievalMode !== 'entity' && retrievalMode !== 'mixed';
}

function mergeStructuredConstraints(
  explicit: readonly NormalizedConstraint[] | undefined,
  derived: readonly NormalizedConstraint[],
): NormalizedConstraint[] {
  const out: NormalizedConstraint[] = [];
  const seen = new Set<string>();
  const keyFor = (constraint: NormalizedConstraint): string => {
    return `${constraint.attribute}\u0000${constraint.operator}\u0000${JSON.stringify(constraint.value)}`;
  };
  for (const constraint of explicit ?? []) {
    const key = keyFor(constraint);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(constraint);
  }
  for (const constraint of derived) {
    const key = keyFor(constraint);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(constraint);
  }
  return out;
}

function asFoodPairingToolInputLike(
  raw: Record<string, unknown>,
): FoodPairingToolInputLike {
  return raw as unknown as FoodPairingToolInputLike;
}

export function buildSearchWinesToolUseCaseInput(
  raw: Record<string, unknown>,
  options: BuildSearchWinesToolUseCaseInputOptions,
): AgentToolSearchUseCaseInput {
  const query = typeof raw['query'] === 'string' ? raw['query'] : '';
  const mode = resolveSearchToolMode(raw, options.fallbackMode);
  const llmLimit = typeof raw['limit'] === 'number' && Number.isFinite(raw['limit'])
    ? raw['limit']
    : undefined;
  const resolvedLimit = llmLimit ?? options.adaptiveRetrievalKDefault;
  const explicitFilters = Array.isArray(raw['filters'])
    ? raw['filters'] as readonly NormalizedConstraint[]
    : [];
  const explicitPreferences = Array.isArray(raw['preferences'])
    ? raw['preferences'] as readonly NormalizedConstraint[]
    : [];
  const structuredFilters = buildSearchToolStructuredFilters(raw, options.mappingVersion);
  const structuredPreferences = buildSearchToolStructuredPreferences(raw, options.mappingVersion);
  const filters = mergeStructuredConstraints(explicitFilters, structuredFilters);
  const preferences = mergeStructuredConstraints(explicitPreferences, structuredPreferences);
  const includeCallerInterpretation = options.includeCallerInterpretation === true;
  const bypassPlanner = shouldBypassPlannerForToolRetrievalMode(mode);
  const callerInterpretation = includeCallerInterpretation && bypassPlanner
    ? {
        authority: 'caller',
        intent: options.callerIntent ?? CALLER_CONTROLLED_SEARCH_INTENT,
        queryClass: CALLER_CONTROLLED_TOOL_QUERY_CLASS,
      } satisfies AgentToolCallerInterpretation
    : undefined;

  return {
    query,
    ...(resolvedLimit !== undefined ? { limit: resolvedLimit } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(filters.length > 0 ? { filters: [...filters] } : {}),
    ...(preferences.length > 0 ? { preferences: [...preferences] } : {}),
    ...(callerInterpretation !== undefined ? { callerInterpretation } : {}),
  };
}

export function buildFoodPairingToolUseCaseInput(
  raw: Record<string, unknown>,
  options: BuildFoodPairingToolUseCaseInputOptions,
): AgentToolSearchUseCaseInput {
  const inputLike = asFoodPairingToolInputLike(raw);
  const filters = buildFoodPairingFilters(inputLike, options.mappingVersion);
  const preferences = buildFoodPairingPreferences(inputLike, options.mappingVersion);
  const includeCallerInterpretation = options.includeCallerInterpretation === true;
  const bypassPlanner = shouldBypassPlannerForToolRetrievalMode(FOOD_PAIRING_RETRIEVAL_MODE);
  const callerInterpretation = includeCallerInterpretation && bypassPlanner
    ? {
        authority: 'caller',
        intent: options.callerIntent ?? CALLER_CONTROLLED_FOOD_PAIRING_INTENT,
        queryClass: CALLER_CONTROLLED_TOOL_QUERY_CLASS,
      } satisfies AgentToolCallerInterpretation
    : undefined;

  return {
    query: buildFoodPairingQuery(inputLike),
    mode: FOOD_PAIRING_RETRIEVAL_MODE,
    ...(filters.length > 0 ? { filters: [...filters] } : {}),
    ...(preferences.length > 0 ? { preferences: [...preferences] } : {}),
    ...(callerInterpretation !== undefined ? { callerInterpretation } : {}),
  };
}

export function buildAgentToolSearchRequest(
  input: AgentToolSearchUseCaseInput,
  options?: BuildAgentToolSearchRequestOptions,
): SearchRequest {
  const mode = options?.defaultMode ?? input.mode ?? 'auto';
  const limit = options?.overrideLimit ?? input.limit;

  return {
    query: input.query,
    ...(limit !== undefined ? { limit } : {}),
    options: {
      mode,
      explain: false,
      clarification: false,
    },
    ...(input.filters !== undefined && input.filters.length > 0
      ? { filters: input.filters }
      : {}),
    ...(input.preferences !== undefined && input.preferences.length > 0
      ? { preferences: input.preferences }
      : {}),
    ...(input.callerInterpretation !== undefined
      ? { callerInterpretation: input.callerInterpretation }
      : {}),
  };
}
