/**
 * Integration tests for infrastructure error-handling paths.
 *
 * Covers:
 * 1. VespaNetworkError wrapping when fetch throws a transport error.
 * 2. VespaHttpError with isRateLimited=true on HTTP 429.
 * 3. VespaHttpError on HTTP 500 triggers retry (up to maxRetries), then succeeds on 200.
 * 4. CacheService circuit breaker opens after threshold consecutive Redis errors.
 *
 * All tests use vi.fn() mocks — no real network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  VespaClient,
  VespaNetworkError,
  VespaHttpError,
} from '../../src/infrastructure/vespa/vespa-client.js';
import { CacheService } from '../../src/domain/performance/service/cache-service.js';
import type { QueryCachePort } from '../../src/domain/performance/port/query-cache.port.js';
import type { QueryPlanV1 } from '../../src/domain/query/model/query-plan.js';
import type { DecisionSnapshot } from '../../src/domain/shared/types/index.js';
import { buildDecisionSnapshotId, SEARCH_RESPONSE_CONTRACT_VERSION } from '../../src/application/search/search-usecase-decision-snapshot.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockResponse(status: number, body = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: () => Promise.resolve(body),
    json: () => Promise.resolve({}),
  } as unknown as Response;
}

function makeOkQueryResponse(): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: () => Promise.resolve(''),
    json: () =>
      Promise.resolve({
        root: {
          id: 'toplevel',
          relevance: 1.0,
          fields: { totalCount: 0 },
          children: [],
        },
      }),
  } as unknown as Response;
}

function createMockPlan(): QueryPlanV1 {
  return {
    rawQuery: 'test',
    normalizedQuery: 'test',
    intent: 'search',
    additionalIntents: [],
    queryClass: 'simple',
    policy: { type: 'default' },
    anchors: [],
    uncertainty: { terms: [], confidence: 0 },
    route: 'hybrid',
    retrievalMode: 'entity_lookup',
    constraints: { hard: [], soft: [] },
    expansions: { lexical: [], semantic: [] },
    policyRuleVersion: '1',
    thresholdProfileId: 'default',
    plannerVersion: '1',
  } as unknown as QueryPlanV1;
}

function createMockSnapshot(modelVersion = 'test-v1'): DecisionSnapshot {
  const base = {
    model_versions: { embedding: modelVersion },
    index_versions: { wine_content: '2026-04-01' },
    policy_rule_version: '1',
    threshold_profile_id: 'default',
    planner_version: '1',
    feature_flags: {},
    response_contract_version: SEARCH_RESPONSE_CONTRACT_VERSION,
  };
  return { snapshot_id: buildDecisionSnapshotId(base), ...base };
}

function createMockCompiledQuery() {
  return {
    query: {
      rawQuery: 'test',
      normalizedQuery: 'test',
      intent: 'search',
      queryClass: 'simple',
      anchors: [],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      uncertainty: {} as never,
      plannerVersion: '1',
      policyRuleVersion: '1',
      thresholdProfileId: 'default',
      retrievalPlan: {
        hardFilterTokens: [],
        softBoosts: [],
        inferredBoosts: [],
        sensoryPriors: [],
        planVersion: 'retrieval-plan-v1.0',
      },
    },
    execution: {
      effectiveRoute: 'hybrid',
      effectiveRetrievalMode: 'entity_lookup' as const,
      routeSource: 'planner' as const,
      budget: { maxCandidates: 20, enablePrecisionRerank: true },
      provenancePolicy: {
        requireIdentitySeal: false,
        requireConstraintEvidence: false,
        requireAnchorEvidence: false,
      },
    },
  };
}

function makeFailingQueryCache(): QueryCachePort {
  return {
    get: async () => {
      throw new Error('Redis connection refused');
    },
    getWithDiagnostics: async () => {
      throw new Error('Redis connection refused');
    },
    set: async () => {
      throw new Error('Redis connection refused');
    },
    delete: async () => {},
    deletePattern: async () => 0,
    getStats: () => Promise.resolve({ hits: 0, misses: 0, size: 0, entriesCount: 0 }),
    clear: async () => 0,
  };
}

function makeCountingFailingQueryCache(message = 'Redis connection refused') {
  let callCount = 0;
  const cache: QueryCachePort = {
    get: async () => {
      callCount++;
      throw new Error(message);
    },
    getWithDiagnostics: async () => {
      callCount++;
      throw new Error(message);
    },
    set: async () => {
      callCount++;
      throw new Error(message);
    },
    delete: async () => {},
    deletePattern: async () => 0,
    getStats: () => Promise.resolve({ hits: 0, misses: 0, size: 0, entriesCount: 0 }),
    clear: async () => 0,
  };
  return {
    cache,
    getCallCount: () => callCount,
  };
}

function mockFetchSequence(...responses: Response[]) {
  const spy = vi.spyOn(globalThis, 'fetch');
  for (const response of responses) {
    spy.mockResolvedValueOnce(response);
  }
  return spy;
}

// ---------------------------------------------------------------------------
// Test 1 & 2 & 3: VespaClient error-handling
// ---------------------------------------------------------------------------

describe('VespaClient — error-handling paths', () => {
  let client: VespaClient;

  beforeEach(() => {
    client = new VespaClient('http://localhost:8080', 'wine-ns', 'wine-app');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Test 1: Network error wrapping ──────────────────────────────────────

  describe('Test 1 — VespaNetworkError wrapping', () => {
    it('wraps a fetch TypeError in VespaNetworkError (not raw Error)', async () => {
      const networkFailure = new TypeError('Failed to fetch');
      // query() wraps fetch in withRetry — a single rejected call would succeed on retry against real Vespa.
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(networkFailure);

      await expect(client.query('select * from sources * where true')).rejects.toSatisfy(
        (err: unknown) => err instanceof VespaNetworkError,
      );
    });

    it('VespaNetworkError preserves the original cause error message', async () => {
      const networkFailure = new TypeError('ECONNREFUSED');
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(networkFailure);

      let caught: unknown;
      try {
        await client.query('select * from sources * where true');
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(VespaNetworkError);
      // The cause is always an Error instance wrapping the original transport failure.
      expect((caught as VespaNetworkError).cause).toBeInstanceOf(Error);
    });

    it('does NOT throw a raw Error on transport failure', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('socket hang up'));

      await expect(client.query('select * from sources * where true')).rejects.not.toBeInstanceOf(
        TypeError,
      );
    });

    it('retries document POST on transient transport failure and succeeds', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new TypeError('HTTP/2 GOAWAY'))
        .mockResolvedValueOnce(makeMockResponse(200, ''));

      await expect(
        client.put('wine-1', { canonical_label: 'Retryable Wine' }),
      ).resolves.toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry document POST on 400 client errors', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(makeMockResponse(400, 'bad request'));

      await expect(
        client.put('wine-1', { canonical_label: 'Broken Wine' }),
      ).rejects.toBeInstanceOf(VespaHttpError);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ── Test 2: HTTP 429 → VespaHttpError with isRateLimited=true ───────────

  describe('Test 2 — VespaHttpError on HTTP 429', () => {
    it('throws VespaHttpError with isRateLimited=true on 429', async () => {
      // 429 is rate-limited, so withRetry DOES retry it (isRateLimited bypasses
      // the early-throw guard). Mock all 3 attempts (maxRetries=2) to return 429.
      mockFetchSequence(
        makeMockResponse(429, 'rate limited'),
        makeMockResponse(429, 'rate limited'),
        makeMockResponse(429, 'rate limited'),
      );

      let caught: unknown;
      try {
        await client.query('select * from sources * where true');
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(VespaHttpError);
      const httpErr = caught as VespaHttpError;
      expect(httpErr.statusCode).toBe(429);
      expect(httpErr.isRateLimited).toBe(true);
    });

    it('VespaHttpError on 429 keeps isClientError=false (rate-limit ≠ malformed 4xx)', async () => {
      mockFetchSequence(
        makeMockResponse(429, 'rate limited'),
        makeMockResponse(429, 'rate limited'),
        makeMockResponse(429, 'rate limited'),
      );

      await expect(client.query('select * from sources * where true')).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof VespaHttpError &&
          err.isRateLimited &&
          !err.isClientError,
      );
    });
  });

  // ── Test 3: HTTP 500 retries, then succeeds on 200 ─────────────────────

  describe('Test 3 — HTTP 500 triggers retry up to maxRetries', () => {
    it('retries on 500 and succeeds on the third attempt (200)', async () => {
      // VESPA_RETRY_CONFIG.maxRetries = 2, so the sequence is:
      //   attempt 0 → 500 (fail, retry)
      //   attempt 1 → 500 (fail, retry)
      //   attempt 2 → 200 (success)
      const fetchSpy = mockFetchSequence(
        makeMockResponse(500, 'server error'),
        makeMockResponse(500, 'server error'),
        makeOkQueryResponse(),
      );

      const result = await client.query('select * from sources * where true');

      expect(result.root).toMatchObject({
        id: 'toplevel',
        fields: { totalCount: 0 },
        children: [],
      });
      // fetch was called exactly 3 times (2 failures + 1 success)
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('throws VespaHttpError after exhausting all retries on persistent 500', async () => {
      // All 3 attempts fail (attempt 0, 1, 2 = maxRetries+1 calls)
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValue(makeMockResponse(500, 'persistent server error'));

      await expect(client.query('select * from sources * where true')).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof VespaHttpError &&
          err.statusCode === 500 &&
          !err.isRateLimited &&
          !err.isClientError,
      );
    });

    it('does NOT retry on 4xx client errors (non-429)', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(makeMockResponse(400, 'bad request'));

      await expect(client.query('select * from sources * where true')).rejects.toBeInstanceOf(
        VespaHttpError,
      );
      // Should only be called once — no retries for 4xx
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Test 4: CacheService circuit breaker
// ---------------------------------------------------------------------------

describe('CacheService — circuit breaker', () => {
  // The circuit breaker threshold is configurable; we use 2 to keep the test fast.
  const THRESHOLD = 2;
  // Long reset window so the breaker stays open for the duration of the test.
  const RESET_MS = 60_000;

  let cacheService: CacheService;
  let mockPlan: QueryPlanV1;
  let mockSnapshot: DecisionSnapshot;
  let mockCompiled: ReturnType<typeof createMockCompiledQuery>;

  beforeEach(() => {
    cacheService = new CacheService(makeFailingQueryCache(), undefined, THRESHOLD, RESET_MS);
    mockPlan = createMockPlan();
    mockSnapshot = createMockSnapshot();
    mockCompiled = createMockCompiledQuery();
  });

  it('returns infra_error on the first failure', async () => {
    const result = await cacheService.getSearchResponse(
      mockPlan,
      {},
      mockSnapshot,
      undefined,
      mockCompiled,
    );

    expect(result.kind).toBe('infra_error');
    if (result.kind === 'infra_error') {
      expect(result.message).toBe('Redis connection refused');
    }
  });

  it('opens the circuit breaker after threshold consecutive errors', async () => {
    // Trigger THRESHOLD failures to trip the breaker.
    for (let i = 0; i < THRESHOLD; i++) {
      await cacheService.getSearchResponse(mockPlan, {}, mockSnapshot, undefined, mockCompiled);
    }

    // The next call should be short-circuited.
    const result = await cacheService.getSearchResponse(
      mockPlan,
      {},
      mockSnapshot,
      undefined,
      mockCompiled,
    );

    expect(result.kind).toBe('breaker_open');
  });

  it('skips Redis entirely while the circuit is open (no further cache calls)', async () => {
    const countingFailingCache = makeCountingFailingQueryCache();
    const svc = new CacheService(countingFailingCache.cache, undefined, THRESHOLD, RESET_MS);

    // Trigger THRESHOLD failures to trip the breaker.
    for (let i = 0; i < THRESHOLD; i++) {
      await svc.getSearchResponse(mockPlan, {}, mockSnapshot, undefined, mockCompiled);
    }

    const callsBeforeOpen = countingFailingCache.getCallCount();

    // Now the circuit is open; this call should NOT touch Redis.
    await svc.getSearchResponse(mockPlan, {}, mockSnapshot, undefined, mockCompiled);
    await svc.getSearchResponse(mockPlan, {}, mockSnapshot, undefined, mockCompiled);

    expect(countingFailingCache.getCallCount()).toBe(callsBeforeOpen); // no new cache calls
  });

  it('resets the circuit breaker after the reset window elapses', async () => {
    // Use a very short reset window so we can simulate expiry via fake timers.
    vi.useFakeTimers();

    const SHORT_RESET_MS = 100;
    const countingCache = makeCountingFailingQueryCache('Redis down');
    const svc = new CacheService(countingCache.cache, undefined, THRESHOLD, SHORT_RESET_MS);

    // Trip the breaker.
    for (let i = 0; i < THRESHOLD; i++) {
      await svc.getSearchResponse(mockPlan, {}, mockSnapshot, undefined, mockCompiled);
    }

    // Confirm breaker is open.
    const openResult = await svc.getSearchResponse(
      mockPlan,
      {},
      mockSnapshot,
      undefined,
      mockCompiled,
    );
    expect(openResult.kind).toBe('breaker_open');

    const callsWhenOpen = countingCache.getCallCount();

    // Advance time past the reset window.
    vi.advanceTimersByTime(SHORT_RESET_MS + 1);

    // Now the breaker should have auto-reset; the next call should attempt Redis again.
    await svc.getSearchResponse(mockPlan, {}, mockSnapshot, undefined, mockCompiled);
    expect(countingCache.getCallCount()).toBeGreaterThan(callsWhenOpen);

    vi.useRealTimers();
  });
});
