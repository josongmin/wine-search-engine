/**
 * Regression: DecomposedSearchUseCase execution semantics.
 *
 * Coverage drivers (maturity 2 → 3 for tools.decomposed-search):
 *   - Two-leg "A vs B" must call SearchUseCase exactly twice with leg-specific
 *     queries, request-ids `${requestId}-a` / `${requestId}-b`, and produce a
 *     ComparisonSearchResponse with both entities populated.
 *   - Korean entity names must traverse unchanged through to each sub-search
 *     (Unicode safety on retrievalQuery, no Latin-only assumption).
 *   - Empty result for one leg degrades gracefully: the other leg remains
 *     resolved, overallStatus reflects the partial outcome (one failed → failed).
 *   - Both legs empty → overallStatus is failed with both entities null-top.
 *   - Parallel execution: the two SearchUseCase calls are kicked off via
 *     Promise.allSettled (concurrent), not awaited sequentially — the second
 *     call must START before the first call RESOLVES.
 *   - Shared parent filters propagate to BOTH legs (e.g. country budget).
 *   - A failure in one leg surfaces as a thrown error (Promise.allSettled
 *     prevents unhandled rejection of the surviving leg, but the use case
 *     still rethrows the first rejection — the surviving call must complete
 *     without an unhandled rejection warning).
 *   - AbortSignal propagation: parent abort flows into both sub-search calls
 *     via the shared options object.
 *   - Determinism: same inputs produce same outputs across repeats
 *     (modulo executionTimeMs which depends on wall clock).
 *   - Mixed-locale legs (Korean leg + English leg) both resolve.
 */

import { describe, expect, it, vi } from 'vitest';
import { DecomposedSearchUseCase } from '../../src/application/search/decomposed-search.usecase.js';
import type { SearchExecutorPort } from '../../src/application/search/port/search-executor.port.js';
import { buildEntityComparisonLegs } from '../../src/domain/query/model/query-decomposition.js';
import type { SearchResponseV1 } from '../../src/domain/response/model/search-response.js';

function makeSearchResponse(
  entityId: string,
  label: string,
  decisionStatus: 'resolved' | 'ambiguous' | 'failed' = 'resolved',
  results: number = 1,
): SearchResponseV1 {
  const items = Array.from({ length: results }, (_, idx) => ({
    entity: {
      entityId: `${entityId}-${idx}`,
      canonicalLabel: `${label} ${idx}`,
      type: 'wine' as const,
    },
    match: {
      matchType: 'entity' as const,
      scoreComponents: {
        lexical: 1,
        semantic: 1,
        attribute: 1,
        popularity: 1,
        preferenceAlignment: 1,
      },
    },
    relevanceScore: 0.9,
    constraints: { matched: [], unmet: [], inferred: [] },
    uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
    evidenceItems: [],
  }));

  return {
    queryType: 'search',
    results: items,
    engineDecision: { decisionStatus },
    meta: {
      queryTimeMs: 5,
      route: 'entity',
      version: '1',
      engine_schema_version: 'search_response_v1',
    },
  } as unknown as SearchResponseV1;
}

