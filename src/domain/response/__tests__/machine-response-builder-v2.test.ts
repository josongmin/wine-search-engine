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
    preferenceAlignment: 0.65,
    popularity: 0.50,
    availability: 1.0,
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

// ── buildMachineResponseV2 ──────────────────────────────────────────────────

describe('buildMachineResponseV2', () => {
  it('returns version "2" and responseType "machine" in envelope', () => {
    const params: MachineResponseBuildParamsV2 = {
      queryId: 'q-abc-123',
      results: [makeRankedResult()],
    };
    const response = buildMachineResponseV2(params);
    expect(response.version).toBe('2');
    expect(response.responseType).toBe('machine');
    expect(response.queryId).toBe('q-abc-123');
  });

  it('sets version "2" and responseType "machine" on each result item', () => {
    const params: MachineResponseBuildParamsV2 = {
      queryId: 'q-001',
      results: [makeRankedResult()],
    };
    const response = buildMachineResponseV2(params);
    const item = response.results[0];
    expect(item).toBeDefined();
    expect(item!.version).toBe('2');
    expect(item!.responseType).toBe('machine');
  });

  it('maps entityId, canonicalLabel, rank, and finalScore', () => {
    const ranked = makeRankedResult({ rank: 3, finalScore: 0.77 });
    const response = buildMachineResponseV2({ queryId: 'q-002', results: [ranked] });
    const item = response.results[0];
    expect(item!.entityId).toBe('wine-001');
    expect(item!.canonicalLabel).toBe('Opus One 2018');
    expect(item!.rank).toBe(3);
    expect(item!.finalScore).toBe(0.77);
  });

  it('serialises full ComponentScores object (all required numeric fields present)', () => {
    const scores = makeComponentScores({ anchorSimilarity: 0.61 });
    const ranked = makeRankedResult({ componentScores: scores });
    const response = buildMachineResponseV2({ queryId: 'q-003', results: [ranked] });
    const cs = response.results[0]!.componentScores;
    expect(cs.entityIntegrity).toBe(0.95);
    expect(cs.anchorSimilarity).toBe(0.61);
    expect(cs.semantic).toBe(0.82);
    expect(cs.hardConstraintPass).toBe(true);
    expect(cs.softConstraint).toBe(0.75);
    expect(cs.attributeAlignment).toBe(0.70);
    expect(cs.preferenceAlignment).toBe(0.65);
    expect(cs.popularity).toBe(0.50);
    expect(cs.availability).toBe(1.0);
    expect(cs.uncertaintyPenalty).toBe(0.05);
  });

  it('omits anchorSimilarity from componentScores when undefined', () => {
    const scores = makeComponentScores();
    // anchorSimilarity is not set, so it should be absent
    const ranked = makeRankedResult({ componentScores: scores });
    const response = buildMachineResponseV2({ queryId: 'q-004', results: [ranked] });
    const cs = response.results[0]!.componentScores;
    expect('anchorSimilarity' in cs).toBe(false);
  });

  it('maps evidenceItems to structured { signal, value, weight } objects', () => {
    const response = buildMachineResponseV2({ queryId: 'q-005', results: [makeRankedResult()] });
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
    const provenance = makeCandidateProvenance();
    const ranked = makeRankedResult({ retrievalProvenance: provenance });
    const response = buildMachineResponseV2({ queryId: 'q-006', results: [ranked] });
    const item = response.results[0]!;
    expect(item.retrievalProvenance).toBeDefined();
    expect(typeof item.retrievalProvenance).toBe('string');
    // should contain channels and fusion info
    expect(item.retrievalProvenance).toContain('sparse_bm25');
    expect(item.retrievalProvenance).toContain('rrf-default');
    expect(item.retrievalProvenance).toContain('0.7812');
  });

  it('omits retrievalProvenance when RankedResult has none', () => {
    const ranked = makeRankedResult({ retrievalProvenance: undefined });
    const response = buildMachineResponseV2({ queryId: 'q-007', results: [ranked] });
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
    const ranked = makeRankedResult({ retrievalProvenance: makeCandidateProvenance() });
    const response = buildMachineResponseV2({ queryId: 'q-zod', results: [ranked] });
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

  it('returns V1 SearchResponseV1 when v2Options is absent', async () => {
    const deps = makeDeps();
    const executor = new WineToolExecutor(deps);
    const result = await executor.execute('search_wines', { query: 'Opus One' }, 'req-001');
    // V1 path: searchUseCase.execute was called
    expect(deps.searchUseCase.execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ queryType: 'search' });
  });

  it('returns SearchResponseV2Machine when useV2MachineFormat is true', async () => {
    const deps = makeDeps();
    const executor = new WineToolExecutor(deps);

    const ranked = makeRankedResult();
    const v2Options: ToolExecutionV2Options = {
      useV2MachineFormat: true,
      rankedResults: [ranked],
      queryId: 'q-v2-001',
    };

    const result = await executor.execute('search_wines', { query: 'Opus One' }, 'req-v2', v2Options);

    // V1 use case must NOT have been called
    expect(deps.searchUseCase.execute).not.toHaveBeenCalled();

    // Result must be a V2 machine envelope
    expect(result).toMatchObject({
      version: '2',
      responseType: 'machine',
      queryId: 'q-v2-001',
    });
  });

  it('falls back to requestId as queryId when v2Options.queryId is omitted', async () => {
    const deps = makeDeps();
    const executor = new WineToolExecutor(deps);

    const v2Options: ToolExecutionV2Options = {
      useV2MachineFormat: true,
      rankedResults: [makeRankedResult()],
    };

    const result = await executor.execute('search_wines', { query: 'Opus One' }, 'fallback-req-id', v2Options);
    expect(result).toMatchObject({ queryId: 'fallback-req-id' });
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
