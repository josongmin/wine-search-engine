/**
 * Regression: the `lookup_wine` agent tool — a high-precision entity-lookup
 * primitive split out from `search_wines`. It forces the entity retrieval route,
 * caps results to a tight set, and exposes NO constraint filters (those belong
 * to search_wines). Guards the SSoT tool registry, the strict schema's
 * filter-stripping repair, the batch policy, and the dispatch behavior.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  executeAgentTool,
  LookupWineInputSchema,
  type AgentToolDeps,
} from '../../src/application/agent/agent-tools.js';
import {
  isKnownAgentToolName,
  parseKnownAgentToolAttemptInputWithRepair,
} from '../../src/domain/agent/model/agent-tool-attempt-schema.js';
import { evaluateBatchPolicy } from '../../src/application/agent/tool-batch-policy.js';
import { LOOKUP_WINE_LIMIT_MAX } from '../../src/application/search/search-tool-contract.js';
import type { SearchExecutorPort } from '../../src/application/search/port/search-executor.port.js';
import type { SearchResponseV1 } from '../../src/domain/response/model/search-response.js';

function makeSearchResponse(results: SearchResponseV1['results']): SearchResponseV1 {
  return {
    queryType: 'search',
    engineDecision: {
      decisionStatus: 'resolved',
      nextAction: 'return',
      route: 'entity',
      decisionConfidence: 0.95,
      confidenceSemantics: 'calibrated_decision_confidence',
      decisionTraceRef: 'trace-1',
      decisionSnapshot: {
        model_versions: {}, index_versions: {}, policy_rule_version: '1',
        threshold_profile_id: 'default', planner_version: '1', feature_flags: {},
      },
    },
    results,
    meta: {
      requestId: 'req-1', queryTimeMs: 5, route: 'entity',
      version: '1.0.0', engine_schema_version: 'search_response_v1',
    },
  };
}

function resultStub(label: string): SearchResponseV1['results'][number] {
  return {
    entity: { entityId: `id-${label}`, canonicalLabel: label, type: 'wine' },
    relevanceScore: 0.9,
    match: {
      matchType: 'entity',
      scoreComponents: { lexical: 0.9, semantic: 0.9, attribute: 0.9, popularity: 0.5, preferenceAlignment: 0.5 },
    },
    constraints: { matched: [], unmet: [], inferred: [] },
    uncertainty: { uncertaintyConfidence: 0.95, missingInfo: [], approximationUsed: false },
    evidenceItems: [],
  } as unknown as SearchResponseV1['results'][number];
}

describe('lookup_wine — SSoT registry', () => {
  it('is a known agent tool', () => {
    expect(isKnownAgentToolName('lookup_wine')).toBe(true);
  });

  it('accepts query + small limit', () => {
    const r = parseKnownAgentToolAttemptInputWithRepair('lookup_wine', { query: 'Opus One 2018', limit: 2 });
    expect(r.attempt).toEqual({ tool: 'lookup_wine', input: { query: 'Opus One 2018', limit: 2 } });
  });

  it('coerces a bare string into { query }', () => {
    const r = parseKnownAgentToolAttemptInputWithRepair('lookup_wine', '사씨카이아');
    expect(r.attempt?.tool).toBe('lookup_wine');
    expect((r.attempt?.input as { query?: string }).query).toBe('사씨카이아');
  });

  it('STRIPS constraint filters (repairs to a pure lookup) instead of failing', () => {
    const r = parseKnownAgentToolAttemptInputWithRepair('lookup_wine', {
      query: 'Penfolds Grange',
      min_price_krw: 50_000, // a search_wines filter — must be dropped, not rejected
      region: 'Barossa',
    });
    expect(r.attempt).toEqual({ tool: 'lookup_wine', input: { query: 'Penfolds Grange' } });
    expect(r.repair?.removedUnknownKeys).toEqual(expect.arrayContaining(['min_price_krw', 'region']));
  });
});

describe('lookup_wine — input schema bounds', () => {
  it('accepts a query with a small limit', () => {
    expect(LookupWineInputSchema.safeParse({ query: 'x', limit: LOOKUP_WINE_LIMIT_MAX }).success).toBe(true);
  });
  it('accepts an over-cap limit at the schema (clamped later at dispatch, not rejected)', () => {
    expect(LookupWineInputSchema.safeParse({ query: 'x', limit: LOOKUP_WINE_LIMIT_MAX + 5 }).success).toBe(true);
  });
  it('rejects an empty query', () => {
    expect(LookupWineInputSchema.safeParse({ query: '' }).success).toBe(false);
  });
});

describe('lookup_wine — batch policy', () => {
  it('allows a parallel batch of lookups', () => {
    const decision = evaluateBatchPolicy([
      { tool: 'lookup_wine', input: { query: 'a' } },
      { tool: 'lookup_wine', input: { query: 'b' } },
    ]);
    expect(decision.allowed).toBe(true);
  });
  it('does NOT allow mixing lookup_wine with compare_wines', () => {
    const decision = evaluateBatchPolicy([
      { tool: 'lookup_wine', input: { query: 'a' } },
      { tool: 'compare_wines', input: { query_a: 'a', query_b: 'b' } },
    ]);
    expect(decision.allowed).toBe(false);
  });
});

describe('lookup_wine — dispatch', () => {
  function deps(execute: SearchExecutorPort['execute']): AgentToolDeps {
    return { searchUseCase: { execute } };
  }

  it('forces the entity route, passes the bare query, and caps the limit', async () => {
    const execute = vi.fn().mockResolvedValue(makeSearchResponse([resultStub('Opus One')]));
    await executeAgentTool('lookup_wine', { query: 'Opus One 2018', limit: 10 }, deps(execute), 'req-1');

    const [request] = execute.mock.calls[0] ?? [];
    expect(request?.options?.mode).toBe('entity');
    expect(request?.query).toBe('Opus One 2018'); // no clause enrichment
    expect(request?.limit).toBe(LOOKUP_WINE_LIMIT_MAX); // 10 clamped to 3
    expect(request?.filters).toBeUndefined();
  });

  it('defaults the limit to the cap when omitted', async () => {
    const execute = vi.fn().mockResolvedValue(makeSearchResponse([resultStub('w')]));
    await executeAgentTool('lookup_wine', { query: '사씨카이아' }, deps(execute), 'req-1');
    expect((execute.mock.calls[0]?.[0])?.limit).toBe(LOOKUP_WINE_LIMIT_MAX);
  });

  it('returns a not_found observation on zero matches', async () => {
    const execute = vi.fn().mockResolvedValue(makeSearchResponse([]));
    const result = await executeAgentTool('lookup_wine', { query: 'NoSuchWine' }, deps(execute), 'req-1');
    expect(result.observation).toContain('not_found');
  });

  it('returns the matched result on success', async () => {
    const execute = vi.fn().mockResolvedValue(makeSearchResponse([resultStub('Sassicaia')]));
    const result = await executeAgentTool('lookup_wine', { query: 'Sassicaia' }, deps(execute), 'req-1');
    expect(result.observation).toContain('LOOKUP_RESULT');
    expect((result.rawResult as { results: unknown[] }).results).toHaveLength(1);
  });
});
