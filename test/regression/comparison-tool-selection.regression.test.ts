/**
 * Regression: principled comparison tool-selection wiring.
 *
 * Root cause of the bench `comparison_nested` / `complex_reasoning` weakness
 * (tool=33% on #15, #30, #31) was the planner prompt steering comparison intent
 * by keyword ("vs"/"비교") rather than by structure (two distinct sides to
 * contrast). The prompt now routes any 2-side contrast — even nested in a price
 * filter, pairing, or drinking-window task — to compare_wines, mapping each
 * side's distinguishing constraint to *_a/*_b and shared constraints to the
 * shared field.
 *
 * These tests pin the WIRING the planner relies on: once compare_wines is
 * selected with the side/shared split the prompt prescribes, BOTH legs must
 * carry their respective constraints into the decomposed search. They assert
 * tool-selection correctness for the exact bench scenario shapes (#31 Napa vs
 * Bordeaux ≤100k, #15 Bordeaux 2015 vs 2016), not just non-crash.
 *
 * Append-only regression lane — never delete.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executeAgentTool,
  type AgentToolDeps,
} from '../../src/application/agent/agent-tools.js';
import { buildSystemMessage } from '../../src/application/agent/agent-prompt.js';
import type { SearchExecutorPort } from '../../src/application/search/port/search-executor.port.js';

function makeResolvedComparison() {
  return {
    queryType: 'comparison' as const,
    originalQuery: 'A vs B',
    comparisonIntent: 'compare' as const,
    entities: [],
    overallStatus: 'resolved' as const,
    requestId: 'req-cmp',
    executionTimeMs: 12,
    authorityTraceRef: 'cmp-trace',
    runtimeCorrelationRef: 'req-cmp',
  };
}

describe('comparison tool-selection wiring (regression)', () => {
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

  it('#31 Napa vs Bordeaux ≤100k: side regions split per leg, shared grape+price reach BOTH legs', async () => {
    await executeAgentTool(
      'compare_wines',
      {
        query_a: '나파 카베르네',
        query_b: '보르도 카베르네',
        // shared distinguishing grape + shared price constraint
        grape_primary: 'Cabernet Sauvignon',
        max_price_krw: 100_000,
        // side-specific regions
        region_a: 'Napa Valley',
        region_b: 'Bordeaux',
      },
      deps,
      'req-cmp',
    );

    const [subQueries, , originalQuery, , , parentContext, , retrievalSubQueries] =
      mockDecomposedSearchExecute.mock.calls.at(-1) ?? [];

    // Two legs, not a single merged search.
    expect(subQueries).toEqual(['나파 카베르네', '보르도 카베르네']);
    expect(retrievalSubQueries).toHaveLength(2);

    // Shared price reaches both legs + the original (shared) query.
    expect(retrievalSubQueries[0]).toContain('100000원 이하');
    expect(retrievalSubQueries[1]).toContain('100000원 이하');
    expect(originalQuery).toContain('100000원 이하');

    // Shared grape is a shared filter applying to BOTH sides.
    expect(parentContext?.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'grape_primary', operator: '=', value: 'Cabernet Sauvignon' }),
      ]),
    );

    // Side-specific regions land on the correct legs only.
    expect(parentContext?.perSideFilters?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'region', operator: '=', value: 'Napa Valley' }),
      ]),
    );
    expect(parentContext?.perSideFilters?.[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'region', operator: '=', value: 'Bordeaux' }),
      ]),
    );
    // Napa region must NOT bleed into the Bordeaux leg.
    expect(parentContext?.perSideFilters?.[1] ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'region', value: 'Napa Valley' }),
      ]),
    );
  });

  it('#15 Bordeaux 2015 vs 2016: exact vintage carried per leg, shared region reaches BOTH legs', async () => {
    await executeAgentTool(
      'compare_wines',
      {
        query_a: '보르도 2015',
        query_b: '보르도 2016',
        // shared region
        region: 'Bordeaux',
        // side-specific exact vintages
        vintage_min_a: 2015,
        vintage_max_a: 2015,
        vintage_min_b: 2016,
        vintage_max_b: 2016,
      },
      deps,
      'req-cmp',
    );

    const [subQueries, , , , , parentContext] =
      mockDecomposedSearchExecute.mock.calls.at(-1) ?? [];

    expect(subQueries).toEqual(['보르도 2015', '보르도 2016']);

    // Shared region applies to both sides.
    expect(parentContext?.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'region', operator: '=', value: 'Bordeaux' }),
      ]),
    );

    // Each leg carries its own exact vintage (min=max=YEAR) and nothing else's.
    expect(parentContext?.perSideFilters?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'vintage_year', operator: '>=', value: 2015 }),
        expect.objectContaining({ attribute: 'vintage_year', operator: '<=', value: 2015 }),
      ]),
    );
    expect(parentContext?.perSideFilters?.[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'vintage_year', operator: '>=', value: 2016 }),
        expect.objectContaining({ attribute: 'vintage_year', operator: '<=', value: 2016 }),
      ]),
    );
    expect(parentContext?.perSideFilters?.[0] ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'vintage_year', value: 2016 }),
      ]),
    );
  });

  it('planner prompt steers comparison by structure (two sides) rather than the literal "vs"/"비교" keyword', () => {
    const prompt = buildSystemMessage().content;

    // Structure-driven, not keyword-driven.
    expect(prompt).toContain('COMPARISON INTENT (decide by STRUCTURE, not keywords)');
    expect(prompt).toContain('the query names TWO distinct sides');
    // Nested-comparison coverage (price / pairing / drinking-window wrappers).
    expect(prompt).toContain('even when the comparison is embedded in a larger task');
    // Anti-collapse guarantee.
    expect(prompt).toContain('NEVER collapse a 2-side comparison into a single merged search_wines call');
    // 3+ sides → parallel search.
    expect(prompt).toContain('For 3+ sides → emit PARALLEL search_wines actions');
  });
});
