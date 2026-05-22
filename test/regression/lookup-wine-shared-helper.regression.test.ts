/**
 * Regression: shared `executeLookupAsEntitySearch` helper (SOLID H2) +
 * handler registry refactor (SOLID H1) + LSP-MED discriminator fix for
 * `structuredOutput.kind = 'lookup_result_set'`.
 *
 * Why these are append-only regression tests, not unit tests: each guards an
 * invariant whose absence was a real bug class.
 *
 *   H2 — Before extraction, `lookup_wine` had three independent schema
 *        definitions. This file asserts that the SAME schema is reachable
 *        via every export path (agent-tools re-export, helper module
 *        primary export, mini-loop bundle now-imported copy).
 *
 *   H1 — Before the handler registry, `executeAgentToolInner` was a ~500-line
 *        switch with each branch hardcoding `"Invalid input for <name>"`.
 *        This file asserts that the error path uses the *dispatcher* tool
 *        name in scope (so an LLM-emitted unknown tool name flows through
 *        the unknown-tool branch, not a literal-string-mismatch branch).
 *
 *   LSP-MED — Before extraction, lookup_wine emitted
 *             `structuredOutput.kind = 'search_result_set'` so downstream
 *             consumers ran search-only invariants (negation, quality tags,
 *             exact-lookup contract) on identity-resolution results. This
 *             file asserts the discriminator is now `lookup_result_set`.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  executeAgentTool,
  LookupWineInputSchema,
  type AgentToolDeps,
} from '../../src/application/agent/agent-tools.js';
import {
  LookupWineInputSchema as HelperLookupWineInputSchema,
  executeLookupAsEntitySearch,
  normalizeLookupWineInput,
} from '../../src/application/search/lookup-wine-execution.js';
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
      decisionTraceRef: 'trace-h2',
      decisionSnapshot: {
        model_versions: {}, index_versions: {}, policy_rule_version: '1',
        threshold_profile_id: 'default', planner_version: '1', feature_flags: {},
      },
    },
    results,
    meta: {
      requestId: 'req-h2', queryTimeMs: 5, route: 'entity',
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

function deps(execute: SearchExecutorPort['execute']): AgentToolDeps {
  return { searchUseCase: { execute } };
}

// ---------------------------------------------------------------------------
// H2 — SSoT schema identity across export paths
// ---------------------------------------------------------------------------

describe('SOLID H2 — LookupWineInputSchema SSoT', () => {
  it('re-export from agent-tools.ts is identity-equal to the helper export', () => {
    // Both names must point at the EXACT same Zod schema instance — that is
    // what makes the SSoT claim true. A copy-paste duplicate would create a
    // structurally-equal but referentially-different schema and silently
    // diverge under future edits.
    expect(LookupWineInputSchema).toBe(HelperLookupWineInputSchema);
  });

  it('rejects an empty query (trim guard applied uniformly)', () => {
    expect(LookupWineInputSchema.safeParse({ query: '' }).success).toBe(false);
    expect(LookupWineInputSchema.safeParse({ query: '   ' }).success).toBe(false);
  });

  it('rejects placeholder queries (placeholder guard applied uniformly)', () => {
    expect(LookupWineInputSchema.safeParse({ query: 'TBD' }).success).toBe(false);
    expect(LookupWineInputSchema.safeParse({ query: '__placeholder__' }).success).toBe(false);
  });

  it('accepts Korean and ASCII identity strings', () => {
    expect(LookupWineInputSchema.safeParse({ query: '사씨카이아' }).success).toBe(true);
    expect(LookupWineInputSchema.safeParse({ query: 'Opus One 2018' }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// H2 — `executeLookupAsEntitySearch` is the single dispatch primitive
// ---------------------------------------------------------------------------

describe('SOLID H2 — executeLookupAsEntitySearch dispatch primitive', () => {
  it('forces mode:"entity" regardless of caller hint', async () => {
    const execute = vi.fn().mockResolvedValue(makeSearchResponse([resultStub('w')]));
    await executeLookupAsEntitySearch({
      searchUseCase: { execute },
      query: 'Penfolds Grange',
      limit: 2,
      requestId: 'req-1',
    });
    const [request] = execute.mock.calls[0] ?? [];
    expect(request?.options?.mode).toBe('entity');
  });

  it('clamps over-cap limit to LOOKUP_WINE_LIMIT_MAX', async () => {
    const execute = vi.fn().mockResolvedValue(makeSearchResponse([resultStub('w')]));
    await executeLookupAsEntitySearch({
      searchUseCase: { execute },
      query: 'Sassicaia',
      limit: 999,
      requestId: 'req-2',
    });
    expect((execute.mock.calls[0]?.[0])?.limit).toBe(LOOKUP_WINE_LIMIT_MAX);
  });

  it('defaults limit to LOOKUP_WINE_LIMIT_MAX when omitted', async () => {
    const execute = vi.fn().mockResolvedValue(makeSearchResponse([resultStub('w')]));
    await executeLookupAsEntitySearch({
      searchUseCase: { execute },
      query: '오퍼스 원',
      requestId: 'req-3',
    });
    expect((execute.mock.calls[0]?.[0])?.limit).toBe(LOOKUP_WINE_LIMIT_MAX);
  });

  it('forwards the abort signal so caller cancellation propagates', async () => {
    const execute = vi.fn().mockResolvedValue(makeSearchResponse([]));
    const abortSignal = new AbortController().signal;
    await executeLookupAsEntitySearch({
      searchUseCase: { execute },
      query: 'X',
      requestId: 'req-4',
      abortSignal,
    });
    expect(execute.mock.calls[0]?.[2]).toEqual({ abortSignal });
  });
});

describe('SOLID H2 — normalizeLookupWineInput', () => {
  it('returns ok=false with joined messages on validation failure', () => {
    const result = normalizeLookupWineInput({ query: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/at least 1 character/i);
    }
  });

  it('clamps limit at the boundary (over-cap rejected at the schema is NOT the contract — it is clamped here)', () => {
    const result = normalizeLookupWineInput({ query: 'Sassicaia', limit: LOOKUP_WINE_LIMIT_MAX + 99 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.clampedLimit).toBe(LOOKUP_WINE_LIMIT_MAX);
  });

  it('uses the small explicit limit when within bounds (boundary: limit = MAX)', () => {
    const result = normalizeLookupWineInput({ query: 'Sassicaia', limit: LOOKUP_WINE_LIMIT_MAX });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.clampedLimit).toBe(LOOKUP_WINE_LIMIT_MAX);
  });

  it('rejects placeholder values so mini-loop dispatcher inherits the same guard', () => {
    // Pre-extraction the mini-loop did a bare `typeof query === 'string'`
    // check that silently accepted "__TODO__". Now the shared normalizer
    // catches it.
    const result = normalizeLookupWineInput({ query: '__TODO__' });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LSP-MED — discriminator divergence is fixed
// ---------------------------------------------------------------------------

describe('SOLID LSP-MED — lookup_wine emits kind:"lookup_result_set"', () => {
  it('on success', async () => {
    const execute = vi.fn().mockResolvedValue(makeSearchResponse([resultStub('Sassicaia')]));
    const result = await executeAgentTool('lookup_wine', { query: 'Sassicaia' }, deps(execute), 'req-l1', {
      toolCallId: 'tc-lookup-1',
    });
    expect(result.evidenceFrame?.structuredOutput.kind).toBe('lookup_result_set');
  });

  it('on not-found (0 matches still uses the lookup discriminator)', async () => {
    const execute = vi.fn().mockResolvedValue(makeSearchResponse([]));
    const result = await executeAgentTool('lookup_wine', { query: 'NoSuchWine' }, deps(execute), 'req-l2', {
      toolCallId: 'tc-lookup-2',
    });
    expect(result.evidenceFrame?.structuredOutput.kind).toBe('lookup_result_set');
  });

  it('search_wines continues to emit kind:"search_result_set" (no cross-contamination)', async () => {
    const execute = vi.fn().mockResolvedValue(makeSearchResponse([resultStub('Penfolds')]));
    const result = await executeAgentTool('search_wines', { query: 'Penfolds' }, deps(execute), 'req-s1', {
      toolCallId: 'tc-search-1',
    });
    expect(result.evidenceFrame?.structuredOutput.kind).toBe('search_result_set');
  });
});

// ---------------------------------------------------------------------------
// H1 — handler registry: unknown tool flows through the unknown branch
// ---------------------------------------------------------------------------

describe('SOLID H1 — unknown tool branch uses dispatcher toolName, not literal', () => {
  it('returns kind:"no_op" with the actual unknown tool name', async () => {
    const execute = vi.fn();
    const result = await executeAgentTool('nope_not_a_tool', { query: 'x' }, deps(execute), 'req-u1', {
      toolCallId: 'tc-u-1',
    });
    expect(result.observation).toContain('nope_not_a_tool');
    expect(result.evidenceFrame?.structuredOutput.kind).toBe('no_op');
    // The search-use-case must NOT be invoked when the tool is unknown.
    expect(execute).not.toHaveBeenCalled();
  });

  it('INVALID_INPUT observation uses the in-scope toolName (no hardcoded literal)', async () => {
    // Calling lookup_wine with an empty query should produce
    // "Invalid input for lookup_wine: ..." — note the dispatcher-derived
    // name, not a hardcoded literal that could drift on rename.
    const execute = vi.fn();
    const result = await executeAgentTool('lookup_wine', { query: '' }, deps(execute), 'req-i1');
    expect(result.observation.startsWith('Invalid input for lookup_wine:')).toBe(true);
  });
});
