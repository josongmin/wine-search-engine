import { describe, expect, it, vi } from 'vitest';
import { createStageTimer } from '../../../../src/observability/stage-timer.js';
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
      effectiveLimit: 5,
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
      effectiveLimit: 5,
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
      effectiveLimit: 5,
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
});
