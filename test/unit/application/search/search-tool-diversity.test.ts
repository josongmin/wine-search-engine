import { describe, expect, it, vi } from 'vitest';
import { createStageTimer } from '../../../../src/domain/shared/stage-timer.js';
import type { SearchExecutorPort, SearchExecutorResult } from '../../../../src/application/search/port/search-executor.port.js';
import { executeSearchWithTypedWineDiversityDiscovery } from '../../../../src/application/search/search-tool-diversity.js';
import type { SearchRequest } from '../../../../src/application/search/search-request.dto.js';
import type { ComparisonSearchResponse } from '../../../../src/domain/response/model/comparison-response.js';
import type { SearchResponseV1 } from '../../../../src/domain/response/model/search-response.js';

function makeSearchResponse(requestId: string): SearchResponseV1 {
  return {
    queryType: 'search',
    engineDecision: {} as SearchResponseV1['engineDecision'],
    results: [],
    meta: {
      requestId,
      queryTimeMs: 10,
    } as SearchResponseV1['meta'],
  };
}

function makeComparisonResponse(requestId: string): ComparisonSearchResponse {
  return {
    queryType: 'comparison',
    originalQuery: 'compare wines',
    comparisonIntent: 'compare',
    entities: [
      {
        subQuery: 'wine a',
        topResult: null,
        resultCount: 0,
        resolutionStatus: 'failed',
        allResults: [],
      },
      {
        subQuery: 'wine b',
        topResult: null,
        resultCount: 0,
        resolutionStatus: 'failed',
        allResults: [],
      },
    ],
    overallStatus: 'failed',
    requestId,
    executionTimeMs: 1,
  };
}

