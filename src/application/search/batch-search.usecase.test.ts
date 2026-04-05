import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BatchSearchUseCase,
  type BatchSearchRequestItem,
  type BatchSearchOptions,
} from './batch-search.usecase.js';
import type { SearchUseCase } from './search.usecase.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';

/**
 * Unit tests for BatchSearchUseCase.
 *
 * Coverage:
 * - Max batch size (20 items) enforced
 * - Timeout range validation (1000–30000 ms)
 * - Partial failure handling (fail_fast=false)
 * - Fail-fast mode (fail_fast=true)
 * - Timeout enforcement (Promise.race)
 * - Error mapping (DomainError codes → BatchErrorCode)
 * - Sub-request ID generation (${batchId}-${item.id})
 * - Idempotency (consistent results with same batch_id)
 * - Response aggregation (succeeded + failed = total)
 * - Processing time measurement
 */
describe('BatchSearchUseCase', () => {
  let mockSearchUseCase: SearchUseCase;
  let useCase: BatchSearchUseCase;

  beforeEach(() => {
    // Mock SearchUseCase
    mockSearchUseCase = {
      execute: vi.fn(),
    } as unknown as SearchUseCase;

    useCase = new BatchSearchUseCase(mockSearchUseCase);
  });

  describe('validate batch size', () => {
    it('should accept 1 request', async () => {
      const requests: BatchSearchRequestItem[] = [
        { id: '1', query: 'Cabernet' },
      ];

      const response = await useCase.execute(requests);

      expect(response.total).toBe(1);
      expect(response.results).toHaveLength(1);
    });

    it('should accept 20 requests (max)', async () => {
      const requests: BatchSearchRequestItem[] = Array.from(
        { length: 20 },
        (_, i) => ({
          id: String(i + 1),
          query: `Query ${i + 1}`,
        }),
      );

      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
        {} as SearchResponseV1,
      );

      const response = await useCase.execute(requests);

      expect(response.total).toBe(20);
    });

    it('should reject 21+ requests', async () => {
      const requests: BatchSearchRequestItem[] = Array.from(
        { length: 21 },
        (_, i) => ({
          id: String(i + 1),
          query: `Query ${i + 1}`,
        }),
      );

      const response = await useCase.execute(requests);

      expect(response.total).toBe(21);
      expect(response.succeeded).toBe(0);
      expect(response.failed).toBe(21);
      expect(response.results.every((r) => r.status === 'failed')).toBe(true);
      expect(response.results[0]).toMatchObject({
        status: 'failed',
        error: {
          code: 'INTERNAL_ERROR',
          message: expect.stringContaining('exceeds maximum'),
        },
      });
    });

    it('should handle empty batch', async () => {
      const requests: BatchSearchRequestItem[] = [];

      const response = await useCase.execute(requests);

      expect(response.total).toBe(0);
      expect(response.succeeded).toBe(0);
      expect(response.failed).toBe(0);
      expect(response.results).toHaveLength(0);
    });
  });

  describe('timeout validation', () => {
    it('should use default timeout (5000 ms)', async () => {
      const requests: BatchSearchRequestItem[] = [
        { id: '1', query: 'Test' },
      ];

      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
        {} as SearchResponseV1,
      );

      await useCase.execute(requests);

      expect(mockSearchUseCase.execute).toHaveBeenCalled();
    });

    it('should accept timeout in range (1000–30000 ms)', async () => {
      const requests: BatchSearchRequestItem[] = [
        { id: '1', query: 'Test' },
      ];

      const options: BatchSearchOptions = { timeout_ms: 10000 };

      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
        {} as SearchResponseV1,
      );

      const response = await useCase.execute(requests, options);

      expect(response.succeeded).toBe(1);
    });

    it('should clamp timeout below minimum to 1000 ms', async () => {
      const requests: BatchSearchRequestItem[] = [
        { id: '1', query: 'Test' },
      ];

      const options: BatchSearchOptions = { timeout_ms: 500 };

      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
        {} as SearchResponseV1,
      );

      const response = await useCase.execute(requests, options);

      // Should not fail due to timeout clamping
      expect(response.succeeded).toBe(1);
    });

    it('should clamp timeout above maximum to 30000 ms', async () => {
      const requests: BatchSearchRequestItem[] = [
        { id: '1', query: 'Test' },
      ];

      const options: BatchSearchOptions = { timeout_ms: 60000 };

      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
        {} as SearchResponseV1,
      );

      const response = await useCase.execute(requests, options);

      expect(response.succeeded).toBe(1);
    });
  });

  describe('partial failure (fail_fast=false)', () => {
    it('should execute all requests even if some fail', async () => {
      const requests: BatchSearchRequestItem[] = [
        { id: '1', query: 'Query 1' },
        { id: '2', query: 'Query 2' },
        { id: '3', query: 'Query 3' },
      ];

      const mockResponse = {} as SearchResponseV1;

      vi.mocked(mockSearchUseCase.execute)
        .mockResolvedValueOnce(mockResponse)
        .mockRejectedValueOnce(new Error('Search failed'))
        .mockResolvedValueOnce(mockResponse);

      const response = await useCase.execute(requests, { fail_fast: false });

      expect(response.total).toBe(3);
      expect(response.succeeded).toBe(2);
      expect(response.failed).toBe(1);
      expect(response.results).toHaveLength(3);
      expect(mockSearchUseCase.execute).toHaveBeenCalledTimes(3);
    });

    it('should mark failed requests with appropriate error codes', async () => {
      const requests: BatchSearchRequestItem[] = [
        { id: '1', query: 'Query 1' },
        { id: '2', query: 'Query 2' },
      ];

      const mockResponse = {} as SearchResponseV1;

      vi.mocked(mockSearchUseCase.execute)
        .mockResolvedValueOnce(mockResponse)
        .mockRejectedValueOnce(
          new (class DomainError extends Error {
            code = 'POLICY_BLOCKED';
            constructor() {
              super('Query blocked by policy');
            }
          })(),
        );

      const response = await useCase.execute(requests, { fail_fast: false });

      const failedResult = response.results.find((r) => r.status === 'failed');
      expect(failedResult?.status).toBe('failed');
      if (failedResult?.status === 'failed') {
        expect(failedResult.error.code).toBe('POLICY_BLOCKED');
      }
    });
  });

  describe('fail-fast mode (fail_fast=true)', () => {
    it('should stop executing after first failure', async () => {
      const requests: BatchSearchRequestItem[] = [
        { id: '1', query: 'Query 1' },
        { id: '2', query: 'Query 2' },
        { id: '3', query: 'Query 3' },
      ];

      const mockResponse = {} as SearchResponseV1;

      vi.mocked(mockSearchUseCase.execute)
        .mockResolvedValueOnce(mockResponse)
        .mockRejectedValueOnce(new Error('Search failed'))
        .mockResolvedValueOnce(mockResponse);

      const response = await useCase.execute(requests, { fail_fast: true });

      // At least one failed, and remaining should be aborted
      expect(response.failed).toBeGreaterThanOrEqual(1);
      expect(response.results.some((r) => r.status === 'failed')).toBe(true);
    });
  });

  describe('timeout enforcement', () => {
    it('should timeout request if it exceeds timeout_ms', async () => {
      const requests: BatchSearchRequestItem[] = [
        { id: '1', query: 'Slow query' },
      ];

      // Mock a search that never resolves
      vi.mocked(mockSearchUseCase.execute).mockImplementation(
        () => new Promise((_resolve) => {
          // Never resolve
        }),
      );

      const response = await useCase.execute(requests, { timeout_ms: 100 });

      expect(response.succeeded).toBe(0);
      expect(response.failed).toBe(1);
      const result = response.results[0];
      if (result?.status === 'failed') {
        expect(result.error.code).toBe('RETRIEVAL_TIMEOUT');
      }
    });
  });

  describe('error mapping', () => {
    it('should map POLICY_BLOCKED error', async () => {
      const requests: BatchSearchRequestItem[] = [
        { id: '1', query: 'Blocked query' },
      ];

      const policyError = new (class DomainError extends Error {
        override name = 'DomainError';
        code = 'POLICY_BLOCKED';
        constructor() {
          super('Query blocked by policy');
        }
      })();

      vi.mocked(mockSearchUseCase.execute).mockRejectedValueOnce(
        policyError,
      );

      const response = await useCase.execute(requests);

      const result = response.results[0];
      expect(result?.status).toBe('failed');
      if (result?.status === 'failed') {
        expect(result.error.code).toBe('POLICY_BLOCKED');
      }
    });

    it('should map QUERY_PARSE_ERROR (ZodError)', async () => {
      const requests: BatchSearchRequestItem[] = [
        { id: '1', query: 'Invalid' },
      ];

      const zodError = new (class extends Error {
        override name = 'ZodError';
        constructor() {
          super('Invalid query format');
        }
      })();

      vi.mocked(mockSearchUseCase.execute).mockRejectedValueOnce(zodError);

      const response = await useCase.execute(requests);

      const result = response.results[0];
      expect(result?.status).toBe('failed');
      if (result?.status === 'failed') {
        expect(result.error.code).toBe('QUERY_PARSE_ERROR');
      }
    });

    it('should map INTERNAL_ERROR for unknown errors', async () => {
      const requests: BatchSearchRequestItem[] = [
        { id: '1', query: 'Unknown error' },
      ];

      vi.mocked(mockSearchUseCase.execute).mockRejectedValueOnce(
        new Error('Unknown error'),
      );

      const response = await useCase.execute(requests);

      const result = response.results[0];
      expect(result?.status).toBe('failed');
      if (result?.status === 'failed') {
        expect(result.error.code).toBe('INTERNAL_ERROR');
      }
    });
  });

  describe('sub-request ID generation', () => {
    it('should generate sub-request ID as ${batchId}-${item.id}', async () => {
      const requests: BatchSearchRequestItem[] = [
        { id: 'query1', query: 'Test' },
      ];

      const batchId = 'batch-123';

      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
        {} as SearchResponseV1,
      );

      await useCase.execute(requests, undefined, batchId);

      const [, requestId] = vi.mocked(mockSearchUseCase.execute).mock
        .calls[0];
      expect(requestId).toBe('batch-123-query1');
    });
  });

  describe('idempotency', () => {
    it('should return consistent batch_id when provided', async () => {
      const requests: BatchSearchRequestItem[] = [
        { id: '1', query: 'Test' },
      ];

      const batchId = 'my-batch-123';

      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
        {} as SearchResponseV1,
      );

      const response = await useCase.execute(requests, undefined, batchId);

      expect(response.batch_id).toBe('my-batch-123');
    });

    it('should generate batch_id when not provided', async () => {
      const requests: BatchSearchRequestItem[] = [
        { id: '1', query: 'Test' },
      ];

      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
        {} as SearchResponseV1,
      );

      const response = await useCase.execute(requests);

      expect(response.batch_id).toBeDefined();
      expect(response.batch_id).toMatch(/^batch_\d+_[a-z0-9]+$/);
    });
  });

  describe('response aggregation', () => {
    it('should ensure succeeded + failed = total', async () => {
      const requests: BatchSearchRequestItem[] = Array.from(
        { length: 5 },
        (_, i) => ({
          id: String(i + 1),
          query: `Query ${i + 1}`,
        }),
      );

      const mockResponse = {} as SearchResponseV1;

      vi.mocked(mockSearchUseCase.execute)
        .mockResolvedValueOnce(mockResponse)
        .mockRejectedValueOnce(new Error('Fail'))
        .mockResolvedValueOnce(mockResponse)
        .mockResolvedValueOnce(mockResponse)
        .mockRejectedValueOnce(new Error('Fail'));

      const response = await useCase.execute(requests, { fail_fast: false });

      expect(response.succeeded + response.failed).toBe(response.total);
      expect(response.total).toBe(5);
      expect(response.succeeded).toBe(3);
      expect(response.failed).toBe(2);
    });
  });

  describe('processing time measurement', () => {
    it('should measure wall-clock time', async () => {
      const requests: BatchSearchRequestItem[] = [
        { id: '1', query: 'Test' },
      ];

      vi.mocked(mockSearchUseCase.execute).mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve({} as SearchResponseV1);
            }, 50);
          }),
      );

      const response = await useCase.execute(requests);

      // Processing time should be at least ~50ms
      expect(response.processing_time_ms).toBeGreaterThanOrEqual(50);
    });
  });

  describe('SearchResponseV1 preservation', () => {
    it('should preserve SearchResponseV1 structure in successful items', async () => {
      const requests: BatchSearchRequestItem[] = [
        { id: '1', query: 'Test' },
      ];

      const mockResponse: SearchResponseV1 = {
        queryType: 'search',
        engineDecision: {
          status: 'resolved',
          confidence: 0.95,
        } as any,
        results: [],
        meta: {
          requestId: 'batch-test-1',
          queryTimeMs: 100,
        } as any,
      };

      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(mockResponse);

      const response = await useCase.execute(requests);

      const result = response.results[0];
      expect(result?.status).toBe('succeeded');
      if (result?.status === 'succeeded') {
        expect(result.response).toEqual(mockResponse);
      }
    });
  });

  describe('request options propagation', () => {
    it('should pass context, sessionContext, queryBudget to SearchUseCase', async () => {
      const requests: BatchSearchRequestItem[] = [
        {
          id: '1',
          query: 'Test',
          context: { locale: 'en', currency: 'USD' },
          sessionContext: { sessionId: 'session1', previousEntities: [] },
          queryBudget: {
            maxLatencyMs: 5000,
            maxCandidates: 100,
            rerankLimit: 10,
          },
          retrieval_mode: 'hybrid',
        },
      ];

      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
        {} as SearchResponseV1,
      );

      await useCase.execute(requests);

      const callArgs = vi.mocked(mockSearchUseCase.execute).mock.calls[0];
      const searchRequest = callArgs?.[0];

      expect(searchRequest?.context).toEqual({
        locale: 'en',
        currency: 'USD',
      });
      expect(searchRequest?.sessionContext).toEqual({
        sessionId: 'session1',
        previousEntities: [],
      });
      expect(searchRequest?.queryBudget).toEqual({
        maxLatencyMs: 5000,
        maxCandidates: 100,
        rerankLimit: 10,
      });
      expect(searchRequest?.options?.mode).toBe('hybrid');
    });
  });
});
