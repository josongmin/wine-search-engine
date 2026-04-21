import { describe, expect, it, vi } from 'vitest';
import {
  DecomposedSearchUseCase,
  UnexpectedDecomposedResponseError,
} from '../../../../src/application/search/decomposed-search.usecase.js';
import type { SearchExecutorPort } from '../../../../src/application/search/port/search-executor.port.js';

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
});