describe('DecomposedSearchUseCase — regression', () => {
  it('Opus One vs Sassicaia: two leg-specific searches, both entities populated', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(makeSearchResponse('opus-one', 'Opus One'))
      .mockResolvedValueOnce(makeSearchResponse('sassicaia', 'Sassicaia'));
    const searchUseCase: SearchExecutorPort = { execute };

    const useCase = new DecomposedSearchUseCase(searchUseCase);
    const response = await useCase.execute(
      ['Opus One', 'Sassicaia'],
      buildEntityComparisonLegs(['Opus One', 'Sassicaia']),
      'compare',
      'Opus One vs Sassicaia',
      'req-opus-vs-sassicaia',
      Date.now(),
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ query: 'Opus One' }),
      'req-opus-vs-sassicaia-a',
      undefined,
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ query: 'Sassicaia' }),
      'req-opus-vs-sassicaia-b',
      undefined,
    );
    expect(response.queryType).toBe('comparison');
    expect(response.entities).toHaveLength(2);
    expect(response.entities[0].subQuery).toBe('Opus One');
    expect(response.entities[1].subQuery).toBe('Sassicaia');
    expect(response.entities[0].topResult?.entity.entityId).toBe('opus-one-0');
    expect(response.entities[1].topResult?.entity.entityId).toBe('sassicaia-0');
    expect(response.overallStatus).toBe('resolved');
  });

  it('Korean entity names: 오푸스 원 vs 사씨카이아 → both legs resolved with raw Korean retrievalQuery', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(makeSearchResponse('opus-one-ko', '오푸스 원'))
      .mockResolvedValueOnce(makeSearchResponse('sassicaia-ko', '사씨카이아'));
    const searchUseCase: SearchExecutorPort = { execute };

    const useCase = new DecomposedSearchUseCase(searchUseCase);
    const response = await useCase.execute(
      ['오푸스 원', '사씨카이아'],
      buildEntityComparisonLegs(['오푸스 원', '사씨카이아']),
      'compare',
      '오푸스 원 vs 사씨카이아',
      'req-korean-compare',
      Date.now(),
    );

    expect(execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ query: '오푸스 원' }),
      'req-korean-compare-a',
      undefined,
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ query: '사씨카이아' }),
      'req-korean-compare-b',
      undefined,
    );
    expect(response.entities[0].subQuery).toBe('오푸스 원');
    expect(response.entities[1].subQuery).toBe('사씨카이아');
    expect(response.entities[0].topResult?.entity.entityId).toBe('opus-one-ko-0');
    expect(response.entities[1].topResult?.entity.entityId).toBe('sassicaia-ko-0');
  });

  it('one leg empty: surviving leg still resolves; overallStatus is failed', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(makeSearchResponse('opus-one', 'Opus One', 'resolved', 1))
      .mockResolvedValueOnce(makeSearchResponse('missing', 'Missing', 'failed', 0));
    const searchUseCase: SearchExecutorPort = { execute };

    const useCase = new DecomposedSearchUseCase(searchUseCase);
    const response = await useCase.execute(
      ['Opus One', 'NonexistentWine9999'],
      buildEntityComparisonLegs(['Opus One', 'NonexistentWine9999']),
      'compare',
      'Opus One vs NonexistentWine9999',
      'req-one-leg-empty',
      Date.now(),
    );

    expect(response.entities[0].topResult?.entity.entityId).toBe('opus-one-0');
    expect(response.entities[0].resolutionStatus).toBe('resolved');
    expect(response.entities[1].topResult).toBeNull();
    expect(response.entities[1].resolutionStatus).toBe('failed');
    expect(response.entities[1].resultCount).toBe(0);
    expect(response.overallStatus).toBe('failed');
  });

  it('both legs empty: comparison response returned with both entities null-top and overall failed', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(makeSearchResponse('a', 'A', 'failed', 0))
      .mockResolvedValueOnce(makeSearchResponse('b', 'B', 'failed', 0));
    const searchUseCase: SearchExecutorPort = { execute };

    const useCase = new DecomposedSearchUseCase(searchUseCase);
    const response = await useCase.execute(
      ['Ghost A', 'Ghost B'],
      buildEntityComparisonLegs(['Ghost A', 'Ghost B']),
      'compare',
      'Ghost A vs Ghost B',
      'req-both-legs-empty',
      Date.now(),
    );

    expect(response.entities[0].topResult).toBeNull();
    expect(response.entities[1].topResult).toBeNull();
    expect(response.entities[0].resolutionStatus).toBe('failed');
    expect(response.entities[1].resolutionStatus).toBe('failed');
    expect(response.overallStatus).toBe('failed');
  });

  it('parallel execution: both legs start before the first resolves (Promise.allSettled, not sequential await)', async () => {
    const callOrder: Array<{ stage: 'start' | 'end'; leg: 'a' | 'b'; ts: number }> = [];
    let firstResolve!: (value: SearchResponseV1) => void;

    const execute = vi.fn().mockImplementation((req: { query: string }, requestId: string) => {
      const leg = requestId.endsWith('-a') ? 'a' : 'b';
      callOrder.push({ stage: 'start', leg, ts: Date.now() });
      if (leg === 'a') {
        // Block leg A until leg B has had a chance to start.
        return new Promise<SearchResponseV1>((resolve) => {
          firstResolve = (value) => {
            callOrder.push({ stage: 'end', leg: 'a', ts: Date.now() });
            resolve(value);
          };
        });
      }
      callOrder.push({ stage: 'end', leg: 'b', ts: Date.now() });
      return Promise.resolve(makeSearchResponse('b', req.query));
    });
    const searchUseCase: SearchExecutorPort = { execute };

    const useCase = new DecomposedSearchUseCase(searchUseCase);
    const pending = useCase.execute(
      ['A', 'B'],
      buildEntityComparisonLegs(['A', 'B']),
      'compare',
      'A vs B',
      'req-parallel',
      Date.now(),
    );

    // Yield event loop so both leg invocations get a chance to enqueue.
    await new Promise<void>((resolve) => setImmediate(resolve));

    const startEntries = callOrder.filter((entry) => entry.stage === 'start');
    expect(startEntries).toHaveLength(2);
    // Leg B must have STARTED while leg A is still pending — proof of parallelism.
    expect(startEntries.map((entry) => entry.leg).sort()).toEqual(['a', 'b']);
    expect(callOrder.some((entry) => entry.stage === 'end' && entry.leg === 'b')).toBe(true);
    expect(callOrder.some((entry) => entry.stage === 'end' && entry.leg === 'a')).toBe(false);

    // Unblock leg A and let the use case finish.
    firstResolve(makeSearchResponse('a', 'A'));
    const response = await pending;
    expect(response.queryType).toBe('comparison');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('shared parent filters propagate identically into both legs', async () => {
    const execute = vi.fn().mockResolvedValue(makeSearchResponse('x', 'X'));
    const searchUseCase: SearchExecutorPort = { execute };

    const useCase = new DecomposedSearchUseCase(searchUseCase);
    await useCase.execute(
      ['Wine A', 'Wine B'],
      buildEntityComparisonLegs(['Wine A', 'Wine B']),
      'compare',
      'Wine A vs Wine B under $100',
      'req-shared-budget',
      Date.now(),
      {
        filters: [{ attribute: 'country', operator: '=', value: 'France' }],
        queryBudget: { maxLatencyMs: 800, maxCandidates: 40, rerankLimit: 10 },
      },
    );

    const firstCall = execute.mock.calls[0][0] as { filters?: unknown; queryBudget?: unknown };
    const secondCall = execute.mock.calls[1][0] as { filters?: unknown; queryBudget?: unknown };
    expect(firstCall.filters).toEqual([
      { attribute: 'country', operator: '=', value: 'France' },
    ]);
    expect(secondCall.filters).toEqual([
      { attribute: 'country', operator: '=', value: 'France' },
    ]);
    expect(firstCall.queryBudget).toEqual({ maxLatencyMs: 800, maxCandidates: 40, rerankLimit: 10 });
    expect(secondCall.queryBudget).toEqual({ maxLatencyMs: 800, maxCandidates: 40, rerankLimit: 10 });
  });

  it('error in one leg: rethrown by the use case; surviving leg does not raise unhandled rejection', async () => {
    let bResolved = false;
    const execute = vi.fn().mockImplementation((_req: unknown, requestId: string) => {
      if (requestId.endsWith('-a')) {
        return Promise.reject(new Error('leg A failed'));
      }
      return new Promise<SearchResponseV1>((resolve) => {
        // Ensure leg B has time to be settled even though leg A rejects first.
        setImmediate(() => {
          bResolved = true;
          resolve(makeSearchResponse('b', 'B'));
        });
      });
    });
    const searchUseCase: SearchExecutorPort = { execute };

    const useCase = new DecomposedSearchUseCase(searchUseCase);
    await expect(
      useCase.execute(
        ['A', 'B'],
        buildEntityComparisonLegs(['A', 'B']),
        'compare',
        'A vs B',
        'req-error-leg-a',
        Date.now(),
      ),
    ).rejects.toThrow('leg A failed');

    // Surviving leg must still have run to completion (no unhandled rejection of leg B).
    expect(bResolved).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('AbortSignal propagation: aborting parent throws AbortError before any sub-search runs', async () => {
    const execute = vi.fn().mockResolvedValue(makeSearchResponse('x', 'X'));
    const searchUseCase: SearchExecutorPort = { execute };
    const useCase = new DecomposedSearchUseCase(searchUseCase);

    const controller = new AbortController();
    controller.abort();

    await expect(
      useCase.execute(
        ['A', 'B'],
        buildEntityComparisonLegs(['A', 'B']),
        'compare',
        'A vs B',
        'req-abort-pre',
        Date.now(),
        undefined,
        { abortSignal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // Pre-flight abort guard prevents either leg from being dispatched.
    expect(execute).not.toHaveBeenCalled();
  });

  it('AbortSignal propagation: each leg invocation receives the parent options object (incl. abortSignal)', async () => {
    const execute = vi.fn().mockResolvedValue(makeSearchResponse('x', 'X'));
    const searchUseCase: SearchExecutorPort = { execute };
    const useCase = new DecomposedSearchUseCase(searchUseCase);

    const controller = new AbortController();
    const options = { abortSignal: controller.signal };
    await useCase.execute(
      ['A', 'B'],
      buildEntityComparisonLegs(['A', 'B']),
      'compare',
      'A vs B',
      'req-abort-propagate',
      Date.now(),
      undefined,
      options,
    );

    expect(execute).toHaveBeenCalledTimes(2);
    // The third argument to each call must be the parent options (shared reference).
    expect(execute.mock.calls[0][2]).toBe(options);
    expect(execute.mock.calls[1][2]).toBe(options);
  });

  it('determinism: same inputs produce structurally identical entities across repeats (modulo timing)', async () => {
    const runOnce = async () => {
      const execute = vi.fn()
        .mockResolvedValueOnce(makeSearchResponse('opus-one', 'Opus One'))
        .mockResolvedValueOnce(makeSearchResponse('sassicaia', 'Sassicaia'));
      const useCase = new DecomposedSearchUseCase({ execute });
      return useCase.execute(
        ['Opus One', 'Sassicaia'],
        buildEntityComparisonLegs(['Opus One', 'Sassicaia']),
        'compare',
        'Opus One vs Sassicaia',
        'req-determinism',
        Date.now(),
      );
    };

    const runs = await Promise.all([runOnce(), runOnce(), runOnce(), runOnce(), runOnce()]);
    const signature = (entityId: string | undefined) => entityId;
    const ids0 = runs.map((response) => signature(response.entities[0].topResult?.entity.entityId));
    const ids1 = runs.map((response) => signature(response.entities[1].topResult?.entity.entityId));
    expect(new Set(ids0).size).toBe(1);
    expect(new Set(ids1).size).toBe(1);
    expect(runs.every((response) => response.overallStatus === 'resolved')).toBe(true);
    expect(runs.every((response) => response.entities[0].subQuery === 'Opus One')).toBe(true);
    expect(runs.every((response) => response.entities[1].subQuery === 'Sassicaia')).toBe(true);
  });

  it('mixed-locale legs: Korean leg + English leg both resolve independently', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(makeSearchResponse('opus-one-ko', '오푸스 원'))
      .mockResolvedValueOnce(makeSearchResponse('sassicaia-en', 'Sassicaia'));
    const searchUseCase: SearchExecutorPort = { execute };

    const useCase = new DecomposedSearchUseCase(searchUseCase);
    const response = await useCase.execute(
      ['오푸스 원', 'Sassicaia'],
      buildEntityComparisonLegs(['오푸스 원', 'Sassicaia']),
      'compare',
      '오푸스 원 vs Sassicaia',
      'req-mixed-locale',
      Date.now(),
    );

    expect(execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ query: '오푸스 원' }),
      'req-mixed-locale-a',
      undefined,
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ query: 'Sassicaia' }),
      'req-mixed-locale-b',
      undefined,
    );
    expect(response.entities[0].topResult?.entity.entityId).toBe('opus-one-ko-0');
    expect(response.entities[1].topResult?.entity.entityId).toBe('sassicaia-en-0');
    expect(response.overallStatus).toBe('resolved');
  });
});
