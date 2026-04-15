/**
 * T6.3: Unit tests for machine-response-builder-v2 and the tool-executor V2 seam.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildMachineResponseV2 } from '../service/machine-response-builder-v2.js';
import type { MachineResponseBuildParamsV2 } from '../service/machine-response-builder-v2.js';
import type { RankedResult, ComponentScores } from '../../ranking/model/ranked-result.js';
import type { EvidenceItem } from '../../shared/types/index.js';
import { createEntityId } from '../../shared/types/index.js';
import { WineToolExecutor } from '../../../interface/claude-tools/tool-executor.js';
import type { WineToolExecutorDeps, ToolExecutionV2Options } from '../../../interface/claude-tools/tool-executor.js';
import type { CandidateProvenance } from '../../retrieval/model/candidate-envelope.js';
import { SearchResponseV2MachineSchema } from '../../../interface/http/schemas/search-response-v2.schema.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeComponentScores(overrides?: Partial<ComponentScores>): ComponentScores {
  return {
    entityIntegrity: 0.95,
    semantic: 0.82,
    hardConstraintPass: true,
    softConstraint: 0.75,
    attributeAlignment: 0.70,
    popularity: 0.50,
    uncertaintyPenalty: 0.05,
    ...overrides,
  };
}

function makeEvidenceItems(): readonly EvidenceItem[] {
  return [
    {
      type: 'lexical_match',
      source: 'vespa_retrieval',
      contribution: '+0.42',
      strength: 'high',
      provenance: 'BM25 exact title match',
    },
    {
      type: 'semantic_similarity',
      source: 'dense_retrieval',
      contribution: '+0.18',
      strength: 'medium',
      provenance: 'Embedding cosine similarity',
    },
    {
      type: 'uncertainty_penalty',
      source: 'ranking_pipeline',
      contribution: '-0.05',
      strength: 'low',
      provenance: 'Low entity integrity',
    },
  ];
}

function makeCandidateProvenance(): CandidateProvenance {
  return {
    channels: ['sparse_bm25', 'dense_semantic'],
    channelScores: [
      { channel: 'sparse_bm25', rawScore: 14.2, rank: 1, rrfContribution: 0.48 },
      { channel: 'dense_semantic', rawScore: 0.91, rank: 2, rrfContribution: 0.32 },
    ],
    queryViewMatches: [
      { viewName: 'strict', matchedText: 'Opus One', channel: 'sparse_bm25' },
    ],
    anchorConditioned: false,
    matchedFilterConstraints: ['vintage:2018'],
    fusionProfile: 'rrf-default',
    fusionScore: 0.7812,
  };
}

function makeRankedResult(overrides?: Partial<RankedResult>): RankedResult {
  return {
    entityId: createEntityId('wine-001'),
    canonicalLabel: 'Opus One 2018',
    finalScore: 0.887,
    rank: 1,
    componentScores: makeComponentScores(),
    evidenceItems: makeEvidenceItems(),
    matchedConstraints: ['vintage:2018'],
    unmetConstraints: [],
    inferredConstraints: [],
    ...overrides,
  };
}

function buildSingleResultResponse(overrides?: Partial<RankedResult>) {
  return buildMachineResponseV2({
    queryId: 'q-test',
    results: [makeRankedResult(overrides)],
  });
}

// ── buildMachineResponseV2 ──────────────────────────────────────────────────

describe('buildMachineResponseV2', () => {
  it.each([
    ['version', (response: ReturnType<typeof buildSingleResultResponse>) => response.version, '2'],
    [
      'responseType',
      (response: ReturnType<typeof buildSingleResultResponse>) => response.responseType,
      'machine',
    ],
    [
      'queryId',
      (response: ReturnType<typeof buildSingleResultResponse>) => response.queryId,
      'q-abc-123',
    ],
  ])('maps envelope %s', (_field, read, expected) => {
    const params: MachineResponseBuildParamsV2 = {
      queryId: 'q-abc-123',
      results: [makeRankedResult()],
    };
    const response = buildMachineResponseV2(params);
    expect(read(response)).toBe(expected);
  });

  it.each([
    ['version', (item: NonNullable<ReturnType<typeof buildSingleResultResponse>['results'][number]>) => item.version, '2'],
    [
      'responseType',
      (item: NonNullable<ReturnType<typeof buildSingleResultResponse>['results'][number]>) => item.responseType,
      'machine',
    ],
  ])('maps item %s', (_field, read, expected) => {
    const item = buildSingleResultResponse().results[0];
    expect(item).toBeDefined();
    expect(read(item!)).toBe(expected);
  });

  it.each([
    ['entityId', (item: NonNullable<ReturnType<typeof buildSingleResultResponse>['results'][number]>) => item.entityId, 'wine-001'],
    [
      'canonicalLabel',
      (item: NonNullable<ReturnType<typeof buildSingleResultResponse>['results'][number]>) => item.canonicalLabel,
      'Opus One 2018',
    ],
    ['rank', (item: NonNullable<ReturnType<typeof buildSingleResultResponse>['results'][number]>) => item.rank, 3],
    [
      'finalScore',
      (item: NonNullable<ReturnType<typeof buildSingleResultResponse>['results'][number]>) => item.finalScore,
      0.77,
    ],
  ])('maps result %s', (_field, read, expected) => {
    const item = buildSingleResultResponse({ rank: 3, finalScore: 0.77 }).results[0];
    expect(read(item!)).toBe(expected);
  });

  it('serialises supported ComponentScores fields and omits unsupported ones', () => {
    const scores = makeComponentScores({ anchorSimilarity: 0.61 });
    const response = buildSingleResultResponse({ componentScores: scores });
    const cs = response.results[0]!.componentScores;
    expect(cs.entityIntegrity).toBe(0.95);
    expect(cs.anchorSimilarity).toBe(0.61);
    expect(cs.semantic).toBe(0.82);
    expect(cs.hardConstraintPass).toBe(true);
    expect(cs.softConstraint).toBe(0.75);
    expect(cs.attributeAlignment).toBe(0.70);
    expect(cs.popularity).toBe(0.50);
    expect(cs.uncertaintyPenalty).toBe(0.05);
    expect('preferenceAlignment' in cs).toBe(false);
    expect('availability' in cs).toBe(false);
  });

  it('omits anchorSimilarity from componentScores when undefined', () => {
    const response = buildSingleResultResponse({ componentScores: makeComponentScores() });
    const cs = response.results[0]!.componentScores;
    expect('anchorSimilarity' in cs).toBe(false);
  });

  it('maps evidenceItems to structured { signal, value, weight } objects', () => {
    const response = buildSingleResultResponse();
    const items = response.results[0]!.evidenceItems;
    expect(items).toHaveLength(3);

    // high strength: weight=1, contribution=+0.42
    const high = items[0]!;
    expect(high.signal).toBe('lexical_match');
    expect(high.value).toBeCloseTo(0.42);
    expect(high.weight).toBe(1);

    // medium strength: weight=0.5, contribution=+0.18
    const medium = items[1]!;
    expect(medium.signal).toBe('semantic_similarity');
    expect(medium.value).toBeCloseTo(0.18);
    expect(medium.weight).toBe(0.5);

    // low strength: weight=0.1, contribution=-0.05
    const low = items[2]!;
    expect(low.signal).toBe('uncertainty_penalty');
    expect(low.value).toBeCloseTo(-0.05);
    expect(low.weight).toBe(0.1);
  });

  it('includes retrievalProvenance string when RankedResult has it', () => {
    const response = buildSingleResultResponse({ retrievalProvenance: makeCandidateProvenance() });
    const item = response.results[0]!;
    expect(item.retrievalProvenance).toBeDefined();
    expect(typeof item.retrievalProvenance).toBe('string');
    // should contain channels and fusion info
    expect(item.retrievalProvenance).toContain('sparse_bm25');
    expect(item.retrievalProvenance).toContain('rrf-default');
    expect(item.retrievalProvenance).toContain('0.7812');
  });

  it('serializes retrieval provenance with repeated anchor_similarity labels only once', () => {
    const response = buildSingleResultResponse({
      retrievalProvenance: {
        ...makeCandidateProvenance(),
        channels: ['anchor_similarity', 'anchor_similarity', 'dense_semantic'],
      },
    });
    const item = response.results[0]!;
    expect(item.retrievalProvenance).toContain('anchor_similarity,dense_semantic');
  });

  it('omits retrievalProvenance when RankedResult has none', () => {
    const response = buildSingleResultResponse({ retrievalProvenance: undefined });
    const item = response.results[0]!;
    expect('retrievalProvenance' in item).toBe(false);
  });

  it('handles empty results array', () => {
    const response = buildMachineResponseV2({ queryId: 'q-empty', results: [] });
    expect(response.results).toHaveLength(0);
    expect(response.version).toBe('2');
    expect(response.responseType).toBe('machine');
  });

  it('handles multiple results, preserving rank order', () => {
    const results = [
      makeRankedResult({ entityId: createEntityId('w-1'), rank: 1, finalScore: 0.9 }),
      makeRankedResult({ entityId: createEntityId('w-2'), rank: 2, finalScore: 0.7 }),
    ];
    const response = buildMachineResponseV2({ queryId: 'q-multi', results });
    expect(response.results).toHaveLength(2);
    expect(response.results[0]!.rank).toBe(1);
    expect(response.results[1]!.rank).toBe(2);
  });

  it('output validates against SearchResponseV2MachineSchema (Zod)', () => {
    const response = buildSingleResultResponse({ retrievalProvenance: makeCandidateProvenance() });
    const result = SearchResponseV2MachineSchema.safeParse(response);
    expect(result.success).toBe(true);
  });
});

// ── WineToolExecutor V2 seam ─────────────────────────────────────────────────

describe('WineToolExecutor — V2 migration seam (T6.3)', () => {
  function makeDeps(): WineToolExecutorDeps {
    return {
      searchUseCase: {
        execute: vi.fn().mockResolvedValue({ queryType: 'search', results: [] }),
      },
      decomposedSearchUseCase: {
        execute: vi.fn().mockResolvedValue({ legs: [] }),
      },
      drinkingWindowUseCase: {
        check: vi.fn().mockResolvedValue({
          drinkingWindowStart: 2024,
          drinkingWindowEnd: 2032,
          currentlyDrinkable: true,
          confidence: 'high',
        }),
      },
    };
  }

  it.each([
    {
      name: 'returns V1 SearchResponseV1 when v2Options is absent',
      requestId: 'req-001',
      v2Options: undefined,
      assertDeps: (deps: WineToolExecutorDeps) => {
        expect(deps.searchUseCase.execute).toHaveBeenCalledOnce();
      },
      assertResult: (result: unknown) => {
        expect(result).toMatchObject({ queryType: 'search' });
      },
    },
    {
      name: 'returns SearchResponseV2Machine when useV2MachineFormat is true',
      requestId: 'req-v2',
      v2Options: {
        useV2MachineFormat: true,
        rankedResults: [makeRankedResult()],
        queryId: 'q-v2-001',
      } satisfies ToolExecutionV2Options,
      assertDeps: (deps: WineToolExecutorDeps) => {
        expect(deps.searchUseCase.execute).not.toHaveBeenCalled();
      },
      assertResult: (result: unknown) => {
        expect(result).toMatchObject({
          version: '2',
          responseType: 'machine',
          queryId: 'q-v2-001',
        });
      },
    },
    {
      name: 'falls back to requestId as queryId when v2Options.queryId is omitted',
      requestId: 'fallback-req-id',
      v2Options: {
        useV2MachineFormat: true,
        rankedResults: [makeRankedResult()],
      } satisfies ToolExecutionV2Options,
      assertDeps: () => undefined,
      assertResult: (result: unknown) => {
        expect(result).toMatchObject({ queryId: 'fallback-req-id' });
      },
    },
  ])('$name', async ({ requestId, v2Options, assertDeps, assertResult }) => {
    const deps = makeDeps();
    const executor = new WineToolExecutor(deps);
    const result = await executor.execute('search_wines', { query: 'Opus One' }, requestId, v2Options);
    assertDeps(deps);
    assertResult(result);
  });

  it('v2Options does not affect non-search_wines tools', async () => {
    const deps = makeDeps();
    const executor = new WineToolExecutor(deps);

    // compare_wines — v2Options is only meaningful for search_wines
    const result = await executor.execute('compare_wines', { query_a: 'A', query_b: 'B' }, 'req-cmp');
    expect(deps.decomposedSearchUseCase.execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ legs: [] });
  });
});
