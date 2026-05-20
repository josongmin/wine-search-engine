/**
 * E3-T1: Circuit-breaker registration test for OpenAiEmbeddingService.
 *
 * Verifies that on construction the 'openai-embedding' circuit breaker is
 * registered with the globalCircuitBreakerRegistry and that the breaker opens
 * after the configured number of consecutive service failures.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiEmbeddingService } from '../openai-embedding-service.js';
import { globalCircuitBreakerRegistry } from '../../../domain/observability/circuit-breaker-registry.js';
import { CircuitBreakerOpenError } from '../../../domain/shared/error/circuit-breaker-open-error.js';

function newService(): OpenAiEmbeddingService {
  return new OpenAiEmbeddingService({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    model: 'text-embedding-3-large',
    httpTimeoutMs: 60_000,
  });
}

function embeddingBody(values: readonly number[]): string {
  return JSON.stringify({
    data: [{ object: 'embedding', index: 0, embedding: values }],
  });
}

async function embedIgnoringError(svc: OpenAiEmbeddingService): Promise<unknown> {
  try {
    return await svc.embed('test');
  } catch (err) {
    return err;
  }
}

describe('OpenAiEmbeddingService circuit breaker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalCircuitBreakerRegistry.clear();
  });

  it('registers openai-embedding breaker with globalCircuitBreakerRegistry on construction', () => {
    newService();
    const snapshot = globalCircuitBreakerRegistry.snapshot();
    const names = snapshot.map((s) => s.name);
    expect(names).toContain('openai-embedding');
  });

  it('registers per-key embedding breakers for pooled credentials', () => {
    new OpenAiEmbeddingService({
      baseUrl: 'https://api.openai.com/v1',
      apiKeys: ['sk-a', 'sk-b'],
      model: 'text-embedding-3-large',
      httpTimeoutMs: 60_000,
    });

    const names = globalCircuitBreakerRegistry.snapshot().map((s) => s.name);
    expect(names).toContain('openai-embedding:key-1');
    expect(names).toContain('openai-embedding:key-2');
  });

  it('starts in CLOSED state', () => {
    newService();
    const snapshot = globalCircuitBreakerRegistry.snapshot();
    const breaker = snapshot.find((s) => s.name === 'openai-embedding');
    expect(breaker?.state).toBe('CLOSED');
  });

  it('rotates to the next pooled key on 429', async () => {
    const seenAuthorizations: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const authorization = (init?.headers as Record<string, string> | undefined)?.['Authorization'];
        if (authorization !== undefined) seenAuthorizations.push(authorization);
        if (seenAuthorizations.length === 1) {
          return new Response('rate limited', { status: 429 });
        }
        return new Response(embeddingBody([0.1, 0.2]), { status: 200 });
      }),
    );

    const svc = new OpenAiEmbeddingService({
      baseUrl: 'https://api.openai.com/v1',
      apiKeys: ['sk-a', 'sk-b'],
      model: 'text-embedding-3-large',
      httpTimeoutMs: 60_000,
      dimensions: 2,
    });

    const result = await svc.embed('test');

    expect(result).toEqual([0.1, 0.2]);
    expect(seenAuthorizations).toEqual(['Bearer sk-a', 'Bearer sk-b']);
  });

  it('opens after configured consecutive 5xx failures and fast-fails next call', async () => {
    // 500 responses resolve immediately (no timer needed for HTTP errors)
    const fetchMock = vi.fn(async () => new Response('internal error', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const svc = newService();

    // Trigger 3 failures (OPENAI_EMBEDDING_FAILURE_THRESHOLD = 3)
    for (let i = 0; i < 3; i++) {
      const err = await embedIgnoringError(svc);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CircuitBreakerOpenError);
    }

    // Next call should fast-fail with CircuitBreakerOpenError
    const callsBefore = fetchMock.mock.calls.length;
    const err = await embedIgnoringError(svc);
    expect(err).toBeInstanceOf(CircuitBreakerOpenError);
    // No additional fetch call when breaker is open
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it('does NOT open on 4xx (non-429) errors — caller fault, not service degradation', async () => {
    const fetchMock = vi.fn(async () => new Response('bad request', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const svc = newService();

    for (let i = 0; i < 10; i++) {
      const err = await embedIgnoringError(svc);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CircuitBreakerOpenError);
    }
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(10);
  });
});
