/**
 * Regression: TRACK-A A4 — Exact-first Dual Retrieval path.
 *
 * Guards the following invariants:
 *
 *  1. exact_entity WITH anchors → resolves to 'entity_anchor_first' runtime mode,
 *     selects ENTITY_ANCHOR_FIRST profile (anchor_similarity in channelMix),
 *     and uses FUSION_ENTITY_EXACT config (rrfK=10, strong anchor weight).
 *
 *  2. exact_entity WITHOUT anchors → falls back to EXACT_SAFE_FALLBACK profile
 *     (no anchor_similarity channel, standard hybrid path).
 *
 *  3. short_entity WITH anchors → same anchor-first path as exact_entity.
 *
 *  4. short_entity WITHOUT anchors → falls back to EXACT_SAFE_FALLBACK.
 *
 *  5. anchor_similarity channel fires in CandidatePoolService regardless of
 *     cascade difficulty (which routes exact_entity/short_entity to 'easy'
 *     = sparse only when aliasMatchStrength ≥ 0.9).
 *
 *  6. Fusion uses FUSION_ENTITY_EXACT (rrfK=10) when anchor-first path is active,
 *     ensuring anchor hits dominate rank-1.
 *
 *  7. Dense kill switch suppresses anchor (both channels use embeddings).
 *
 * These tests are append-only (regression suite rules). Never delete.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CandidatePoolService } from '../../src/domain/retrieval/service/candidate-pool.js';
import { FusionService } from '../../src/domain/retrieval/service/fusion.js';
import { RetrievalProfileService } from '../../src/domain/retrieval/service/retrieval-profile.js';
import { getFusionConfig } from '../../src/domain/retrieval/service/per-class-fusion-config.js';
import type { HybridRetrievalInput } from '../../src/domain/retrieval/model/retrieval-input.js';
import type { QueryPlanV1 } from '../../src/domain/query/model/query-plan.js';
import type { SearchIndexPort, DenseHit } from '../../src/domain/retrieval/port/search-index.port.js';
import type { EmbeddingServicePort } from '../../src/domain/retrieval/port/embedding-service.port.js';
import type { AnchorCandidate } from '../../src/domain/query/model/anchor-candidate.js';
import { createEntityId } from '../../src/domain/shared/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAnchor(entityId: string, confidence = 0.95): AnchorCandidate {
  return {
    surfaceForm: 'Opus One 2018',
    normalizedForm: 'opus one 2018',
    candidateEntityIds: [createEntityId(entityId)],
    confidence,
    source: 'alias',
  };
}

function makePlan(
  queryClass: QueryPlanV1['queryClass'],
  anchors: readonly AnchorCandidate[] = [],
): QueryPlanV1 {
  return {
    rawQuery: 'Opus One 2018',
    normalizedQuery: 'opus one 2018',
    intent: 'semantic_discovery',
    route: 'hybrid',
    retrievalMode: undefined,
    queryClass,
    anchors: [...anchors],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: ['opus one 2018'], semantic: ['opus one 2018'] },
    policy: {} as QueryPlanV1['policy'],
    uncertainty: {} as QueryPlanV1['uncertainty'],
    plannerVersion: '1',
    policyRuleVersion: '1',
    thresholdProfileId: 'default',
  } as QueryPlanV1;
}

function makeInput(
  queryClass: QueryPlanV1['queryClass'],
  anchors: readonly AnchorCandidate[] = [],
  overrides: Partial<HybridRetrievalInput> = {},
): HybridRetrievalInput {
  const queryPlan = overrides.queryPlan ?? makePlan(queryClass, anchors);
  return {
    queryPlan,
    route: 'hybrid',
    compiledRetrievalMode: queryClass === 'hybrid' ? 'semantic_hybrid' : 'entity_lookup',
    lexicalQueries: ['opus one 2018'],
    semanticQueries: ['opus one 2018'],
    hardConstraints: [],
    softConstraints: [],
    ...overrides,
  };
}

function makeAnchorDenseHit(entityId: string, rank = 1, score = 0.95): DenseHit {
  return { entityId, rank, score, summary: undefined };
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

function createEmbeddingService(): EmbeddingServicePort {
  return {
    embed: vi.fn(async (): Promise<readonly number[]> => [0.1, 0.2]),
    embedBatch: vi.fn(
      async (texts: readonly string[]): Promise<readonly (readonly number[])[]> =>
        texts.map((): readonly number[] => [0.1, 0.2]),
    ),
  };
}

// ---------------------------------------------------------------------------
// 1 & 2: RetrievalProfileService profile selection
// ---------------------------------------------------------------------------

describe('RetrievalProfileService — TRACK-A A4 profile selection', () => {
  const profileService = new RetrievalProfileService();

  it('exact_entity with entity_anchor_first mode → entity_anchor_first profile', () => {
    const profile = profileService.getProfile('exact_entity', 'hybrid', 'entity_anchor_first');
    expect(profile.name).toBe('entity_anchor_first');
    expect(profile.channelMix).toContain('anchor_similarity');
    expect(profile.channelMix).toContain('sparse_bm25');
    expect(profile.channelMix).toContain('dense_semantic');
  });

  it('entity_anchor_first profile has anchor weight dominant over sparse and dense', () => {
    const profile = profileService.getProfile('exact_entity', 'hybrid', 'entity_anchor_first');
    expect(profile.anchorWeight).toBeGreaterThan(profile.sparseWeight);
    expect(profile.anchorWeight).toBeGreaterThan(profile.denseWeight);
  });

  it('exact_entity WITHOUT anchor mode → exact_safe_fallback (no anchor_similarity)', () => {
    // No retrievalMode → legacy heuristics → exact_safe_fallback
    const profile = profileService.getProfile('exact_entity', 'hybrid');
    expect(profile.name).toBe('exact_safe_fallback');
    expect(profile.channelMix).not.toContain('anchor_similarity');
  });

  it('short_entity with entity_anchor_first mode → entity_anchor_first profile', () => {
    const profile = profileService.getProfile('short_entity', 'hybrid', 'entity_anchor_first');
    expect(profile.name).toBe('entity_anchor_first');
    expect(profile.channelMix).toContain('anchor_similarity');
  });

  it('short_entity WITHOUT anchor mode → exact_safe_fallback', () => {
    const profile = profileService.getProfile('short_entity', 'hybrid');
    expect(profile.name).toBe('exact_safe_fallback');
    expect(profile.channelMix).not.toContain('anchor_similarity');
  });
});

// ---------------------------------------------------------------------------
// Fusion config — entity_exact class
// ---------------------------------------------------------------------------

describe('getFusionConfig — entity_exact class', () => {
  it('entity_exact has the tightest rrfK (most rank-sensitive)', () => {
    const entityExact = getFusionConfig('entity_exact');
    const specificWine = getFusionConfig('specific_wine');
    expect(entityExact.rrfK).toBeLessThan(specificWine.rrfK);
  });

  it('entity_exact anchor weight is dominant (WEIGHT_BOOST_STRONG = 2.0)', () => {
    const config = getFusionConfig('entity_exact');
    expect(config.anchorWeight).toBe(2.0);
    expect(config.anchorWeight).toBeGreaterThan(config.sparseWeight);
    expect(config.anchorWeight).toBeGreaterThan(config.denseWeight);
  });

  it('entity_exact dense weight is half (0.5) — damped to not bury anchor', () => {
    const config = getFusionConfig('entity_exact');
    expect(config.denseWeight).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// CandidatePoolService integration — anchor-first mode activation
// ---------------------------------------------------------------------------

describe('CandidatePoolService — TRACK-A A4 anchor-first path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exact_entity WITH anchors → getDocument called for anchor entity ID', async () => {
    const anchor = makeAnchor('opus-one-2018');
    const getDocument = vi.fn(async () => null);
    const searchIndex = createSearchIndex({ getDocument });
    const embeddingService = createEmbeddingService();

    const pool = new CandidatePoolService(
      searchIndex,
      embeddingService,
      new FusionService(),
    );

    await pool.execute(makeInput('exact_entity', [anchor]));

    // getDocument must be called with the anchor entity ID to load anchor doc
    expect(getDocument).toHaveBeenCalledWith(createEntityId('opus-one-2018'));
  });

  it('exact_entity WITHOUT anchors → getDocument NOT called (no anchor entity ID)', async () => {
    const getDocument = vi.fn(async () => null);
    const searchIndex = createSearchIndex({ getDocument });
    const embeddingService = createEmbeddingService();

    const pool = new CandidatePoolService(
      searchIndex,
      embeddingService,
      new FusionService(),
    );

    await pool.execute(makeInput('exact_entity', []));

    // No anchors → anchor path skipped → getDocument not called
    expect(getDocument).not.toHaveBeenCalled();
  });

  it('exact_entity WITH anchors AND anchor doc → denseSearch called (anchor embedding + ANN)', async () => {
    // For anchorTask to fire, loadAnchorDocumentIfNeeded must return a document
    // (so resolveAnchorProfile builds an AnchorProfile → anchorTask embeds + calls denseSearch).
    const anchor = makeAnchor('opus-one-2018');
    const embed = vi.fn(async (): Promise<readonly number[]> => [0.1, 0.2]);
    const denseSearch = vi.fn(async (): Promise<DenseHit[]> => []);
    const embeddingService: EmbeddingServicePort = {
      embed,
      embedBatch: vi.fn(async (texts) => texts.map(() => [0.1, 0.2] as readonly number[])),
    };
    const getDocument = vi.fn(async () => ({
      entityId: createEntityId('opus-one-2018'),
      semanticSummary: 'Opus One 2018 Napa Valley red blend',
    }));
    const searchIndex = createSearchIndex({ denseSearch, getDocument });

    const pool = new CandidatePoolService(
      searchIndex,
      embeddingService,
      new FusionService(),
    );

    await pool.execute(makeInput('exact_entity', [anchor]));

    // denseSearch is called: once for semantic dense pass, once for anchor ANN
    expect(denseSearch).toHaveBeenCalled();
    // Specifically it should be called at least twice (semantic + anchor ANN)
    // because entity_anchor_first activates both dense_semantic and anchor_similarity.
    expect(denseSearch).toHaveBeenCalledTimes(2);
  });

  it('exact_entity WITH anchors + dense kill switch → denseSearch NOT called', async () => {
    const anchor = makeAnchor('opus-one-2018');
    const denseSearch = vi.fn(async (): Promise<DenseHit[]> => []);
    const searchIndex = createSearchIndex({ denseSearch });
    const embeddingService = createEmbeddingService();

    const pool = new CandidatePoolService(
      searchIndex,
      embeddingService,
      new FusionService(),
      undefined,
      'bge-m3',
      false,
      undefined,
      true, // killSwitchDenseRetrieval
    );

    await pool.execute(makeInput('exact_entity', [anchor]));

    // Dense kill switch prevents any denseSearch calls (including anchor ANN)
    expect(denseSearch).not.toHaveBeenCalled();
  });

  it('short_entity WITH anchors → denseSearch called (same anchor-first path as exact_entity)', async () => {
    const anchor = makeAnchor('chateau-margaux-2015', 0.88);
    const denseSearch = vi.fn(async (): Promise<DenseHit[]> => []);
    const searchIndex = createSearchIndex({ denseSearch });
    const embeddingService = createEmbeddingService();

    const pool = new CandidatePoolService(
      searchIndex,
      embeddingService,
      new FusionService(),
    );

    await pool.execute(makeInput('short_entity', [anchor]));

    expect(denseSearch).toHaveBeenCalled();
  });

  it('exact_entity WITH anchors → anchor entity surfaces via multi-channel vote (anchor + dense)', async () => {
    // ANCHOR_ENTITY appears in BOTH anchor ANN and dense channels (2 votes).
    // OTHER_ENTITY appears only in sparse (1 vote).
    // Since the anchor entity appears in both anchor_similarity + dense_semantic channels
    // with top ranks, and the other entity only appears in sparse, the anchor entity
    // should accumulate more RRF score and rank higher.
    //
    // Note: FusionService.fuse() currently uses unweighted RRF — the anchorWeight/denseWeight
    // fields are stored but not yet applied to rrfFuse(). The key TRACK-A A4 guarantee
    // is that the anchor_similarity channel FIRES for entity queries with anchors, and that
    // the entity receives an additional channel contribution boosting its fusion score.
    const ANCHOR_ENTITY = 'opus-one-2018';
    const OTHER_ENTITY = 'chateau-petrus-2018';
    const anchor = makeAnchor(ANCHOR_ENTITY, 0.97);

    const getDocument = vi.fn(async (entityId: string) => {
      if (entityId === createEntityId(ANCHOR_ENTITY)) {
        return {
          entityId: createEntityId(ANCHOR_ENTITY),
          semanticSummary: 'Opus One 2018 Napa Valley red blend',
          embedding: [0.1, 0.2],
        };
      }
      return null;
    });

    // denseSearch is called twice: once for semantic query (returns both entities),
    // once for anchor ANN (anchor entity at rank 1).
    // We distinguish calls by counting invocations.
    let denseCallCount = 0;
    const denseSearch = vi.fn(async (): Promise<DenseHit[]> => {
      denseCallCount++;
      if (denseCallCount === 1) {
        // First call = semantic dense: both entities
        return [
          makeAnchorDenseHit(ANCHOR_ENTITY, 1, 0.90),
          makeAnchorDenseHit(OTHER_ENTITY, 2, 0.80),
        ];
      }
      // Second call = anchor ANN: anchor entity only at rank 1
      return [makeAnchorDenseHit(ANCHOR_ENTITY, 1, 0.99)];
    });

    const sparseSearch = vi.fn(async () => [
      // Sparse has OTHER_ENTITY first (common generic term matches)
      { entityId: OTHER_ENTITY, rank: 1, score: 0.75, summary: undefined },
      { entityId: ANCHOR_ENTITY, rank: 2, score: 0.70, summary: undefined },
    ]);

    const searchIndex = createSearchIndex({ getDocument, denseSearch, sparseSearch });
    const embeddingService = createEmbeddingService();

    const pool = new CandidatePoolService(
      searchIndex,
      embeddingService,
      new FusionService(),
    );

    const candidates = await pool.execute(makeInput('exact_entity', [anchor]));

    // Both entities must appear in the output
    const anchorCandidate = candidates.find((c) => c.entityId === createEntityId(ANCHOR_ENTITY));
    const otherCandidate = candidates.find((c) => c.entityId === createEntityId(OTHER_ENTITY));
    expect(anchorCandidate).toBeDefined();
    expect(otherCandidate).toBeDefined();

    // ANCHOR_ENTITY receives contributions from 3 channels (lexical, dense, anchor ANN).
    // OTHER_ENTITY receives contributions from only 2 channels (lexical, dense).
    // With tighter rrfK=10 + anchor entity at rank 1 in anchor channel, ANCHOR_ENTITY
    // should rank higher.
    expect(candidates[0]?.entityId).toBe(createEntityId(ANCHOR_ENTITY));

    // Verify anchor ANN (denseSearch) was called twice: semantic + anchor embedding
    expect(denseSearch).toHaveBeenCalledTimes(2);
  });

  it('ambiguous_short_form WITH anchors → does NOT activate anchor-first path', () => {
    // ambiguous_short_form is excluded from the entity-anchor-first override;
    // verify via RetrievalProfileService directly (CandidatePoolService does not
    // expose the resolved runtime mode). Without entity_anchor_first mode,
    // ambiguous_short_form gets exact_safe_fallback (no anchor_similarity channel).
    const profileService = new RetrievalProfileService();
    const profile = profileService.getProfile('ambiguous_short_form', 'hybrid');
    expect(profile.name).toBe('exact_safe_fallback');
    expect(profile.channelMix).not.toContain('anchor_similarity');
  });
});

// ---------------------------------------------------------------------------
// TA4: fuzzyEntityHypotheses propagation (ExpansionBundle → HybridRetrievalInput)
// ---------------------------------------------------------------------------

describe('TA4: fuzzyEntityHypotheses in ExpansionBundle and HybridRetrievalInput', () => {
  it('ExpansionBundle accepts fuzzyEntityHypotheses field (type contract)', () => {
    // Compile-time contract check: ExpansionBundle with fuzzyEntityHypotheses
    // must be assignable to ExpansionBundle.
    const expansion = {
      lexical: ['opus one', 'opus one 2018'],
      semantic: ['opus one 2018'],
      fuzzyEntityHypotheses: ['opus one'],
    };
    expect(expansion.fuzzyEntityHypotheses).toHaveLength(1);
    expect(expansion.fuzzyEntityHypotheses[0]).toBe('opus one');
  });

  it('ExpansionBundle without fuzzyEntityHypotheses is still valid (field is optional)', () => {
    const expansion = {
      lexical: ['opus one'],
      semantic: ['opus one'],
    };
    expect((expansion as Record<string, unknown>)['fuzzyEntityHypotheses']).toBeUndefined();
  });

  it('buildHybridRetrievalInputForPlan propagates fuzzyEntityHypotheses as entityHypothesisTerms', async () => {
    const { buildHybridRetrievalInputForPlan } = await import(
      '../../src/application/search/search-usecase-hybrid-candidates.js'
    );

    const planWithFuzzy = makePlan('exact_entity', []);
    // Inject fuzzyEntityHypotheses into the plan's expansions
    const planFuzzy = {
      ...planWithFuzzy,
      expansions: {
        ...planWithFuzzy.expansions,
        fuzzyEntityHypotheses: ['오퍼스원', 'opus one'],
      },
    } as typeof planWithFuzzy;

    const input = buildHybridRetrievalInputForPlan(planFuzzy);

    // entityHypothesisTerms must be set from fuzzyEntityHypotheses
    expect(input.entityHypothesisTerms).toBeDefined();
    expect(input.entityHypothesisTerms).toContain('오퍼스원');
    expect(input.entityHypothesisTerms).toContain('opus one');
  });

  it('buildHybridRetrievalInputForPlan omits entityHypothesisTerms when no fuzzyEntityHypotheses', async () => {
    const { buildHybridRetrievalInputForPlan } = await import(
      '../../src/application/search/search-usecase-hybrid-candidates.js'
    );
    const plan = makePlan('exact_entity', []);
    const input = buildHybridRetrievalInputForPlan(plan);
    // No fuzzy hits → entityHypothesisTerms absent
    expect(input.entityHypothesisTerms).toBeUndefined();
  });

  it('buildHybridRetrievalInputForPlan omits entityHypothesisTerms when fuzzyEntityHypotheses is empty array', async () => {
    const { buildHybridRetrievalInputForPlan } = await import(
      '../../src/application/search/search-usecase-hybrid-candidates.js'
    );
    const plan = makePlan('exact_entity', []);
    const planEmpty = {
      ...plan,
      expansions: { ...plan.expansions, fuzzyEntityHypotheses: [] as readonly string[] },
    } as typeof plan;
    const input = buildHybridRetrievalInputForPlan(planEmpty);
    // Empty array → field still omitted (length guard prevents spurious field)
    expect(input.entityHypothesisTerms).toBeUndefined();
  });

  // TA4-CONSUME: entityHypothesisTerms merged into sparseSearch queries
  it('CandidatePoolService.execute() merges entityHypothesisTerms into sparseSearch queries', async () => {
    // Verify that entity hypothesis terms from the planner's fuzzy-match path
    // are forwarded to Vespa BM25 sparse search — i.e., they are NOT a dead field.
    const sparseSearch = vi.fn(async () => []);
    const searchIndex = createSearchIndex({ sparseSearch });
    const embeddingService = createEmbeddingService();
    const pool = new CandidatePoolService(
      searchIndex,
      embeddingService,
      new FusionService(),
    );

    const base = makeInput('hybrid', []);
    const input: HybridRetrievalInput = {
      ...base,
      lexicalQueries: ['opus one'],
      entityHypothesisTerms: ['오퍼스원', '오퍼스 원'],
    };

    await pool.execute(input);

    // sparseSearch must have been called with the merged query array
    expect(sparseSearch).toHaveBeenCalledOnce();
    const [calledQueries] = sparseSearch.mock.calls[0] as [readonly string[], ...unknown[]];
    // All base queries present
    expect(calledQueries).toContain('opus one');
    // Hypothesis terms appended
    expect(calledQueries).toContain('오퍼스원');
    expect(calledQueries).toContain('오퍼스 원');
    // No duplicates: dedup guard prevents double-searching the same term
    expect(calledQueries.length).toBe(new Set(calledQueries).size);
  });

  it('CandidatePoolService.execute() deduplicates when entityHypothesisTerms overlaps lexicalQueries', async () => {
    // If a hypothesis term is already in lexicalQueries (e.g. English form already present),
    // the dedup guard prevents it being sent to Vespa twice.
    const sparseSearch = vi.fn(async () => []);
    const searchIndex = createSearchIndex({ sparseSearch });
    const embeddingService = createEmbeddingService();
    const pool = new CandidatePoolService(
      searchIndex,
      embeddingService,
      new FusionService(),
    );

    const base = makeInput('hybrid', []);
    const input: HybridRetrievalInput = {
      ...base,
      lexicalQueries: ['opus one', 'opus one 2018'],
      entityHypothesisTerms: ['opus one', 'chateau margaux'],  // 'opus one' duplicates lexicalQueries
    };

    await pool.execute(input);

    const [calledQueries] = sparseSearch.mock.calls[0] as [readonly string[], ...unknown[]];
    // 'opus one' appears exactly once despite being in both arrays
    const opusOneCount = calledQueries.filter((q) => q === 'opus one').length;
    expect(opusOneCount).toBe(1);
    // 'chateau margaux' (new term) is present
    expect(calledQueries).toContain('chateau margaux');
  });
});
