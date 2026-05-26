import { describe, expect, it, vi } from 'vitest';
import { CandidatePoolService } from '../candidate-pool.js';
import { FusionService } from '../fusion.js';
import type { SearchIndexPort } from '../../port/search-index.port.js';
import type { EmbeddingServicePort } from '../../port/embedding-service.port.js';
import type { HybridRetrievalInput } from '../../model/retrieval-input.js';
import type { QueryPlanV1 } from '../../../query/model/query-plan.js';

function minimalPlan(rawQuery: string): QueryPlanV1 {
  return {
    rawQuery,
    normalizedQuery: rawQuery,
    intent: 'semantic_discovery',
    route: 'hybrid',
    retrievalMode: 'semantic_hybrid',
    queryClass: 'pure_constraint',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [rawQuery], semantic: [] },
    policy: {} as QueryPlanV1['policy'],
    uncertainty: {} as QueryPlanV1['uncertainty'],
    plannerVersion: '1',
    policyRuleVersion: '1',
    thresholdProfileId: 'default',
  } as QueryPlanV1;
}

function createSearchIndex(): SearchIndexPort {
  return {
    sparseSearch: vi.fn(async () => []),
    denseSearch: vi.fn(async () => []),
    searchLearnedSparse: vi.fn(async () => []),
    getDocument: vi.fn(async () => null),
    upsertDocument: vi.fn(async () => {}),
    bulkUpsert: vi.fn(async () => {}),
  };
}

function createEmbeddingService(): EmbeddingServicePort {
  return {
    embed: vi.fn(async () => [0.1]),
    embedBatch: vi.fn(async (texts: readonly string[]) => texts.map(() => [0.1] as const)),
  };
}

function createInput(overrides: Partial<HybridRetrievalInput> = {}): HybridRetrievalInput {
  const queryPlan = overrides.queryPlan ?? minimalPlan('5만원 이하 와인');
  return {
    queryPlan,
    route: 'hybrid',
    compiledRetrievalMode: queryPlan.retrievalMode,
    lexicalQueries: [queryPlan.rawQuery],
    semanticQueries: [],
    hardConstraints: [],
    softConstraints: [],
    ...overrides,
  };
}

describe('CandidatePoolService price authority', () => {
  it('lifts raw-query KRW price into the hard constraint compiler path exactly once', async () => {
    const searchIndex = createSearchIndex();
    const pool = new CandidatePoolService(
      searchIndex,
      createEmbeddingService(),
      new FusionService(),
      undefined,
      'text-embedding-3-small',
      false,
      undefined,
      true,
    );

    await pool.execute(createInput({ queryPlan: minimalPlan('5만원 이하 와인') }));

    const filters = vi.mocked(searchIndex.sparseSearch).mock.calls[0]?.[1] ?? [];
    expect(filters.filter((token) => token.startsWith('price_usd_max:'))).toHaveLength(1);
  });

  it('does not append raw-query price filters when structured price constraints already exist', async () => {
    const searchIndex = createSearchIndex();
    const pool = new CandidatePoolService(
      searchIndex,
      createEmbeddingService(),
      new FusionService(),
      undefined,
      'text-embedding-3-small',
      false,
      undefined,
      true,
    );
    const priceConstraint = {
      attribute: 'price_usd',
      operator: '<=' as const,
      value: 30,
      source_phrase: 'structured',
      confidence: 1,
      soft_promotion_authority: 'allow' as const,
      mapping_version: 'test-v1',
    };
    const queryPlan = {
      ...minimalPlan('5만원 이하 와인'),
      constraints: { hard: [priceConstraint], soft: [], inferred: [] },
    } as QueryPlanV1;

    await pool.execute(createInput({
      queryPlan,
      hardConstraints: [priceConstraint],
    }));

    const filters = vi.mocked(searchIndex.sparseSearch).mock.calls[0]?.[1] ?? [];
    expect(filters.filter((token) => token.startsWith('price_usd_max:'))).toEqual(['price_usd_max:30']);
  });
});
