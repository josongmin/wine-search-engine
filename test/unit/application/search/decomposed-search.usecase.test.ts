import { describe, expect, it, vi } from 'vitest';
import {
  DecomposedSearchUseCase,
  UnexpectedDecomposedResponseError,
} from '../../../../src/application/search/decomposed-search.usecase.js';
import type { SearchExecutorPort } from '../../../../src/application/search/port/search-executor.port.js';
import {
  buildEntityComparisonLegs,
  type ComparisonDecompositionLegs,
} from '../../../../src/domain/query/model/query-decomposition.js';

describe('DecomposedSearchUseCase', () => {
  it('preserves entity compare semantics without concept aggregate metadata', async () => {
    const searchUseCase: SearchExecutorPort = {
      execute: vi.fn()
        .mockResolvedValueOnce({
          queryType: 'search',
          results: [{
            entity: {
              entityId: 'opus-one-1',
              canonicalLabel: 'Opus One 2018',
              type: 'wine',
            },
            match: { matchType: 'entity', scoreComponents: { lexical: 1, semantic: 1, attribute: 1, popularity: 1, preferenceAlignment: 1 } },
            relevanceScore: 0.98,
            constraints: { matched: [], unmet: [], inferred: [] },
            uncertainty: { uncertaintyConfidence: 0.95, missingInfo: [], approximationUsed: false },
            evidenceItems: [],
          }],
          engineDecision: {
            decisionStatus: 'resolved',
          },
          meta: {
            queryTimeMs: 5,
            route: 'entity',
            version: '1',
            engine_schema_version: 'search_response_v1',
          },
        } as never)
        .mockResolvedValueOnce({
          queryType: 'search',
          results: [{
            entity: {
              entityId: 'screaming-eagle-1',
              canonicalLabel: 'Screaming Eagle 2019',
              type: 'wine',
            },
            match: { matchType: 'entity', scoreComponents: { lexical: 1, semantic: 1, attribute: 1, popularity: 1, preferenceAlignment: 1 } },
            relevanceScore: 0.97,
            constraints: { matched: [], unmet: [], inferred: [] },
            uncertainty: { uncertaintyConfidence: 0.95, missingInfo: [], approximationUsed: false },
            evidenceItems: [],
          }],
          engineDecision: {
            decisionStatus: 'resolved',
          },
          meta: {
            queryTimeMs: 6,
            route: 'entity',
            version: '1',
            engine_schema_version: 'search_response_v1',
          },
        } as never),
    };

    const useCase = new DecomposedSearchUseCase(searchUseCase);
    const response = await useCase.execute(
      ['Opus One', 'Screaming Eagle'],
      buildEntityComparisonLegs(['Opus One', 'Screaming Eagle']),
      'compare',
      'Opus One vs Screaming Eagle',
      'req-entity-compare',
      100,
    );

    expect(response.entities[0].comparisonMode).toBe('entity');
    expect(response.entities[0].conceptAggregate).toBeUndefined();
    expect(response.entities[1].conceptAggregate).toBeUndefined();
    expect(response.entities[0].topResult?.entity.entityId).toBe('opus-one-1');
    expect(response.entities[1].topResult?.entity.entityId).toBe('screaming-eagle-1');
  });

  it('propagates parent context, session, and budget into both sub-query searches', async () => {
    const searchUseCase: SearchExecutorPort = {
      execute: vi.fn().mockResolvedValue({
        queryType: 'search',
        engineDecision: {
          decisionStatus: 'resolved',
        },
        results: [],
        meta: {
          queryTimeMs: 5,
          route: 'entity',
          version: '1',
          engine_schema_version: 'search_response_v1',
        },
      } as never),
    };

    const useCase = new DecomposedSearchUseCase(searchUseCase);

    await useCase.execute(
      ['Opus One', 'Screaming Eagle'],
      buildEntityComparisonLegs(['Opus One', 'Screaming Eagle']),
      'compare',
      'Opus One vs Screaming Eagle',
      'req-compare',
      100,
      {
        context: { locale: 'en-US', currency: 'USD' },
        sessionContext: { sessionId: 'session-1', previousEntities: ['entity-1'] },
        queryBudget: { maxLatencyMs: 900, maxCandidates: 50, rerankLimit: 20 },
        filters: [{ attribute: 'country', operator: '=', value: 'United States' }],
      },
    );

    expect(searchUseCase.execute).toHaveBeenNthCalledWith(
      1,
      {
        query: 'Opus One',
        context: { locale: 'en-US', currency: 'USD' },
        sessionContext: { sessionId: 'session-1', previousEntities: ['entity-1'] },
        queryBudget: { maxLatencyMs: 900, maxCandidates: 50, rerankLimit: 20 },
        filters: [{ attribute: 'country', operator: '=', value: 'United States' }],
        options: { mode: 'auto', explain: false, clarification: false },
      },
      'req-compare-a',
      undefined,
    );
    expect(searchUseCase.execute).toHaveBeenNthCalledWith(
      2,
      {
        query: 'Screaming Eagle',
        context: { locale: 'en-US', currency: 'USD' },
        sessionContext: { sessionId: 'session-1', previousEntities: ['entity-1'] },
        queryBudget: { maxLatencyMs: 900, maxCandidates: 50, rerankLimit: 20 },
        filters: [{ attribute: 'country', operator: '=', value: 'United States' }],
        options: { mode: 'auto', explain: false, clarification: false },
      },
      'req-compare-b',
      undefined,
    );
  });

  it('merges per-side filters into each decomposed leg independently', async () => {
    const searchUseCase: SearchExecutorPort = {
      execute: vi.fn().mockResolvedValue({
        queryType: 'search',
        engineDecision: {
          decisionStatus: 'resolved',
        },
        results: [],
        meta: {
          queryTimeMs: 5,
          route: 'hybrid',
          version: '1',
          engine_schema_version: 'search_response_v1',
        },
      } as never),
    };

    const useCase = new DecomposedSearchUseCase(searchUseCase);

    await useCase.execute(
      ['말벡', '말벡'],
      buildEntityComparisonLegs(['말벡', '말벡']),
      'compare',
      '프랑스 말벡 vs 아르헨티나 말벡',
      'req-compare-side-filters',
      100,
      {
        perSideFilters: [
          [{ attribute: 'country', operator: '=', value: 'France' }],
          [
            { attribute: 'country', operator: '=', value: 'Argentina' },
            { attribute: 'region', operator: '=', value: 'Mendoza' },
          ],
        ],
      },
    );

    expect(searchUseCase.execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        filters: [{ attribute: 'country', operator: '=', value: 'France' }],
      }),
      'req-compare-side-filters-a',
      undefined,
    );
    expect(searchUseCase.execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        filters: [
          { attribute: 'country', operator: '=', value: 'Argentina' },
          { attribute: 'region', operator: '=', value: 'Mendoza' },
        ],
      }),
      'req-compare-side-filters-b',
      undefined,
    );
  });

  it('fail-closes concept legs when returned results violate side-specific filters', async () => {
    const legs: ComparisonDecompositionLegs = [
      {
        rawQuery: '말벡',
        retrievalQuery: '말벡',
        retrievalMode: 'hybrid',
        mode: 'concept',
        canonicalConcept: 'Malbec',
        conceptEntityType: 'grape_primary',
      },
      {
        rawQuery: '말벡',
        retrievalQuery: '말벡',
        retrievalMode: 'hybrid',
        mode: 'concept',
        canonicalConcept: 'Malbec',
        conceptEntityType: 'grape_primary',
      },
    ];

    const searchUseCase: SearchExecutorPort = {
      execute: vi.fn()
        .mockResolvedValueOnce({
          queryType: 'search',
          results: [
            {
              entity: {
                entityId: 'arg-malbec-1',
                canonicalLabel: 'Argentina Malbec',
                type: 'wine',
                country: 'Argentina',
                region: 'Mendoza',
                grapes: ['Malbec'],
              },
              match: { matchType: 'hybrid', scoreComponents: { lexical: 1, semantic: 1, attribute: 1, popularity: 1, preferenceAlignment: 1 } },
              relevanceScore: 0.9,
              constraints: { matched: [], unmet: [], inferred: [] },
              uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
              evidenceItems: [],
            },
          ],
          engineDecision: { decisionStatus: 'resolved' },
          meta: {
            queryTimeMs: 5,
            route: 'hybrid',
            version: '1',
            engine_schema_version: 'search_response_v1',
          },
        } as never)
        .mockResolvedValueOnce({
          queryType: 'search',
          results: [
            {
              entity: {
                entityId: 'arg-malbec-2',
                canonicalLabel: 'Argentina Malbec 2',
                type: 'wine',
                country: 'Argentina',
                region: 'Mendoza',
                grapes: ['Malbec'],
              },
              match: { matchType: 'hybrid', scoreComponents: { lexical: 1, semantic: 1, attribute: 1, popularity: 1, preferenceAlignment: 1 } },
              relevanceScore: 0.9,
              constraints: { matched: [], unmet: [], inferred: [] },
              uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
              evidenceItems: [],
            },
          ],
          engineDecision: { decisionStatus: 'resolved' },
          meta: {
            queryTimeMs: 5,
            route: 'hybrid',
            version: '1',
            engine_schema_version: 'search_response_v1',
          },
        } as never),
    };

    const useCase = new DecomposedSearchUseCase(searchUseCase);
    const response = await useCase.execute(
      ['말벡', '말벡'],
      legs,
      'compare',
      '프랑스 말벡 vs 아르헨티나 말벡',
      'req-country-split',
      100,
      {
        perSideFilters: [
          [{ attribute: 'country', operator: '=', value: 'France' }],
          [{ attribute: 'country', operator: '=', value: 'Argentina' }],
        ],
      },
    );

    expect(response.entities[0].resolutionStatus).toBe('failed');
    expect(response.entities[0].resultCount).toBe(0);
    expect(response.entities[0].topResult).toBeNull();
    expect(response.entities[1].resolutionStatus).toBe('resolved');
    expect(response.entities[1].resultCount).toBe(1);
    expect(response.entities[1].topResult?.entity.country).toBe('Argentina');
  });

  it('throws a typed domain error when a sub-query returns a comparison response', async () => {
    const searchUseCase: SearchExecutorPort = {
      execute: vi.fn().mockResolvedValueOnce({
        queryType: 'search',
        engineDecision: {
          decisionStatus: 'resolved',
        },
        results: [],
        meta: {
          queryTimeMs: 5,
          route: 'entity',
          version: '1',
          engine_schema_version: 'search_response_v1',
        },
      } as never).mockResolvedValueOnce({
        queryType: 'comparison',
      } as never),
    };

    const useCase = new DecomposedSearchUseCase(searchUseCase);

    try {
      await useCase.execute(
        ['Opus One', 'Screaming Eagle'],
        buildEntityComparisonLegs(['Opus One', 'Screaming Eagle']),
        'compare',
        'Opus One vs Screaming Eagle',
        'req-compare',
        100,
      );
      expect.fail('Expected UnexpectedDecomposedResponseError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnexpectedDecomposedResponseError);
      const typed = err as UnexpectedDecomposedResponseError;
      expect(typed.code).toBe('UNEXPECTED_DECOMPOSED_RESPONSE');
    }
  });

  it('routes concept/category comparison legs through hybrid retrieval and resolves from representative candidates', async () => {
    const searchUseCase: SearchExecutorPort = {
      execute: vi.fn()
        .mockResolvedValueOnce({
          queryType: 'search',
          results: [
            {
              entity: {
                entityId: 'barolo-1',
                canonicalLabel: '2020 Massolino Barolo',
                type: 'wine',
                appellation: 'Barolo',
              },
              match: { matchType: 'hybrid', scoreComponents: { lexical: 1, semantic: 1, attribute: 1, popularity: 1, preferenceAlignment: 1 } },
              relevanceScore: 0.9,
              constraints: { matched: [], unmet: [], inferred: [] },
              uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
              evidenceItems: [],
            },
            {
              entity: {
                entityId: 'barolo-2',
                canonicalLabel: '2019 Vietti Barolo Castiglione',
                type: 'wine',
                appellation: 'Barolo',
              },
              match: { matchType: 'hybrid', scoreComponents: { lexical: 0.98, semantic: 0.97, attribute: 0.96, popularity: 0.8, preferenceAlignment: 0.9 } },
              relevanceScore: 0.88,
              constraints: { matched: [], unmet: [], inferred: [] },
              uncertainty: { uncertaintyConfidence: 0.88, missingInfo: [], approximationUsed: false },
              evidenceItems: [],
            },
          ],
          engineDecision: {
            decisionStatus: 'ambiguous',
          },
          meta: {
            queryTimeMs: 5,
            route: 'hybrid',
            version: '1',
            engine_schema_version: 'search_response_v1',
          },
        } as never)
        .mockResolvedValueOnce({
          queryType: 'search',
          results: [
            {
              entity: {
                entityId: 'brunello-1',
                canonicalLabel: '2019 Biondi-Santi Brunello di Montalcino',
                type: 'wine',
                appellation: 'Brunello di Montalcino',
              },
              match: { matchType: 'hybrid', scoreComponents: { lexical: 1, semantic: 1, attribute: 1, popularity: 1, preferenceAlignment: 1 } },
              relevanceScore: 0.89,
              constraints: { matched: [], unmet: [], inferred: [] },
              uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
              evidenceItems: [],
            },
            {
              entity: {
                entityId: 'brunello-2',
                canonicalLabel: '2018 Le Ragnaie Brunello di Montalcino',
                type: 'wine',
                appellation: 'Brunello di Montalcino',
              },
              match: { matchType: 'hybrid', scoreComponents: { lexical: 0.97, semantic: 0.96, attribute: 0.95, popularity: 0.82, preferenceAlignment: 0.88 } },
              relevanceScore: 0.87,
              constraints: { matched: [], unmet: [], inferred: [] },
              uncertainty: { uncertaintyConfidence: 0.89, missingInfo: [], approximationUsed: false },
              evidenceItems: [],
            },
          ],
          engineDecision: {
            decisionStatus: 'ambiguous',
          },
          meta: {
            queryTimeMs: 6,
            route: 'hybrid',
            version: '1',
            engine_schema_version: 'search_response_v1',
          },
        } as never),
    };

    const useCase = new DecomposedSearchUseCase(searchUseCase);
    const comparisonLegs: ComparisonDecompositionLegs = [
      {
        rawQuery: 'Barolo',
        retrievalQuery: 'Barolo wine',
        mode: 'concept',
        retrievalMode: 'hybrid',
        evidenceSource: 'direct_entity_resolution',
        conceptEntityType: 'appellation',
        canonicalConcept: 'Barolo',
      },
      {
        rawQuery: 'Brunello di Montalcino',
        retrievalQuery: 'Brunello di Montalcino wine',
        mode: 'concept',
        retrievalMode: 'hybrid',
        evidenceSource: 'direct_entity_resolution',
        conceptEntityType: 'appellation',
        canonicalConcept: 'Brunello di Montalcino',
      },
    ];

    const response = await useCase.execute(
      ['Barolo', 'Brunello di Montalcino'],
      comparisonLegs,
      'compare',
      'Barolo vs Brunello di Montalcino',
      'req-concept-compare',
      100,
    );

    expect(searchUseCase.execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        query: 'Barolo wine',
        representativeConcept: { field: 'appellation', value: 'Barolo' },
        options: expect.objectContaining({ mode: 'hybrid' }),
      }),
      'req-concept-compare-a',
      undefined,
    );
    expect(searchUseCase.execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        query: 'Brunello di Montalcino wine',
        representativeConcept: { field: 'appellation', value: 'Brunello di Montalcino' },
        options: expect.objectContaining({ mode: 'hybrid' }),
      }),
      'req-concept-compare-b',
      undefined,
    );
    expect(response.entities[0].topResult?.entity.entityId).toBe('barolo-1');
    expect(response.entities[1].topResult?.entity.entityId).toBe('brunello-1');
    expect(response.entities[0].comparisonMode).toBe('concept');
    expect(response.entities[0].canonicalConcept).toBe('Barolo');
    expect(response.entities[0].conceptEntityType).toBe('appellation');
    expect(response.entities[0].conceptAggregate).toEqual({
      canonicalConcept: 'Barolo',
      conceptEntityType: 'appellation',
      representativeResult: response.entities[0].topResult,
      prototypeAxis: response.entities[0].allResults,
      aggregateResultCount: 2,
    });
    expect(response.entities[1].comparisonMode).toBe('concept');
    expect(response.entities[1].canonicalConcept).toBe('Brunello di Montalcino');
    expect(response.entities[1].conceptEntityType).toBe('appellation');
    expect(response.entities[1].conceptAggregate).toEqual({
      canonicalConcept: 'Brunello di Montalcino',
      conceptEntityType: 'appellation',
      representativeResult: response.entities[1].topResult,
      prototypeAxis: response.entities[1].allResults,
      aggregateResultCount: 2,
    });
    expect(response.entities[0].resolutionStatus).toBe('resolved');
    expect(response.entities[1].resolutionStatus).toBe('resolved');
    expect(response.overallStatus).toBe('resolved');
  });

  it('matches appellation concept legs against classification-bearing labels like DOCG', async () => {
    const searchUseCase: SearchExecutorPort = {
      execute: vi.fn()
        .mockResolvedValueOnce({
          queryType: 'search',
          results: [
            {
              entity: {
                entityId: 'barolo-docg-1',
                canonicalLabel: '2018 Massolino Barolo',
                type: 'wine',
                appellation: 'Barolo DOCG',
              },
              match: { matchType: 'hybrid', scoreComponents: { lexical: 1, semantic: 1, attribute: 1, popularity: 1, preferenceAlignment: 1 } },
              relevanceScore: 0.9,
              constraints: { matched: [], unmet: [], inferred: [] },
              uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
              evidenceItems: [],
            },
          ],
          engineDecision: {
            decisionStatus: 'resolved',
          },
          meta: {
            queryTimeMs: 5,
            route: 'hybrid',
            version: '1',
            engine_schema_version: 'search_response_v1',
          },
        } as never)
        .mockResolvedValueOnce({
          queryType: 'search',
          results: [
            {
              entity: {
                entityId: 'brunello-docg-1',
                canonicalLabel: '2018 Le Ragnaie Brunello di Montalcino',
                type: 'wine',
                appellation: 'Brunello di Montalcino DOCG',
              },
              match: { matchType: 'hybrid', scoreComponents: { lexical: 1, semantic: 1, attribute: 1, popularity: 1, preferenceAlignment: 1 } },
              relevanceScore: 0.89,
              constraints: { matched: [], unmet: [], inferred: [] },
              uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
              evidenceItems: [],
            },
          ],
          engineDecision: {
            decisionStatus: 'resolved',
          },
          meta: {
            queryTimeMs: 6,
            route: 'hybrid',
            version: '1',
            engine_schema_version: 'search_response_v1',
          },
        } as never),
    };

    const useCase = new DecomposedSearchUseCase(searchUseCase);
    const comparisonLegs: ComparisonDecompositionLegs = [
      {
        rawQuery: 'Barolo',
        retrievalQuery: 'Barolo wine',
        mode: 'concept',
        retrievalMode: 'hybrid',
        evidenceSource: 'direct_entity_resolution',
        conceptEntityType: 'appellation',
        canonicalConcept: 'Barolo',
      },
      {
        rawQuery: 'Brunello',
        retrievalQuery: 'Brunello di Montalcino wine',
        mode: 'concept',
        retrievalMode: 'hybrid',
        evidenceSource: 'direct_entity_resolution',
        conceptEntityType: 'appellation',
        canonicalConcept: 'Brunello di Montalcino',
      },
    ];

    const response = await useCase.execute(
      ['Barolo', 'Brunello'],
      comparisonLegs,
      'compare',
      'Barolo vs Brunello',
      'req-appellation-docg',
      100,
    );

    expect(response.entities[0].topResult?.entity.entityId).toBe('barolo-docg-1');
    expect(response.entities[1].topResult?.entity.entityId).toBe('brunello-docg-1');
    expect(response.entities[0].resultCount).toBe(1);
    expect(response.entities[1].resultCount).toBe(1);
  });

  it('fails closed when concept comparison results do not satisfy the declared concept', async () => {
    const searchUseCase: SearchExecutorPort = {
      execute: vi.fn()
        .mockResolvedValueOnce({
          queryType: 'search',
          results: [
            {
              entity: {
                entityId: 'grenache-1',
                canonicalLabel: '2012 Morin Pere & Fils Reserve Tradition',
                type: 'wine',
                grapes: ['Grenache'],
              },
              match: { matchType: 'hybrid', scoreComponents: { lexical: 1, semantic: 1, attribute: 1, popularity: 1, preferenceAlignment: 1 } },
              relevanceScore: 0.9,
              constraints: { matched: [], unmet: [], inferred: [] },
              uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
              evidenceItems: [],
            },
          ],
          engineDecision: {
            decisionStatus: 'resolved',
          },
          meta: {
            queryTimeMs: 5,
            route: 'hybrid',
            version: '1',
            engine_schema_version: 'search_response_v1',
          },
        } as never)
        .mockResolvedValueOnce({
          queryType: 'search',
          results: [
            {
              entity: {
                entityId: 'malbec-1',
                canonicalLabel: '2019 Catena Malbec',
                type: 'wine',
                grapes: ['Malbec'],
              },
              match: { matchType: 'hybrid', scoreComponents: { lexical: 1, semantic: 1, attribute: 1, popularity: 1, preferenceAlignment: 1 } },
              relevanceScore: 0.9,
              constraints: { matched: [], unmet: [], inferred: [] },
              uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
              evidenceItems: [],
            },
          ],
          engineDecision: {
            decisionStatus: 'resolved',
          },
          meta: {
            queryTimeMs: 5,
            route: 'hybrid',
            version: '1',
            engine_schema_version: 'search_response_v1',
          },
        } as never),
    };

    const useCase = new DecomposedSearchUseCase(searchUseCase);
    const comparisonLegs: ComparisonDecompositionLegs = [
      {
        rawQuery: '말벡',
        retrievalQuery: 'Malbec wine',
        mode: 'concept',
        retrievalMode: 'hybrid',
        evidenceSource: 'direct_entity_resolution',
        conceptEntityType: 'grape_primary',
        canonicalConcept: 'Malbec',
      },
      {
        rawQuery: '말벡',
        retrievalQuery: 'Malbec wine',
        mode: 'concept',
        retrievalMode: 'hybrid',
        evidenceSource: 'direct_entity_resolution',
        conceptEntityType: 'grape_primary',
        canonicalConcept: 'Malbec',
      },
    ];

    const response = await useCase.execute(
      ['말벡', '말벡'],
      comparisonLegs,
      'compare',
      '말벡 비교',
      'req-malbec-fail-closed',
      100,
    );

    expect(response.entities[0].topResult).toBeNull();
    expect(response.entities[0].allResults).toEqual([]);
    expect(response.entities[0].resultCount).toBe(0);
    expect(response.entities[0].resolutionStatus).toBe('failed');
    expect(response.entities[1].topResult?.entity.entityId).toBe('malbec-1');
  });
});
