import { describe, expect, it } from 'vitest';
import { LocalSearchFacade } from '../local-search-facade.js';

describe('LocalSearchFacade', () => {
  it('projects local search results to snake_case wire shape', async () => {
    const facade = new LocalSearchFacade({
      withContainer: async (work) =>
        await work({
          searchUseCase: {
            execute: async () => ({
              queryType: 'search',
              engineDecision: { runtimeCorrelationRef: 'runtime-1' },
              meta: { authorityTraceRef: 'authority-1' },
              results: [],
            }),
          },
        } as never),
    });

    const result = await facade.hybrid(
      { query: 'opus one 2018' },
      { requestId: 'req-1' },
    );

    expect(result).toEqual({
      query_type: 'search',
      engine_decision: { runtime_correlation_ref: 'runtime-1' },
      meta: { authority_trace_ref: 'authority-1' },
      results: [],
    });
  });

  it('lookupWine always routes through the V2 compatibility seam', async () => {
    const seen: unknown[] = [];
    const facade = new LocalSearchFacade({
      withContainer: async (work) =>
        await work({
          lookupWineV2CompatibilityUseCase: {
            execute: async (input: unknown) => {
              seen.push(input);
              return { queryType: 'search', results: [] };
            },
          },
          searchUseCase: {
            execute: async () => {
              throw new Error('searchUseCase should not be called for lookupWine');
            },
          },
        } as never),
    });

    await facade.lookupWine({ query: 'opus one 2018' }, { requestId: 'req-2' });

    expect(seen[0]).toEqual({
      query: 'opus one 2018',
      requestId: 'req-2',
    });
  });

  it('lookupWine prefers the V2 compatibility seam when wired', async () => {
    const compatibilityCalls: unknown[] = [];
    const facade = new LocalSearchFacade({
      withContainer: async (work) =>
        await work({
          lookupWineV2CompatibilityUseCase: {
            execute: async (input: unknown) => {
              compatibilityCalls.push(input);
              return {
                queryType: 'search',
                engineDecision: { decisionStatus: 'resolved' },
                meta: {},
                results: [],
              };
            },
          },
          searchUseCase: {
            execute: async () => {
              throw new Error('searchUseCase should not be called');
            },
          },
        } as never),
    });

    await facade.lookupWine(
      { query: 'opus one 2018', limit: 3, context: { locale: 'ko', currency: 'KRW' } },
      { requestId: 'req-3' },
    );

    expect(compatibilityCalls[0]).toEqual({
      query: 'opus one 2018',
      limit: 3,
      locale: 'ko',
      requestId: 'req-3',
    });
  });
});
