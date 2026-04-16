import { describe, expect, it } from 'vitest';
import {
  buildAgentQueryExecutionContract,
  extractPendingDrinkabilityEntityIds,
  isSpecificSkuLikeQuery,
  normalizeExactMetadataSearchInput,
} from '../../../../src/application/agent/agent-query-execution-contract.js';
import type { AgentStep } from '../../../../src/domain/agent/model/agent-step.js';
import type { ToolOutcome } from '../../../../src/application/agent/tool-outcome.js';

describe('agent query execution contract', () => {
  it('classifies drinkability and entity-metadata signals from normalized Korean queries', () => {
    expect(buildAgentQueryExecutionContract('오푸스원 지금 마시기 좋아?')).toEqual({
      requiresDrinkabilityCheck: true,
      hasEntityMetadataSignal: true,
    });
    expect(buildAgentQueryExecutionContract('오푸스원 가격 얼마야')).toEqual({
      requiresDrinkabilityCheck: false,
      hasEntityMetadataSignal: true,
    });
  });

  it('detects specific-sku-like queries through the adaptive-budget classifier contract', () => {
    expect(isSpecificSkuLikeQuery('opus one 2018')).toBe(true);
    expect(isSpecificSkuLikeQuery('레드 와인 추천해줘')).toBe(false);
  });

  it('strips structured filters from exact metadata search input while preserving allowed execution keys', () => {
    const normalized = normalizeExactMetadataSearchInput({
      query: 'opus one',
      limit: 3,
      retrieval_mode: 'entity',
      country: 'United States',
      vintage_min: 2018,
      max_price_krw: undefined,
      appellation: null,
    });

    expect(normalized.effectiveInput).toEqual({
      query: 'opus one',
      limit: 3,
      retrieval_mode: 'entity',
    });
    expect(normalized.strippedFilterKeys).toEqual(['country', 'vintage_min']);
  });

  it('extracts the unresolved top search entity id when drinkability is required', () => {
    const pending = extractPendingDrinkabilityEntityIds(
      { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: false },
      [],
      [
        {
          stepId: 'req:0:0',
          tool: 'search_wines',
          kind: 'success',
          result: {
            queryType: 'search',
            results: [
              { entity: { entityId: 'wine-1', canonicalLabel: 'Wine 1' } },
              { entity: { entityId: 'wine-2', canonicalLabel: 'Wine 2' } },
            ],
          },
          durationMs: 1,
        } satisfies ToolOutcome,
      ],
    );

    expect(pending).toEqual(['wine-1']);
  });

  it('does not re-request drinkability ids already checked in prior steps', () => {
    const steps: AgentStep[] = [
      {
        index: 0,
        thought: 'checked',
        action: { tool: 'check_drinking_window', input: { entity_id: 'wine-1' } },
        observation: 'ok',
        durationMs: 1,
        tokenCount: { input: 0, output: 0 },
      },
    ];

    const pending = extractPendingDrinkabilityEntityIds(
      { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: false },
      steps,
      [
        {
          stepId: 'req:0:0',
          tool: 'search_wines',
          kind: 'success',
          result: {
            queryType: 'search',
            results: [{ entity: { entityId: 'wine-1', canonicalLabel: 'Wine 1' } }],
          },
          durationMs: 1,
        } satisfies ToolOutcome,
      ],
    );

    expect(pending).toEqual([]);
  });

  it('extracts unresolved comparison entity ids and excludes completed checks', () => {
    const steps: AgentStep[] = [
      {
        index: 0,
        thought: 'parallel check',
        actionPairs: [
          {
            action: { tool: 'check_drinking_window', input: { entity_id: 'wine-a' } },
            observation: 'ok',
          },
        ],
        actions: [{ tool: 'check_drinking_window', input: { entity_id: 'wine-a' } }],
        observations: ['ok'],
        durationMs: 1,
        tokenCount: { input: 0, output: 0 },
      },
    ];

    const pending = extractPendingDrinkabilityEntityIds(
      { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: false },
      steps,
      [
        {
          stepId: 'req:0:0',
          tool: 'compare_wines',
          kind: 'success',
          result: {
            queryType: 'comparison',
            entities: [
              { topResult: { entity: { entityId: 'wine-a' } } },
              { topResult: { entity: { entityId: 'wine-b' } } },
            ],
          },
          durationMs: 1,
        } satisfies ToolOutcome,
      ],
    );

    expect(pending).toEqual(['wine-b']);
  });
});
