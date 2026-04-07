import { describe, expect, it } from 'vitest';
import { CacheService } from '../../domain/performance/index.js';
import {
  createFailingQueryCache,
  createMockPlan,
  createMockSnapshot,
} from './helpers/cache-service-test-helpers.js';

describe('CacheService circuit breaker integration', () => {
  it('does not open the circuit breaker before the configured threshold', async () => {
    const cacheServiceWithBreaker = new CacheService(createFailingQueryCache(), undefined, 2, 100);
    const result = await cacheServiceWithBreaker.getSearchResponse(
      createMockPlan(),
      {},
      createMockSnapshot(),
    );

    expect(result.reason).toContain('error:Persistent error');
  });

  it('opens circuit breaker after threshold errors', async () => {
    const cacheServiceWithBreaker = new CacheService(createFailingQueryCache(), undefined, 2, 100);
    const mockPlan = createMockPlan();
    const mockRequest = {};
    const mockSnapshot = createMockSnapshot();

    await cacheServiceWithBreaker.getSearchResponse(mockPlan, mockRequest, mockSnapshot);
    await cacheServiceWithBreaker.getSearchResponse(mockPlan, mockRequest, mockSnapshot);

    const result = await cacheServiceWithBreaker.getSearchResponse(
      mockPlan,
      mockRequest,
      mockSnapshot,
    );
    expect(result.reason).toBe('circuit_breaker_open');
  });
});
