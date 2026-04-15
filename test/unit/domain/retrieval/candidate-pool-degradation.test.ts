import { describe, it, expect, vi } from 'vitest';
import { CandidatePoolService } from '../../../../src/domain/retrieval/service/candidate-pool.js';
import { FusionService } from '../../../../src/domain/retrieval/service/fusion.js';
import type { HybridRetrievalInput } from '../../../../src/domain/retrieval/model/retrieval-input.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { SearchIndexPort } from '../../../../src/domain/retrieval/port/search-index.port.js';
import type { EmbeddingServicePort } from '../../../../src/domain/retrieval/port/embedding-service.port.js';
import type { RetrievalDegradationObserver, RetrievalDegradationSignal } from '../../../../src/domain/retrieval/port/retrieval-degradation-observer.port.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';

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

function createMockObserver() {
  const signals: RetrievalDegradationSignal[] = [];
  let starts = 0;

  const observer: RetrievalDegradationObserver = {
    onRetrievalStarted: vi.fn(() => { starts++; }),
    onDegradation: vi.fn((signal: RetrievalDegradationSignal) => { signals.push(signal); }),
    getMetrics: vi.fn(() => ({
      totalRetrievals: starts,
      degradations: {},
      degradationRate: 0,
      alerts: [],
    })),
  };

  return { observer, signals, getStarts: () => starts };
}

function createSearchIndex(overrides?: Partial<SearchIndexPort>): SearchIndexPort {
  return {
    sparseSearch: vi.fn(async () => []),
    denseSearch: vi.fn(async () => []),
    searchLearnedSparse: vi.fn(async () => []),
    getDocument: vi.fn(async () => null),
    upsertDocument: vi.fn(async () => {}),
    bulkUpsert: vi.fn(async () => {}),
    ...overrides,
  };
}

function createEmbeddingService(overrides?: Partial<EmbeddingServicePort>): EmbeddingServicePort {
  return {
    embed: vi.fn(async (): Promise<readonly number[]> => [0.1]),
    embedBatch: vi.fn(
      async (texts: readonly string[]): Promise<readonly (readonly number[])[]> =>
        texts.map((): readonly number[] => [0.1]),
    ),
    ...overrides,
  };
}

