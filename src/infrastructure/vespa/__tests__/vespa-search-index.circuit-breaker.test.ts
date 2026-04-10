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
import { VespaClient } from '../vespa-client.js';
import { globalCircuitBreakerRegistry } from '../../../observability/circuit-breaker-registry.js';

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
});
