/**
 * T02-2: Kill switch pre-flight guard for dense retrieval.
 *
 * When `killSwitchDenseRetrieval` is true, CandidatePoolService must NOT
 * invoke the embedding service and must NOT call `denseSearch` — even if
 * the active channel set would otherwise include `dense_semantic` or
 * `anchor_similarity`. The audit flagged this as wasted cost: previously
 * the stub embedding was still issued and ANN calls still fanned out.
 */

import { describe, it, expect, vi } from 'vitest';
import { CandidatePoolService } from '../candidate-pool.js';
import { FusionService } from '../fusion.js';
import type { HybridRetrievalInput } from '../../model/retrieval-input.js';
import type { QueryPlanV1 } from '../../../query/model/query-plan.js';
import type { SearchIndexPort } from '../../port/search-index.port.js';
import type { EmbeddingServicePort } from '../../port/embedding-service.port.js';

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
  return {
    queryPlan: minimalPlan(),
    route: 'hybrid',
    lexicalQueries: ['red wine'],
    semanticQueries: ['red wine'],
    hardConstraints: [],
    softConstraints: [],
    ...overrides,
  };
}

describe('CandidatePoolService — killSwitchDenseRetrieval pre-flight guard', () => {
  it('does NOT call embedBatch/embed when kill switch is true', async () => {
    const embeddingService = createEmbeddingService();
    const searchIndex = createSearchIndex();

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

    await pool.execute(createInput());

    expect(embeddingService.embedBatch).not.toHaveBeenCalled();
    expect(embeddingService.embed).not.toHaveBeenCalled();
  });

  it('does NOT call denseSearch when kill switch is true (dense_semantic path)', async () => {
    const embeddingService = createEmbeddingService();
    const searchIndex = createSearchIndex();

    const pool = new CandidatePoolService(
      searchIndex,
      embeddingService,
      new FusionService(),
      undefined,
      'bge-m3',
      false,
      undefined,
      true,
    );

    await pool.execute(createInput());

    expect(searchIndex.denseSearch).not.toHaveBeenCalled();
    // Sparse is still allowed — kill switch targets dense specifically.
    expect(searchIndex.sparseSearch).toHaveBeenCalled();
  });

  it('does NOT call embed/denseSearch for anchor_similarity path when kill switch is true', async () => {
    const embeddingService = createEmbeddingService();
    const searchIndex = createSearchIndex();

    const pool = new CandidatePoolService(
      searchIndex,
      embeddingService,
      new FusionService(),
      undefined,
      'bge-m3',
      false,
      undefined,
      true,
    );

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

    await pool.execute(input);

    expect(embeddingService.embed).not.toHaveBeenCalled();
    expect(embeddingService.embedBatch).not.toHaveBeenCalled();
    expect(searchIndex.denseSearch).not.toHaveBeenCalled();
  });

  it('DOES call embedBatch/denseSearch when kill switch is false (control)', async () => {
    const embeddingService = createEmbeddingService();
    const searchIndex = createSearchIndex();

    const pool = new CandidatePoolService(
      searchIndex,
      embeddingService,
      new FusionService(),
      undefined,
      'bge-m3',
      false,
      undefined,
      false, // kill switch OFF
    );

    await pool.execute(createInput());

    expect(embeddingService.embedBatch).toHaveBeenCalled();
    expect(searchIndex.denseSearch).toHaveBeenCalled();
  });
});
