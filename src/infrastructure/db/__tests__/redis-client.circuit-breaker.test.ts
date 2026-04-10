/**
 * E3-T4: Circuit-breaker registration test for Redis client wrapper.
 *
 * Verifies that the RedisCircuitBreakerWrapper registers 'redis' breaker
 * with globalCircuitBreakerRegistry on construction, and degrades gracefully
 * (returns null / cache-miss) when the breaker is open.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { RedisCircuitBreakerWrapper } from '../redis-circuit-breaker-wrapper.js';
import { globalCircuitBreakerRegistry } from '../../../observability/circuit-breaker-registry.js';

function makeFakeClient(overrides: Partial<{
  get: () => Promise<string | null>;
  set: () => Promise<unknown>;
  del: () => Promise<unknown>;
  ping: () => Promise<string>;
}> = {}): Parameters<typeof RedisCircuitBreakerWrapper>[0] {
  return {
    get: overrides.get ?? (async () => null),
    set: overrides.set ?? (async () => 'OK'),
    del: overrides.del ?? (async () => 1),
    ping: overrides.ping ?? (async () => 'PONG'),
  } as any;
}

describe('RedisCircuitBreakerWrapper (E3-T4)', () => {
  afterEach(() => {
    globalCircuitBreakerRegistry.clear();
  });

  it('registers redis breaker with globalCircuitBreakerRegistry on construction', () => {
    new RedisCircuitBreakerWrapper(makeFakeClient());
    const snapshot = globalCircuitBreakerRegistry.snapshot();
    const names = snapshot.map((s) => s.name);
    expect(names).toContain('redis');
  });

  it('starts in CLOSED state', () => {
    new RedisCircuitBreakerWrapper(makeFakeClient());
    const snapshot = globalCircuitBreakerRegistry.snapshot();
    const breaker = snapshot.find((s) => s.name === 'redis');
    expect(breaker?.state).toBe('CLOSED');
  });

  it('returns null (cache miss) when the breaker is open (graceful degrade)', async () => {
    const wrapper = new RedisCircuitBreakerWrapper(makeFakeClient());
    wrapper.forceOpen();
    const result = await wrapper.get('some-key');
    expect(result).toBeNull();
  });

  it('returns null (cache miss) on get when the underlying redis throws', async () => {
    const fakeClient = makeFakeClient({
      get: async () => { throw new Error('ECONNREFUSED'); },
    });
    const wrapper = new RedisCircuitBreakerWrapper(fakeClient);
    const result = await wrapper.get('key');
    expect(result).toBeNull();
  });
});