describe('executeSearchWithTypedWineDiversityDiscovery', () => {
  it('omits the shared StageTimer from typed parallel sub-searches while keeping it for fallback', async () => {
    const stageTimer = createStageTimer();
    const abortSignal = new AbortController().signal;
    const searchUseCase = {
      execute: vi.fn(async (_request: SearchRequest, requestId: string): Promise<SearchExecutorResult> =>
        makeSearchResponse(requestId)),
    } satisfies SearchExecutorPort;

    const response = await executeSearchWithTypedWineDiversityDiscovery({
      searchUseCase,
      requestId: 'req-1',
      fallbackRequest: { query: 'find diverse wines' },
      candidateGatherLimit: 5,
      returnLimit: 5,
      shouldRun: true,
      buildTypedRequest: (wineType) => ({
        query: `find diverse ${wineType} wines`,
      }),
      abortSignal,
      stageTimer,
    });

    expect(response.queryType).toBe('search');
    expect(searchUseCase.execute).toHaveBeenCalledTimes(3);

    for (const call of searchUseCase.execute.mock.calls) {
      expect(call[2]).toEqual({ abortSignal });
      expect(call[2]).not.toHaveProperty('stageTimer');
    }

    const fallbackSearchUseCase = {
      execute: vi.fn(async (_request: SearchRequest, requestId: string): Promise<SearchExecutorResult> =>
        makeSearchResponse(requestId)),
    } satisfies SearchExecutorPort;

    await executeSearchWithTypedWineDiversityDiscovery({
      searchUseCase: fallbackSearchUseCase,
      requestId: 'req-2',
      fallbackRequest: { query: 'find wines' },
      candidateGatherLimit: 5,
      returnLimit: 5,
      shouldRun: false,
      buildTypedRequest: (wineType) => ({
        query: `find ${wineType} wines`,
      }),
      abortSignal,
      stageTimer,
    });

    expect(fallbackSearchUseCase.execute).toHaveBeenCalledTimes(1);
    expect(fallbackSearchUseCase.execute.mock.calls[0]?.[2]).toEqual({
      abortSignal,
      stageTimer,
    });
  });

  it('keeps the shared StageTimer on the final single-search fallback after typed fan-out returns no search results', async () => {
    const stageTimer = createStageTimer();
    const abortSignal = new AbortController().signal;
    const searchUseCase = {
      execute: vi.fn(async (_request: SearchRequest, requestId: string): Promise<SearchExecutorResult> => (
        requestId.includes(':diversity:')
          ? makeComparisonResponse(requestId)
          : makeSearchResponse(requestId)
      )),
    } satisfies SearchExecutorPort;

    await executeSearchWithTypedWineDiversityDiscovery({
      searchUseCase,
      requestId: 'req-3',
      fallbackRequest: { query: 'find fallback wines' },
      candidateGatherLimit: 5,
      returnLimit: 5,
      shouldRun: true,
      buildTypedRequest: (wineType) => ({
        query: `find ${wineType} wines`,
      }),
      abortSignal,
      stageTimer,
    });

    expect(searchUseCase.execute).toHaveBeenCalledTimes(4);
    expect(searchUseCase.execute.mock.calls.at(-1)?.[2]).toEqual({
      abortSignal,
      stageTimer,
    });
  });

  it('keeps surviving typed search results when one diversity branch throws', async () => {
    const searchUseCase = {
      execute: vi.fn(async (_request: SearchRequest, requestId: string): Promise<SearchExecutorResult> => {
        if (requestId.endsWith(':diversity:sparkling')) {
          throw new Error('HTTP/2 GOAWAY');
        }
        return makeSearchResponse(requestId);
      }),
    } satisfies SearchExecutorPort;

    const response = await executeSearchWithTypedWineDiversityDiscovery({
      searchUseCase,
      requestId: 'req-4',
      fallbackRequest: { query: 'find fallback wines' },
      candidateGatherLimit: 5,
      returnLimit: 5,
      shouldRun: true,
      buildTypedRequest: (wineType) => ({
        query: `find ${wineType} wines`,
      }),
    });

    expect(searchUseCase.execute).toHaveBeenCalledTimes(3);
    expect(response.queryType).toBe('search');
    expect(response.meta.requestId).toBe('req-4');
  });

  it('applies resultPolicy before diversity merge and enforces the returnLimit on the merged result', async () => {
    const searchUseCase = {
      execute: vi.fn(async (_request: SearchRequest, requestId: string): Promise<SearchExecutorResult> => {
        const resultMap: Record<string, SearchResponseV1['results']> = {
          'req-5:diversity:white': [
            {
              entity: { entityId: 'white-over', canonicalLabel: 'White Over', type: 'wine', wineType: 'white', priceRange: '$120' },
              relevanceScore: 0.97,
              match: {} as SearchResponseV1['results'][number]['match'],
              constraints: { matched: [], unmet: [], inferred: [] },
              uncertainty: { uncertaintyConfidence: 0.8, missingInfo: [], approximationUsed: false },
              evidenceItems: [],
            },
            {
              entity: { entityId: 'white-under', canonicalLabel: 'White Under', type: 'wine', wineType: 'white', priceRange: '$20' },
              relevanceScore: 0.78,
              match: {} as SearchResponseV1['results'][number]['match'],
              constraints: { matched: [], unmet: [], inferred: [] },
              uncertainty: { uncertaintyConfidence: 0.8, missingInfo: [], approximationUsed: false },
              evidenceItems: [],
            },
          ],
          'req-5:diversity:sparkling': [
            {
              entity: { entityId: 'sparkling-over', canonicalLabel: 'Sparkling Over', type: 'wine', wineType: 'sparkling', priceRange: '$110' },
              relevanceScore: 0.99,
              match: {} as SearchResponseV1['results'][number]['match'],
              constraints: { matched: [], unmet: [], inferred: [] },
              uncertainty: { uncertaintyConfidence: 0.8, missingInfo: [], approximationUsed: false },
              evidenceItems: [],
            },
            {
              entity: { entityId: 'sparkling-under', canonicalLabel: 'Sparkling Under', type: 'wine', wineType: 'sparkling', priceRange: '$18' },
              relevanceScore: 0.8,
              match: {} as SearchResponseV1['results'][number]['match'],
              constraints: { matched: [], unmet: [], inferred: [] },
              uncertainty: { uncertaintyConfidence: 0.8, missingInfo: [], approximationUsed: false },
              evidenceItems: [],
            },
          ],
          'req-5:diversity:red': [
            {
              entity: { entityId: 'red-over', canonicalLabel: 'Red Over', type: 'wine', wineType: 'red', priceRange: '$130' },
              relevanceScore: 0.98,
              match: {} as SearchResponseV1['results'][number]['match'],
              constraints: { matched: [], unmet: [], inferred: [] },
              uncertainty: { uncertaintyConfidence: 0.8, missingInfo: [], approximationUsed: false },
              evidenceItems: [],
            },
            {
              entity: { entityId: 'red-under', canonicalLabel: 'Red Under', type: 'wine', wineType: 'red', priceRange: '$19' },
              relevanceScore: 0.79,
              match: {} as SearchResponseV1['results'][number]['match'],
              constraints: { matched: [], unmet: [], inferred: [] },
              uncertainty: { uncertaintyConfidence: 0.8, missingInfo: [], approximationUsed: false },
              evidenceItems: [],
            },
          ],
        };
        return {
          ...makeSearchResponse(requestId),
          results: resultMap[requestId] ?? [],
        };
      }),
    } satisfies SearchExecutorPort;

    const response = await executeSearchWithTypedWineDiversityDiscovery({
      searchUseCase,
      requestId: 'req-5',
      fallbackRequest: { query: 'find fallback wines', limit: 5 },
      candidateGatherLimit: 5,
      returnLimit: 2,
      shouldRun: true,
      buildTypedRequest: (wineType) => ({
        query: `find ${wineType} wines`,
        limit: 5,
      }),
      resultPolicy: (searchResponse) => ({
        ...searchResponse,
        results: searchResponse.results.filter((result) => result.entity.priceRange === '$20' || result.entity.priceRange === '$18' || result.entity.priceRange === '$19'),
      }),
    });

    expect(response.queryType).toBe('search');
    expect(response.results.map((result) => result.entity.entityId)).toEqual([
      'sparkling-under',
      'red-under',
    ]);
  });
});
