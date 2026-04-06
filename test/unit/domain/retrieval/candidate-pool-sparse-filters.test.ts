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

    const input: HybridRetrievalInput = {
      queryPlan: minimalPlan(),
      route: 'hybrid',
      lexicalQueries: ['red wine'],
      semanticQueries: ['red wine'],
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
    };

    const pool = new CandidatePoolService(searchIndex, embeddingService, new FusionService());
    await pool.generate(input);

    expect(sparseFilters[0]).toEqual(['wine_type:red']);
    expect(denseFilters[0]).toEqual(['wine_type:red']);
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
      getDocument: vi.fn(async () => null),
      upsertDocument: vi.fn(async () => {}),
      bulkUpsert: vi.fn(async () => {}),
    };

    const embeddingService: EmbeddingServicePort = {
      embed: vi.fn(async (): Promise<readonly number[]> => [0.1]),
      embedBatch: vi.fn(async () => [[0.1]]),
    };

    const pool = new CandidatePoolService(searchIndex, embeddingService, new FusionService());
    const out = await pool.generate({
      queryPlan: minimalPlan(),
      route: 'hybrid',
      lexicalQueries: ['red wine'],
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
    });

    expect(out.map((candidate) => candidate.entityId)).toEqual(['wine-red']);
    expect(out[0]?.matchedConstraints).toContain('wine_type');
  });
});
