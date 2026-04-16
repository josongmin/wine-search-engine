import type { AgentStep } from '../../domain/agent/model/agent-step.js';
import { classifyQueryBudget } from '../../domain/agent/service/adaptive-budget.js';
import { QueryNormalizer } from '../../domain/query/service/query-normalizer.js';
import { detectDecomposition } from '../../domain/query/service/decomposition-detector.js';
import {
  hasDrinkabilityKeyword,
  hasEntityMetadataKeyword,
  stripExactEntityMetadataSuffix,
} from '../../domain/query/service/exact-entity-metadata-signals.js';
import type { ToolOutcome } from './tool-outcome.js';

const QUERY_NORMALIZER = new QueryNormalizer();
const EXACT_METADATA_ALLOWED_SEARCH_KEYS = new Set(['query', 'limit', 'retrieval_mode']);

export interface AgentQueryExecutionContract {
  readonly requiresDrinkabilityCheck: boolean;
  readonly hasEntityMetadataSignal: boolean;
}

function queryNeedsDrinkabilityCheck(query: string, normalized: string): boolean {
  if (!hasDrinkabilityKeyword(normalized)) {
    return false;
  }
  if (isExactMetadataEntityLookupCandidate(query)) {
    return true;
  }
  return detectDecomposition(query).decomposed;
}

export function buildAgentQueryExecutionContract(query: string): AgentQueryExecutionContract {
  const normalized = QUERY_NORMALIZER.normalize(query).accentless;
  return {
    requiresDrinkabilityCheck: queryNeedsDrinkabilityCheck(query, normalized),
    hasEntityMetadataSignal: hasEntityMetadataKeyword(normalized),
  };
}

export function isSpecificSkuLikeQuery(query: string): boolean {
  return classifyQueryBudget(query)?.classification === 'specific_sku';
}

export function isExactMetadataEntityLookupCandidate(query: string): boolean {
  if (isSpecificSkuLikeQuery(query)) {
    return true;
  }
  const strippedEntityQuery = stripExactEntityMetadataSuffix(query);
  return strippedEntityQuery !== query && isSpecificSkuLikeQuery(strippedEntityQuery);
}

function getStructuredSearchFilterKeys(input: Record<string, unknown>): readonly string[] {
  return Object.entries(input)
    .filter(([key, value]) =>
      !EXACT_METADATA_ALLOWED_SEARCH_KEYS.has(key) &&
      value !== undefined &&
      value !== null,
    )
    .map(([key]) => key);
}

export function normalizeExactMetadataSearchInput(
  input: Record<string, unknown>,
): { readonly effectiveInput: Record<string, unknown>; readonly strippedFilterKeys: readonly string[] } {
  const strippedFilterKeys = getStructuredSearchFilterKeys(input);
  if (strippedFilterKeys.length === 0) {
    return { effectiveInput: input, strippedFilterKeys };
  }

  const filteredEntries = Object.entries(input).filter(
    ([key, value]) =>
      EXACT_METADATA_ALLOWED_SEARCH_KEYS.has(key) &&
      value !== undefined &&
      value !== null,
  );
  return {
    effectiveInput: Object.fromEntries(filteredEntries),
    strippedFilterKeys,
  };
}

function getValueAtPath(input: unknown, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = input;
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function getCompletedDrinkabilityEntityIds(
  steps: readonly AgentStep[],
): ReadonlySet<string> {
  const entityIds = new Set<string>();
  for (const step of steps) {
    if (step.action?.tool === 'check_drinking_window') {
      const entityId = step.action.input['entity_id'];
      if (typeof entityId === 'string' && entityId.trim().length > 0) {
        entityIds.add(entityId);
      }
    }
    for (const pair of step.actionPairs ?? []) {
      if (pair.action.tool !== 'check_drinking_window') {
        continue;
      }
      const entityId = pair.action.input['entity_id'];
      if (typeof entityId === 'string' && entityId.trim().length > 0) {
        entityIds.add(entityId);
      }
    }
  }
  return entityIds;
}

export function extractPendingDrinkabilityEntityIds(
  contract: AgentQueryExecutionContract,
  steps: readonly AgentStep[],
  toolOutcomes: readonly ToolOutcome[],
): readonly string[] {
  if (!contract.requiresDrinkabilityCheck) {
    return [];
  }
  const completed = getCompletedDrinkabilityEntityIds(steps);
  for (let i = toolOutcomes.length - 1; i >= 0; i--) {
    const outcome = toolOutcomes[i]!;
    const result = outcome.result;
    if (typeof result !== 'object' || result === null) {
      continue;
    }
    const record = result as Record<string, unknown>;
    if (outcome.tool === 'search_wines' && record['queryType'] === 'search') {
      const results = record['results'];
      if (!Array.isArray(results) || results.length === 0) {
        return [];
      }
      const [topResult] = results as readonly unknown[];
      const entityId = getValueAtPath(topResult, 'entity.entityId');
      if (typeof entityId === 'string' && entityId.length > 0) {
        return completed.has(entityId) ? [] : [entityId];
      }
      return [];
    }
    if (outcome.tool === 'compare_wines' && record['queryType'] === 'comparison') {
      const entities = record['entities'];
      if (!Array.isArray(entities)) {
        return [];
      }
      const pending = entities
        .map((entity) => getValueAtPath(entity, 'topResult.entity.entityId'))
        .filter((entityId): entityId is string => typeof entityId === 'string' && entityId.length > 0)
        .filter((entityId) => !completed.has(entityId));
      return pending;
    }
  }
  return [];
}
