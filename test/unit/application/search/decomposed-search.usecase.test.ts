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
          results: [{
            entity: {
              entityId: 'barolo-1',
              canonicalLabel: '2020 Massolino Barolo',
              type: 'wine',
            },
            match: { matchType: 'hybrid', scoreComponents: { lexical: 1, semantic: 1, attribute: 1, popularity: 1, preferenceAlignment: 1 } },
            relevanceScore: 0.9,
            constraints: { matched: [], unmet: [], inferred: [] },
            uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
            evidenceItems: [],
          }],
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
          results: [{
            entity: {
              entityId: 'brunello-1',
              canonicalLabel: '2019 Biondi-Santi Brunello di Montalcino',
              type: 'wine',
            },
            match: { matchType: 'hybrid', scoreComponents: { lexical: 1, semantic: 1, attribute: 1, popularity: 1, preferenceAlignment: 1 } },
            relevanceScore: 0.89,
            constraints: { matched: [], unmet: [], inferred: [] },
            uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
            evidenceItems: [],
          }],
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
        options: expect.objectContaining({ mode: 'hybrid' }),
      }),
      'req-concept-compare-a',
      undefined,
    );
    expect(searchUseCase.execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        query: 'Brunello di Montalcino wine',
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
    expect(response.entities[1].comparisonMode).toBe('concept');
    expect(response.entities[1].canonicalConcept).toBe('Brunello di Montalcino');
    expect(response.entities[1].conceptEntityType).toBe('appellation');
    expect(response.entities[0].resolutionStatus).toBe('resolved');
    expect(response.entities[1].resolutionStatus).toBe('resolved');
    expect(response.overallStatus).toBe('resolved');
  });
});
