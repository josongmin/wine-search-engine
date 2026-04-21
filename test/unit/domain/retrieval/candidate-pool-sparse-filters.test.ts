import { describe, it, expect, vi } from 'vitest';
import { CandidatePoolService } from '../../../../src/domain/retrieval/service/candidate-pool.js';
import { FusionService } from '../../../../src/domain/retrieval/service/fusion.js';
import type { HybridRetrievalInput } from '../../../../src/domain/retrieval/model/retrieval-input.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { SearchIndexPort } from '../../../../src/domain/retrieval/port/search-index.port.js';
import type { EmbeddingServicePort } from '../../../../src/domain/retrieval/port/embedding-service.port.js';

function minimalPlan(overrides: Partial<QueryPlanV1> = {}): QueryPlanV1 {
  return {
    rawQuery: 'q',
    normalizedQuery: 'q',
    intent: 'semantic_discovery',
    route: 'hybrid',
    retrievalMode: 'semantic_hybrid',
    queryClass: 'pure_constraint',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: ['red wine'], semantic: ['red wine'] },
    policy: {} as QueryPlanV1['policy'],
    uncertainty: {} as QueryPlanV1['uncertainty'],
    plannerVersion: '1',
    policyRuleVersion: '1',
    thresholdProfileId: 'default',
    ...overrides,
  } as QueryPlanV1;
}

function createInput(overrides: Partial<HybridRetrievalInput> = {}): HybridRetrievalInput {
  const queryPlan = overrides.queryPlan ?? minimalPlan();
  return {
    queryPlan,
    route: 'hybrid',
    compiledRetrievalMode: queryPlan.retrievalMode,
    lexicalQueries: ['red wine'],
    semanticQueries: ['red wine'],
    hardConstraints: [],
    softConstraints: [],
    ...overrides,
  };
}

