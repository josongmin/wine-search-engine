import { describe, expect, it } from 'vitest';
import { CacheService } from '../../domain/performance/index.js';
import {
  createFailingQueryCache,
  createMockCompiledQuery,
  createMockPlan,
  createMockSnapshot,
} from './helpers/cache-service-test-helpers.js';

describe('CacheService circuit breaker integration', () => {
  it('does not open the circuit breaker before the configured threshold', async () => {
    const cacheServiceWithBreaker = new CacheService(createFailingQueryCache(), undefined, 2, 100);
    const compiled = createMockCompiledQuery();
    const result = await cacheServiceWithBreaker.getSearchResponse(
      createMockPlan(),
      {},
      createMockSnapshot(),
      undefined,
      compiled,
    );

    expect(result.kind).toBe('infra_error');
    if (result.kind === 'infra_error') {
      expect(result.message).toContain('Persistent error');
    }
  });

  it('opens circuit breaker after threshold errors', async () => {
    const cacheServiceWithBreaker = new CacheService(createFailingQueryCache(), undefined, 2, 100);
    const mockPlan = createMockPlan();
    const mockRequest = {};
    const mockSnapshot = createMockSnapshot();
    const compiled = createMockCompiledQuery();

    await cacheServiceWithBreaker.getSearchResponse(mockPlan, mockRequest, mockSnapshot, undefined, compiled);
    await cacheServiceWithBreaker.getSearchResponse(mockPlan, mockRequest, mockSnapshot, undefined, compiled);

    const result = await cacheServiceWithBreaker.getSearchResponse(
      mockPlan,
      mockRequest,
      mockSnapshot,
      undefined,
      compiled,
    );
    expect(result.kind).toBe('breaker_open');
  });
});
