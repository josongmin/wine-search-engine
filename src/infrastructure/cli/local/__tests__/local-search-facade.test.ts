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

});