describe('CandidatePoolService sparse filter tokens', () => {
  it('passes hardConstraintsToSparseFilterTokens to sparse and dense search', async () => {
    const sparseFilters: (readonly string[] | undefined)[] = [];
    const denseFilters: (readonly string[] | undefined)[] = [];

    const searchIndex: SearchIndexPort = {
      sparseSearch: vi.fn(async (_queries, filters) => {
        sparseFilters.push(filters);
        return [];
      }),
      denseSearch: vi.fn(async (_embedding, filters) => {
        denseFilters.push(filters);
        return [];
      }),
      searchLearnedSparse: vi.fn(async (_queryWeights, filters) => {
        denseFilters.push(filters);
        return [];
      }),
      getDocument: vi.fn(async () => null),
      upsertDocument: vi.fn(async () => {}),
      bulkUpsert: vi.fn(async () => {}),
    };

    const embeddingService: EmbeddingServicePort = {
      embed: vi.fn(async (): Promise<readonly number[]> => [0.1]),
      embedBatch: vi.fn(
        async (texts: readonly string[]): Promise<readonly (readonly number[])[]> =>
          texts.map((): readonly number[] => [0.1]),
      ),
    };

    const input: HybridRetrievalInput = createInput({
      hardConstraints: [
        {
          attribute: 'wine_type',
          operator: '=',
          value: 'red',
          source_phrase: 'red',
          confidence: 1,
        },
      ],
      softConstraints: [],
    });

    const pool = new CandidatePoolService(searchIndex, embeddingService, new FusionService());
    await pool.generate(input);

    expect(sparseFilters[0]).toEqual(['wine_type:red']);
    expect(denseFilters[0]).toEqual(['wine_type:red']);
  });

  it('uses semanticEmbeddingQueries only for dense embeddings while learned sparse stays on semanticQueries', async () => {
    const learnedSparseWeights: Array<readonly { token: string; weight: number }[]> = [];

    const searchIndex: SearchIndexPort = {
      sparseSearch: vi.fn(async () => []),
      denseSearch: vi.fn(async () => []),
      searchLearnedSparse: vi.fn(async (queryWeights) => {
        learnedSparseWeights.push(queryWeights);
        return [];
      }),
      getDocument: vi.fn(async () => null),
      upsertDocument: vi.fn(async () => {}),
      bulkUpsert: vi.fn(async () => {}),
    };

    const embedBatch = vi.fn(async (_texts: readonly string[]) => [[0.1]]);
    const embeddingService: EmbeddingServicePort = {
      embed: vi.fn(async (): Promise<readonly number[]> => [0.1]),
      embedBatch,
    };

    const pool = new CandidatePoolService(searchIndex, embeddingService, new FusionService());

    await pool.generate(createInput({
      queryPlan: minimalPlan({
        queryClass: 'semantic_preference',
      }),
      lexicalQueries: ['wine'],
      semanticQueries: ['chateau margaux'],
      semanticEmbeddingQueries: ['샤또마고1996', '샤토 마고', 'chateau margaux', '마고 샤토'],
    }));

    expect(embedBatch).toHaveBeenCalledWith([
      '샤또마고1996',
      '샤토 마고',
      'chateau margaux',
      '마고 샤토',
    ]);
    expect(learnedSparseWeights).toHaveLength(1);
    expect(learnedSparseWeights[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ token: 'wine' }),
        expect.objectContaining({ token: 'chateau' }),
        expect.objectContaining({ token: 'margaux' }),
      ]),
    );
    expect(learnedSparseWeights[0]).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ token: '샤토' }),
        expect.objectContaining({ token: '마고' }),
      ]),
    );
  });

  it('filters candidates using annotated hard-constraint evidence after fusion', async () => {
    const searchIndex: SearchIndexPort = {
      sparseSearch: vi.fn(async () => [
        {
          entityId: 'wine-red',
          score: 5,
          rank: 1,
          matchedFields: ['wine_type'],
          summary: { canonicalLabel: 'Red Wine', style: 'bold red', wineType: 'red' },
        },
        {
          entityId: 'wine-white',
          score: 4,
          rank: 2,
          matchedFields: ['wine_type'],
          summary: { canonicalLabel: 'White Wine', style: 'crisp white', wineType: 'white' },
        },
      ]),
      denseSearch: vi.fn(async () => []),
      searchLearnedSparse: vi.fn(async () => []),
      getDocument: vi.fn(async () => null),
      upsertDocument: vi.fn(async () => {}),
      bulkUpsert: vi.fn(async () => {}),
    };

    const embeddingService: EmbeddingServicePort = {
      embed: vi.fn(async (): Promise<readonly number[]> => [0.1]),
      embedBatch: vi.fn(async () => [[0.1]]),
    };

    const pool = new CandidatePoolService(searchIndex, embeddingService, new FusionService());
    const out = await pool.generate(createInput({
      semanticQueries: [],
      hardConstraints: [
        {
          attribute: 'wine_type',
          operator: '=',
          value: 'red',
          source_phrase: 'red',
          confidence: 1,
        },
      ],
      softConstraints: [],
    }));

    expect(out.map((candidate) => candidate.entityId)).toEqual(['wine-red']);
    expect(out[0]?.matchedConstraints).toContain('wine_type');
  });

  it('caps assembled candidates by the compiled execution budget when it is tighter than the profile ceiling', async () => {
    const searchIndex: SearchIndexPort = {
      sparseSearch: vi.fn(async () => [
        {
          entityId: 'wine-1',
          score: 9,
          rank: 1,
          matchedFields: ['canonical_label'],
          summary: { canonicalLabel: 'Wine One', style: 'bold red', wineType: 'red' },
        },
        {
          entityId: 'wine-2',
          score: 8,
          rank: 2,
          matchedFields: ['canonical_label'],
          summary: { canonicalLabel: 'Wine Two', style: 'silky red', wineType: 'red' },
        },
        {
          entityId: 'wine-3',
          score: 7,
          rank: 3,
          matchedFields: ['canonical_label'],
          summary: { canonicalLabel: 'Wine Three', style: 'fresh red', wineType: 'red' },
        },
      ]),
      denseSearch: vi.fn(async () => []),
      searchLearnedSparse: vi.fn(async () => []),
      getDocument: vi.fn(async () => null),
      upsertDocument: vi.fn(async () => {}),
      bulkUpsert: vi.fn(async () => {}),
    };

    const embeddingService: EmbeddingServicePort = {
      embed: vi.fn(async (): Promise<readonly number[]> => [0.1]),
      embedBatch: vi.fn(async () => [[0.1]]),
    };

    const pool = new CandidatePoolService(searchIndex, embeddingService, new FusionService());
    const out = await pool.generate(createInput({
      queryPlan: minimalPlan({
        queryClass: 'semantic_preference',
        retrievalMode: 'attribute_search',
      }),
      compiledRetrievalMode: 'attribute_search',
      semanticQueries: [],
      executionBudgetMaxCandidates: 1,
    }));

    expect(out).toHaveLength(1);
    expect(out[0]?.entityId).toBe('wine-1');
    expect(pool.getLastFusionTrace()?.candidateCount.afterFusion).toBe(3);
    expect(pool.getLastFusionTrace()?.candidateCount.afterHardFilter).toBe(3);
    expect(pool.getLastFusionTrace()?.candidateCount.afterAssembly).toBe(1);
  });

  it('caps sparse and dense retrieval topN by the compiled execution budget', async () => {
    const searchIndex: SearchIndexPort = {
      sparseSearch: vi.fn(async () => [
        {
          entityId: 'wine-1',
          score: 9,
          rank: 1,
          matchedFields: ['canonical_label'],
          summary: { canonicalLabel: 'Wine One', style: 'bold red', wineType: 'red' },
        },
      ]),
      denseSearch: vi.fn(async () => [
        {
          entityId: 'wine-1',
          score: 0.9,
          rank: 1,
          similarity: 0.9,
          summary: { canonicalLabel: 'Wine One', style: 'bold red', wineType: 'red' },
        },
      ]),
      searchLearnedSparse: vi.fn(async () => []),
      getDocument: vi.fn(async () => null),
      upsertDocument: vi.fn(async () => {}),
      bulkUpsert: vi.fn(async () => {}),
    };

    const embeddingService: EmbeddingServicePort = {
      embed: vi.fn(async (): Promise<readonly number[]> => [0.1]),
      embedBatch: vi.fn(async () => [[0.1]]),
    };

    const pool = new CandidatePoolService(searchIndex, embeddingService, new FusionService());
    await pool.generate(createInput({
      queryPlan: minimalPlan({
        queryClass: 'semantic_preference',
        retrievalMode: 'attribute_search',
      }),
      compiledRetrievalMode: 'attribute_search',
      lexicalQueries: ['structured cabernet'],
      semanticQueries: ['structured cabernet'],
      executionBudgetMaxCandidates: 1,
    }));

    expect(searchIndex.sparseSearch).toHaveBeenCalledOnce();
    expect(searchIndex.denseSearch).toHaveBeenCalledOnce();
    expect((searchIndex.sparseSearch as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]).toBe(1);
    expect((searchIndex.denseSearch as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]).toBe(1);
  });

  it('degrades to sparse-only when dense retrieval receives no primary embedding', async () => {
    const searchIndex: SearchIndexPort = {
      sparseSearch: vi.fn(async () => []),
      denseSearch: vi.fn(async () => []),
      searchLearnedSparse: vi.fn(async () => []),
      getDocument: vi.fn(async () => null),
      upsertDocument: vi.fn(async () => {}),
      bulkUpsert: vi.fn(async () => {}),
    };

    const embeddingService: EmbeddingServicePort = {
      embed: vi.fn(async (): Promise<readonly number[]> => [0.1]),
      embedBatch: vi.fn(async () => []),
    };

    const pool = new CandidatePoolService(searchIndex, embeddingService, new FusionService());

    // Dense retrieval degrades gracefully — returns empty candidates instead of throwing.
    const results = await pool.generate(createInput());
    expect(results).toEqual([]);
    expect(searchIndex.denseSearch).not.toHaveBeenCalled();
  });

  it.skip('executes learned sparse on the live path when the profile activates that channel', async () => {
    const searchIndex: SearchIndexPort = {
      sparseSearch: vi.fn(async () => []),
      denseSearch: vi.fn(async () => []),
      searchLearnedSparse: vi.fn(async () => [
        {
          entityId: 'wine-learned',
          score: 3.5,
          rank: 1,
          similarity: 0.88,
          summary: {
            canonicalLabel: 'Learned Sparse Wine',
            style: 'bold red',
            wineType: 'red',
          },
        },
      ]),
      getDocument: vi.fn(async () => null),
      upsertDocument: vi.fn(async () => {}),
      bulkUpsert: vi.fn(async () => {}),
    };

    const embeddingService: EmbeddingServicePort = {
      embed: vi.fn(async (): Promise<readonly number[]> => [0.1]),
      embedBatch: vi.fn(async () => [[0.1]]),
    };

    const pool = new CandidatePoolService(searchIndex, embeddingService, new FusionService());
    const out = await pool.generate(createInput({
      queryPlan: minimalPlan({
        queryClass: 'semantic_preference',
        retrievalMode: 'semantic_hybrid',
      }),
      lexicalQueries: ['structured cabernet'],
      semanticQueries: ['structured cabernet'],
    }));

    expect(searchIndex.searchLearnedSparse).toHaveBeenCalledOnce();
    expect(out[0]?.retrievalTrace.candidateSources).toContain('learned_sparse');
  });

  it('applies the relative filter on the live path for compare-mode fallbacks with an anchor entity', async () => {
    const searchIndex: SearchIndexPort = {
      sparseSearch: vi.fn(async () => [
        {
          entityId: 'wine-peer-match',
          score: 7,
          rank: 1,
          matchedFields: ['canonical_label'],
          summary: {
            canonicalLabel: 'Peer Match',
            region: 'Napa Valley',
            style: 'bold red',
            wineType: 'red',
          },
        },
        {
          entityId: 'wine-peer-miss',
          score: 6,
          rank: 2,
          matchedFields: ['canonical_label'],
          summary: {
            canonicalLabel: 'Peer Miss',
            region: 'Mosel',
            style: 'crisp white',
            wineType: 'white',
          },
        },
      ]),
      denseSearch: vi.fn(async () => []),
      searchLearnedSparse: vi.fn(async () => []),
      getDocument: vi.fn(async () => ({
        entityId: 'wine-anchor',
        entityType: 'wine',
        canonicalLabel: 'Anchor Wine',
        aliasesIdentitySafe: [],
        aliasesNoisyRecall: [],
        semanticSummary: 'Napa Valley bold red',
        region: 'Napa Valley',
        style: 'bold red',
        grapePrimary: 'Cabernet Sauvignon',
        availability: true,
        popularityScore: 0.9,
      })),
      upsertDocument: vi.fn(async () => {}),
      bulkUpsert: vi.fn(async () => {}),
    };

    const embeddingService: EmbeddingServicePort = {
      embed: vi.fn(async (): Promise<readonly number[]> => [0.1]),
      embedBatch: vi.fn(async () => [[0.1]]),
    };

    const pool = new CandidatePoolService(searchIndex, embeddingService, new FusionService());
    const out = await pool.generate(createInput({
      queryPlan: minimalPlan({
        queryClass: 'comparison_query',
        retrievalMode: 'compare_candidates',
      }),
      lexicalQueries: ['wines like opus one'],
      semanticQueries: [],
      anchorEntityId: 'wine-anchor',
    }));

    expect(searchIndex.getDocument).toHaveBeenCalledWith('wine-anchor');
    expect(searchIndex.denseSearch).not.toHaveBeenCalled();
    expect(searchIndex.searchLearnedSparse).not.toHaveBeenCalled();
    expect(out.map((candidate) => candidate.entityId)).toEqual(['wine-peer-match']);
    expect(out[0]?.retrievalTrace.candidateSources).toContain('relative_filter');
    expect(out[0]?.retrievalTrace.candidateSources).not.toContain('compare_anchor');
  });

  it('deduplicates repeated anchor_similarity when upstream retrieval provenance already uses canonical channels', async () => {
    const searchIndex: SearchIndexPort = {
      sparseSearch: vi.fn(async () => []),
      denseSearch: vi.fn(async () => []),
      searchLearnedSparse: vi.fn(async () => []),
      getDocument: vi.fn(async () => null),
      upsertDocument: vi.fn(async () => {}),
      bulkUpsert: vi.fn(async () => {}),
    };

    const embeddingService: EmbeddingServicePort = {
      embed: vi.fn(async (): Promise<readonly number[]> => [0.1]),
      embedBatch: vi.fn(async () => [[0.1]]),
    };

    const fusionService = {
      fuse: vi.fn(() => [{
        entityId: 'wine-alias',
        canonicalLabel: 'Alias Wine',
        retrievalFusionScore: 0.83,
        fusionRrfTotal: 0.83,
        matchedConstraints: [],
        retrievalTrace: {
          candidateSources: ['anchor_similarity', 'anchor_similarity', 'dense_semantic'],
          queryViews: [],
          retrievalProfile: 'mixed_anchor',
        },
        retrievalProvenance: {
          channels: ['anchor_similarity', 'anchor_similarity', 'dense_semantic'],
          channelScores: [
            { channel: 'anchor_similarity', rawScore: 0.83, rank: 1, rrfContribution: 0.02 },
            { channel: 'dense_semantic', rawScore: 0.6, rank: 3, rrfContribution: 0.01 },
          ],
          queryViewMatches: [
            { viewName: 'strict', matchedText: 'sassicaia', channel: 'anchor_similarity' },
            { viewName: 'strict', matchedText: 'sassicaia', channel: 'anchor_similarity' },
          ],
          anchorConditioned: true,
          matchedFilterConstraints: [],
          fusionProfile: 'mixed_anchor',
          fusionScore: 0.83,
        },
      }]),
    } as unknown as FusionService;

    const pool = new CandidatePoolService(searchIndex, embeddingService, fusionService);
    const out = await pool.generate(createInput({
      queryPlan: minimalPlan({
        queryClass: 'anchored_similarity',
        route: 'mixed',
        retrievalMode: 'recommendation',
      }),
      route: 'mixed',
      lexicalQueries: ['like sassicaia'],
      semanticQueries: ['like sassicaia'],
    }));

    expect(out).toHaveLength(1);
    expect(out[0]?.retrievalProvenance?.channels).toEqual(['anchor_similarity', 'dense_semantic']);
    expect(out[0]?.retrievalProvenance?.channelScores).toEqual([
      expect.objectContaining({ channel: 'anchor_similarity' }),
      expect.objectContaining({ channel: 'dense_semantic' }),
    ]);
    expect(out[0]?.retrievalProvenance?.queryViewMatches).toEqual([
      expect.objectContaining({ channel: 'anchor_similarity', viewName: 'strict' }),
    ]);
    expect(out[0]?.retrievalTrace.candidateSources).toEqual(['anchor_similarity', 'dense_semantic']);
  });
});
