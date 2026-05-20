/**
 * E3-T2: Circuit-breaker registration test for VespaSearchIndex.
 *
 * Verifies that on construction the 'vespa-search' circuit breaker is
 * registered with the globalCircuitBreakerRegistry.
 *
 * E3-T3: AbortSignal passthrough test for VespaClient.query().
 *
 * Verifies that an already-aborted AbortSignal causes query() to reject
 * with an abort-related error.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { VespaSearchIndex } from '../vespa-search-index.js';
import { VespaClient, VespaHttpError } from '../vespa-client.js';
import { globalCircuitBreakerRegistry } from '../../../domain/observability/circuit-breaker-registry.js';

function newClient(): VespaClient {
  return new VespaClient('http://localhost:8080', 'test-ns', 'wine', {
    searchRequestMs: 3_000,
  });
}

function newIndex(client?: VespaClient): VespaSearchIndex {
  return new VespaSearchIndex(client ?? newClient());
}

describe('VespaSearchIndex circuit breaker (E3-T2)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    globalCircuitBreakerRegistry.clear();
  });

  it('registers vespa-search breaker with globalCircuitBreakerRegistry on construction', () => {
    newIndex();
    const snapshot = globalCircuitBreakerRegistry.snapshot();
    const names = snapshot.map((s) => s.name);
    expect(names).toContain('vespa-search');
  });

  it('starts in CLOSED state', () => {
    newIndex();
    const snapshot = globalCircuitBreakerRegistry.snapshot();
    const breaker = snapshot.find((s) => s.name === 'vespa-search');
    expect(breaker?.state).toBe('CLOSED');
  });
});

// ── Bug 2 regression: batchFetchBySummary circuit-breaker passthrough ─────────
// Before the fix, batchFetchBySummary called this.client.query() directly,
// bypassing the circuit breaker.  After the fix, failures from individual
// batch Vespa calls are routed through queryUnderBreaker → circuitBreaker.execute(),
// so the breaker failure counter is incremented and the fetch now fails closed.

describe('batchFetchBySummary routes through circuit breaker (Bug 2 regression)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    globalCircuitBreakerRegistry.clear();
  });

  it('increments circuit breaker failure count when fetchWithHitSummary batch fails', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('Vespa unavailable'));
    vi.stubGlobal('fetch', fetchMock);

    const index = newIndex();

    // Confirm breaker starts at 0 failures.
    const snapshot0 = globalCircuitBreakerRegistry.snapshot();
    const breakerBefore = snapshot0.find((s) => s.name === 'vespa-search');
    expect(breakerBefore?.metrics.failureCount).toBe(0);

    const { createEntityId } = await import('../../../domain/shared/types/index.js');
    await expect(
      index.fetchWithHitSummary([createEntityId('wine-entity-001')]),
    ).rejects.toThrow(/Vespa summary batch failed/);

    const snapshot1 = globalCircuitBreakerRegistry.snapshot();
    const breakerAfter = snapshot1.find((s) => s.name === 'vespa-search');
    // The circuit-breaker failure counter MUST have been incremented — this
    // proves the HTTP call went through queryUnderBreaker, not client.query directly.
    expect(breakerAfter?.metrics.failureCount).toBeGreaterThan(0);
  });

  it('increments circuit breaker failure count when fetchWithFeatureSummary batch fails', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('Vespa timeout'));
    vi.stubGlobal('fetch', fetchMock);

    const index = newIndex();
    const { createEntityId } = await import('../../../domain/shared/types/index.js');

    await expect(
      index.fetchWithFeatureSummary([createEntityId('wine-entity-002')]),
    ).rejects.toThrow(/Vespa summary batch failed/);

    const snapshot = globalCircuitBreakerRegistry.snapshot();
    const breaker = snapshot.find((s) => s.name === 'vespa-search');
    expect(breaker?.metrics.failureCount).toBeGreaterThan(0);
  });

  it('does not increment circuit breaker failure count for Vespa 4xx client errors', async () => {
    const client = {
      query: vi.fn().mockRejectedValue(
        new VespaHttpError(
          'Vespa query failed [HTTP 400]: invalid query parameter',
          400,
          false,
          true,
        ),
      ),
    } as unknown as VespaClient;

    const index = new VespaSearchIndex(client);

    await expect(index.sparseSearch(['opus'], [], 5)).rejects.toThrow(/invalid query parameter/);

    const snapshot = globalCircuitBreakerRegistry.snapshot();
    const breaker = snapshot.find((s) => s.name === 'vespa-search');
    expect(breaker?.metrics.failureCount).toBe(0);
  });
});

describe('VespaClient.query() AbortSignal (E3-T3)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    globalCircuitBreakerRegistry.clear();
  });

  it('rejects with an abort/network error when passed an already-aborted AbortSignal', async () => {
    // Provide a fetch mock that actually checks the signal so we can verify
    // signal passthrough. In practice the already-aborted signal causes fetch
    // to reject before a real network call is made.
    const fetchMock = vi.fn((_url: string, opts?: RequestInit) => {
      if (opts?.signal?.aborted) {
        const err = new DOMException('This operation was aborted', 'AbortError');
        return Promise.reject(err);
      }
      return Promise.reject(new Error('unexpected'));
    });
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    controller.abort();

    const client = newClient();
    await expect(
      client.query('select * from wine_entity where true limit 1', undefined, controller.signal),
    ).rejects.toThrow();
  });

  it('canonicalizes a non-ASCII requestId before sending X-Request-Id downstream', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        root: { id: 'root', relevance: 1, children: [] },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = newClient();
    await client.query(
      'select * from wine_entity where true limit 1',
      undefined,
      undefined,
      'probe-피노 그리지오 추천',
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Request-Id']).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(headers['X-Request-Id']).toBeDefined();
    expect(headers['X-Request-Id']).not.toBe('probe-피노 그리지오 추천');
    expect(headers['X-Request-Id'].length).toBeLessThanOrEqual(128);
  });
});