function createInput(overrides?: Partial<HybridRetrievalInput>): HybridRetrievalInput {
  const queryPlan = overrides?.queryPlan ?? minimalPlan();
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

describe('CandidatePoolService degradation observer', () => {
  it('calls onRetrievalStarted on every generate() call', async () => {
    const { observer, getStarts } = createMockObserver();
    const pool = new CandidatePoolService(
      createSearchIndex(),
      createEmbeddingService(),
      new FusionService(),
      undefined,
      'bge-m3',
      false,
      observer,
    );

    await pool.generate(createInput());
    await pool.generate(createInput());

    expect(getStarts()).toBe(2);
    expect(observer.onRetrievalStarted).toHaveBeenCalledTimes(2);
  });

  it('emits sparse_bm25 degradation when sparse search throws', async () => {
    const { observer, signals } = createMockObserver();
    const searchIndex = createSearchIndex({
      sparseSearch: vi.fn(async () => { throw new Error('vespa timeout'); }),
    });

    const pool = new CandidatePoolService(
      searchIndex,
      createEmbeddingService(),
      new FusionService(),
      undefined,
      'bge-m3',
      false,
      observer,
    );

    await pool.generate(createInput());

    expect(signals).toHaveLength(1);
    expect(signals[0]!.component).toBe('sparse_bm25');
    expect(signals[0]!.severity).toBe('error');
    expect(signals[0]!.reason).toContain('vespa timeout');
    expect(signals[0]!.fallbackApplied).toBe('dense-only retrieval');
  });

  it('emits dense_semantic degradation when dense search throws', async () => {
    const { observer, signals } = createMockObserver();
    const searchIndex = createSearchIndex({
      denseSearch: vi.fn(async () => { throw new Error('ANN index unavailable'); }),
    });

    const pool = new CandidatePoolService(
      searchIndex,
      createEmbeddingService(),
      new FusionService(),
      undefined,
      'bge-m3',
      false,
      observer,
    );

    await pool.generate(createInput());

    const denseSignals = signals.filter((s) => s.component === 'dense_semantic');
    expect(denseSignals).toHaveLength(1);
    expect(denseSignals[0]!.severity).toBe('error');
    expect(denseSignals[0]!.fallbackApplied).toBe('sparse-only retrieval');
  });

  it('emits learned_sparse degradation when learned sparse search throws', async () => {
    const { observer, signals } = createMockObserver();
    const searchIndex = createSearchIndex({
      searchLearnedSparse: vi.fn(async () => { throw new Error('splade offline'); }),
    });

    const pool = new CandidatePoolService(
      searchIndex,
      createEmbeddingService(),
      new FusionService(),
      undefined,
      'bge-m3',
      false,
      observer,
    );

    await pool.generate(createInput({
      queryPlan: minimalPlan({
        queryClass: 'semantic_preference',
      }),
    }));

    const learnedSignals = signals.filter((s) => s.component === 'learned_sparse');
    expect(learnedSignals).toHaveLength(1);
    expect(learnedSignals[0]!.severity).toBe('error');
    expect(learnedSignals[0]!.fallbackApplied).toBe('continue without learned sparse');
  });

  it('emits embedding_combiner degradation when all embeddings are null', async () => {
    const { observer, signals } = createMockObserver();
    const embeddingService = createEmbeddingService({
      embedBatch: vi.fn(async (texts: readonly string[]) =>
        texts.map(() => null) as unknown as readonly (readonly number[])[],
      ),
    });

    const pool = new CandidatePoolService(
      createSearchIndex(),
      embeddingService,
      new FusionService(),
      undefined,
      'bge-m3',
      false,
      observer,
    );

    await pool.generate(createInput());

    const combinerSignals = signals.filter((s) => s.component === 'embedding_combiner');
    expect(combinerSignals).toHaveLength(1);
    expect(combinerSignals[0]!.severity).toBe('error');
    expect(combinerSignals[0]!.reason).toContain('embedding_undefined');
    expect(combinerSignals[0]!.fallbackApplied).toBe('skip dense retrieval');
  });

  it('emits anchor_similarity degradation when anchor embedding throws', async () => {
    const { observer, signals } = createMockObserver();
    const embeddingService = createEmbeddingService({
      embed: vi.fn(async () => { throw new Error('embedding service down'); }),
    });

    const pool = new CandidatePoolService(
      createSearchIndex(),
      embeddingService,
      new FusionService(),
      undefined,
      'bge-m3',
      false,
      observer,
    );

    // Use recommendation mode → mixed_anchor profile → activates anchor_similarity channel
    const input = createInput({
      queryPlan: minimalPlan({
        queryClass: 'semantic_preference',
        retrievalMode: 'recommendation',
        anchors: [{ type: 'wine', name: 'Test Wine', confidence: 0.9 }],
      }),
      compiledRetrievalMode: 'recommendation',
      anchorProfile: {
        semanticSummary: 'A great test wine',
        anchorConfidence: 0.9,
      },
    });

    await pool.generate(input);

    const anchorSignals = signals.filter((s) => s.component === 'anchor_similarity');
    expect(anchorSignals).toHaveLength(1);
    expect(anchorSignals[0]!.severity).toBe('warning');
    expect(anchorSignals[0]!.fallbackApplied).toBe('no-anchor retrieval');
  });

  it('does not emit degradation when all channels succeed', async () => {
    const { observer, signals } = createMockObserver();
    const pool = new CandidatePoolService(
      createSearchIndex(),
      createEmbeddingService(),
      new FusionService(),
      undefined,
      'bge-m3',
      false,
      observer,
    );

    await pool.generate(createInput());

    expect(signals).toHaveLength(0);
    expect(observer.onRetrievalStarted).toHaveBeenCalledTimes(1);
  });

  it('works without observer (no crash when undefined)', async () => {
    const pool = new CandidatePoolService(
      createSearchIndex({
        sparseSearch: vi.fn(async () => { throw new Error('fail'); }),
      }),
      createEmbeddingService(),
      new FusionService(),
    );

    // Should not throw — observer is optional
    await expect(pool.generate(createInput())).resolves.toBeDefined();
  });

  it('fails closed on relative_filter anchor miss instead of returning unfiltered candidates', async () => {
    const { observer, signals } = createMockObserver();
    const searchIndex = createSearchIndex({
      sparseSearch: vi.fn(async () => [{
        entityId: createEntityId('wine-peer'),
        canonicalLabel: 'Peer Wine',
        retrievalFusionScore: 0.7,
        fusionRrfTotal: 0.7,
        matchedConstraints: [],
        retrievalTrace: {
          candidateSources: ['sparse_bm25'],
          retrievalProfile: 'relative_filter',
          lexicalQueriesUsed: [],
          semanticQueriesUsed: [],
          filtersApplied: [],
        },
      }] as unknown as never[]),
      getDocument: vi.fn(async () => null),
    });

    const pool = new CandidatePoolService(
      searchIndex,
      createEmbeddingService(),
      new FusionService(),
      undefined,
      'bge-m3',
      false,
      observer,
    );

    const out = await pool.generate(createInput({
      queryPlan: minimalPlan({
        queryClass: 'comparison_query',
        retrievalMode: 'compare_candidates',
      }),
      anchorEntityId: createEntityId('wine-anchor'),
      semanticQueries: [],
    }));

    expect(out).toEqual([]);
    const relativeSignals = signals.filter((s) => s.component === 'relative_filter');
    expect(relativeSignals).toHaveLength(1);
    expect(relativeSignals[0]!.severity).toBe('error');
    expect(relativeSignals[0]!.fallbackApplied).toBe('return no candidates');
  });
});
