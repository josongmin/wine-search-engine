/**
 * Regression — bench #117 RCA (`comparison_neste / Exact pair compare + …`).
 *
 * Two structural gaps observed:
 *
 *  (A) Schema gap: `compare_wines` rejects `retrieval_mode` while `search_wines`
 *      accepts it. The planner LLM emits the same field in both tools because the
 *      mental model is "search-family tool"; the strict-parse + repair pass then
 *      drops the key silently and the planner has no way to learn the field is
 *      unsupported. Concrete bench log:
 *        LLM tool input repaired by dropping unknown schema fields:
 *          removedUnknownKeys: ["retrieval_mode"]
 *        ... compare_wines({query_a:..., query_b:..., retrieval_mode:"entity"})
 *      Per CLAUDE.md SSoT rules (#25 / #30), the enum source MUST be the shared
 *      `SEARCH_TOOL_RETRIEVAL_MODES` constant; if the two tools diverge the
 *      planner can never converge. Fix: keep `retrieval_mode` in the compare
 *      tool field shape AND in the LLM-facing attempt schema, propagated to
 *      both per-leg sub-searches via the existing `DecomposedSearchParentContext`
 *      seam.
 *
 *  (B) Two-sided constraint propagation: each leg's side-specific filters
 *      (vintage_min_a/vintage_max_a etc.) MUST reach ONLY that leg's Vespa
 *      query — never bleed to the other side. The `perSideFilters` wiring is
 *      already present (see comparison-tool-selection.regression.test.ts);
 *      this file adds an explicit "exact pair compare" pin that mirrors bench
 *      #117's actual shape (vintage_*=YEAR_a and vintage_*=YEAR_b) and pins
 *      the honest empty-leg observation when a side returns 0 candidates.
 *
 * Append-only regression lane — never delete.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executeAgentTool,
  type AgentToolDeps,
} from '../../src/application/agent/agent-tools.js';
import { CompareWinesAttemptInputSchema, SearchToolAttemptInputSchema } from '../../src/domain/agent/model/agent-tool-attempt-schema.js';
import { SEARCH_TOOL_RETRIEVAL_MODES } from '../../src/application/search/search-tool-contract.js';
import type { SearchExecutorPort } from '../../src/application/search/port/search-executor.port.js';
import type { ComparisonSearchResponse } from '../../src/domain/response/model/comparison-response.js';

function makeResolvedComparison(overrides?: Partial<ComparisonSearchResponse>): ComparisonSearchResponse {
  return {
    queryType: 'comparison',
    originalQuery: 'A vs B',
    comparisonIntent: 'compare',
    entities: [],
    overallStatus: 'resolved',
    requestId: 'req-cmp',
    executionTimeMs: 12,
    authorityTraceRef: 'cmp-trace',
    runtimeCorrelationRef: 'req-cmp',
    ...overrides,
  } as ComparisonSearchResponse;
}

function emptyLegEntity(subQuery: string): ComparisonSearchResponse['entities'][number] {
  return {
    subQuery,
    comparisonMode: 'entity',
    topResult: null,
    resultCount: 0,
    resolutionStatus: 'failed',
    allResults: [],
  };
}

describe('compare_wines — retrieval_mode schema parity (Problem A)', () => {
  it('LLM-facing attempt schema ACCEPTS retrieval_mode (no longer drops via strict-parse repair)', () => {
    const r = CompareWinesAttemptInputSchema.safeParse({
      query_a: '오푸스 원 2018',
      query_b: '알마비바 2019',
      retrieval_mode: 'entity',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.retrieval_mode).toBe('entity');
    }
  });

  it('attempt schemas accept the same set of canonical retrieval_mode values (SSoT — CLAUDE.md rule 25/30)', () => {
    // The two tools MUST agree on the canonical enum values so the planner can
    // mirror `retrieval_mode` between search_wines and compare_wines. The
    // attempt-layer schemas are intentionally lenient (string, not enum) — see
    // `parseKnownAgentToolAttemptInput` — because the LLM may hallucinate; the
    // strict handler-level schemas (CompareInputSchema / SearchInputSchema in
    // agent-tools.ts) enforce the actual enum. This test pins the attempt
    // parity (planner's view) AND, indirectly via the handler test in this
    // file, the handler-level enum parity.
    const searchAccepts = (mode: string) =>
      SearchToolAttemptInputSchema.safeParse({ query: 'x', retrieval_mode: mode }).success;
    const compareAccepts = (mode: string) =>
      CompareWinesAttemptInputSchema.safeParse({ query_a: 'a', query_b: 'b', retrieval_mode: mode }).success;

    for (const mode of SEARCH_TOOL_RETRIEVAL_MODES) {
      expect({ mode, search: searchAccepts(mode), compare: compareAccepts(mode) })
        .toEqual({ mode, search: true, compare: true });
    }
  });

  it('CompareInputSchema (handler-level) accepts retrieval_mode and forwards it to BOTH legs as the execution mode override', async () => {
    const mockDecomposedSearchExecute = vi.fn().mockResolvedValue(makeResolvedComparison());
    const deps: AgentToolDeps = {
      searchUseCase: { execute: vi.fn() },
      decomposedSearchExecute: mockDecomposedSearchExecute,
    };

    await executeAgentTool(
      'compare_wines',
      {
        query_a: '오푸스 원 2018',
        query_b: '알마비바 2019',
        vintage_min_a: 2018,
        vintage_max_a: 2018,
        vintage_min_b: 2019,
        vintage_max_b: 2019,
        retrieval_mode: 'entity',
      },
      deps,
      'req-cmp-117',
    );

    expect(mockDecomposedSearchExecute).toHaveBeenCalledOnce();
    const [, , , , , parentContext] = mockDecomposedSearchExecute.mock.calls.at(-1) ?? [];
    expect(parentContext?.retrievalMode).toBe('entity');
  });
});

describe('compare_wines — exact two-sided constraint propagation (Problem B regression pin)', () => {
  let deps: AgentToolDeps;
  let mockDecomposedSearchExecute: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockDecomposedSearchExecute = vi.fn().mockResolvedValue(makeResolvedComparison());
    const mockSearchUseCase: SearchExecutorPort = { execute: vi.fn() };
    deps = {
      searchUseCase: mockSearchUseCase,
      decomposedSearchExecute: mockDecomposedSearchExecute,
    };
  });

  it('#117 exact pair: vintage_min_a=vintage_max_a=2018 lands on leg A only; vintage_*_b on leg B only', async () => {
    await executeAgentTool(
      'compare_wines',
      {
        query_a: 'Opus One 2018',
        query_b: 'Almaviva 2019',
        vintage_min_a: 2018,
        vintage_max_a: 2018,
        vintage_min_b: 2019,
        vintage_max_b: 2019,
      },
      deps,
      'req-cmp-117',
    );

    const [, , , , , parentContext] = mockDecomposedSearchExecute.mock.calls.at(-1) ?? [];

    expect(parentContext?.perSideFilters?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'vintage_year', operator: '>=', value: 2018 }),
        expect.objectContaining({ attribute: 'vintage_year', operator: '<=', value: 2018 }),
      ]),
    );
    expect(parentContext?.perSideFilters?.[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'vintage_year', operator: '>=', value: 2019 }),
        expect.objectContaining({ attribute: 'vintage_year', operator: '<=', value: 2019 }),
      ]),
    );
    // Side bleed guards — 2019 must NOT appear in leg A; 2018 must NOT appear in leg B.
    expect(parentContext?.perSideFilters?.[0] ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'vintage_year', value: 2019 }),
      ]),
    );
    expect(parentContext?.perSideFilters?.[1] ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'vintage_year', value: 2018 }),
      ]),
    );
  });
});

describe('compare_wines — honest empty-leg observation (Problem B follow-on)', () => {
  it('when a leg returns 0 candidates, the observation explicitly says "no result" for that side instead of silently substituting', async () => {
    const mockDecomposedSearchExecute = vi.fn().mockResolvedValue(
      makeResolvedComparison({
        overallStatus: 'failed',
        entities: [
          emptyLegEntity('Opus One 2018'),
          emptyLegEntity('Almaviva 2019'),
        ],
      }),
    );
    // Exact-vintage rescue path runs deps.searchUseCase.execute for each
    // unresolved exact-vintage leg. Mock it to return an empty search response
    // so the rescue gracefully concludes "still no match" (the structural
    // outcome under test — leg honestly stays empty, no silent substitution).
    const mockSearchExecute = vi.fn().mockResolvedValue({
      queryType: 'search',
      engineDecision: {
        decisionStatus: 'failed',
        nextAction: 'return',
        route: 'entity',
        decisionConfidence: 0,
        confidenceSemantics: 'calibrated_decision_confidence',
        decisionTraceRef: 'rescue-trace',
        decisionSnapshot: {
          model_versions: {}, index_versions: {}, policy_rule_version: '1',
          threshold_profile_id: 'default', planner_version: '1', feature_flags: {},
        },
      },
      results: [],
      meta: {
        requestId: 'rescue', queryTimeMs: 1, route: 'entity',
        version: '1.0.0', engine_schema_version: 'search_response_v1',
      },
    });
    const deps: AgentToolDeps = {
      searchUseCase: { execute: mockSearchExecute },
      decomposedSearchExecute: mockDecomposedSearchExecute,
    };

    const result = await executeAgentTool(
      'compare_wines',
      {
        query_a: 'Opus One 2018',
        query_b: 'Almaviva 2019',
        vintage_min_a: 2018,
        vintage_max_a: 2018,
        vintage_min_b: 2019,
        vintage_max_b: 2019,
      },
      deps,
      'req-cmp-117-empty',
    );

    // Both legs visibly empty — synthesis cannot honestly cite either side, and
    // MUST receive an observation that names the empty status for both. The
    // bench bug class is: leg returns 0 → handler silently emits an unrelated
    // wine as "the answer", which scores faith=0/scr=0.
    expect(result.observation).toMatch(/Opus One 2018/);
    expect(result.observation).toMatch(/Almaviva 2019/);
    expect(result.observation).toMatch(/no result/i);
    // Status mention so the LLM can write an honest "no match" answer.
    expect(result.observation).toMatch(/status:\s*failed/i);
  });
});
