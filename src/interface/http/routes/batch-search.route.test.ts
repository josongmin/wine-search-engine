import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../../../config/container.js';
import { registerBatchSearchRoute } from './batch-search.route.js';
import type { BatchSearchResponse } from '../../../application/search/batch-search.usecase.js';
import type { SearchResponseV1 } from '../../../domain/response/model/search-response.js';
import type { BatchSearchUseCase } from '../../../application/search/batch-search.usecase.js';

/**
 * Integration tests for the batch search HTTP route.
 *
 * Coverage:
 * - HTTP 207 Multi-Status response (regardless of partial failures)
 * - Valid request validation and error handling
 * - Invalid request rejection (400 Bad Request)
 * - Batch ID propagation
 * - Request body parsing
 * - Error response structure
 */
describe('POST /v1/batch-search', () => {
  let app: FastifyInstance;
  let mockBatchSearchUseCase: BatchSearchUseCase;
  let mockContainer: Container;

  beforeEach(async () => {
    app = Fastify();

    mockBatchSearchUseCase = {
      execute: vi.fn(),
    } as unknown as BatchSearchUseCase;

    mockContainer = {
      batchSearchUseCase: mockBatchSearchUseCase,
    } as unknown as Container;

    registerBatchSearchRoute(app, mockContainer);
  });

  describe('HTTP 207 Multi-Status', () => {
    it('should return 207 when all requests succeed', async () => {
      const mockResponse: SearchResponseV1 = {
        queryType: 'search',
        engineDecision: { status: 'resolved', confidence: 0.95 } as any,
        results: [],
        meta: { requestId: 'req1', queryTimeMs: 100 } as any,
      };

      const batchResponse: BatchSearchResponse = {
        batch_id: 'batch-123',
        total: 1,
        succeeded: 1,
        failed: 0,
        results: [
          {
            id: '1',
            status: 'succeeded',
            response: mockResponse,
          },
        ],
        processing_time_ms: 100,
      };

      vi.mocked(mockBatchSearchUseCase.execute).mockResolvedValue(
        batchResponse,
      );

      const response = await app.inject({
        method: 'POST',
        url: '/v1/batch-search',
        payload: {
          requests: [{ id: '1', query: 'Test' }],
        },
      });

      expect(response.statusCode).toBe(207);
    });

    it('should return 207 when requests partially fail', async () => {
      const batchResponse: BatchSearchResponse = {
        batch_id: 'batch-123',
        total: 2,
        succeeded: 1,
        failed: 1,
        results: [
          {
            id: '1',
            status: 'succeeded',
            response: {} as SearchResponseV1,
          },
          {
            id: '2',
            status: 'failed',
            error: {
              code: 'RETRIEVAL_TIMEOUT',
              message: 'Request exceeded timeout',
            },
          },
        ],
        processing_time_ms: 5100,
      };

      vi.mocked(mockBatchSearchUseCase.execute).mockResolvedValue(
        batchResponse,
      );

      const response = await app.inject({
        method: 'POST',
        url: '/v1/batch-search',
        payload: {
          requests: [
            { id: '1', query: 'Query 1' },
            { id: '2', query: 'Query 2' },
          ],
        },
      });

      expect(response.statusCode).toBe(207);
      const body = JSON.parse(response.body);
      expect(body.succeeded).toBe(1);
      expect(body.failed).toBe(1);
    });

    it('should return 207 when all requests fail', async () => {
      const batchResponse: BatchSearchResponse = {
        batch_id: 'batch-123',
        total: 1,
        succeeded: 0,
        failed: 1,
        results: [
          {
            id: '1',
            status: 'failed',
            error: {
              code: 'INTERNAL_ERROR',
              message: 'Internal server error',
            },
          },
        ],
        processing_time_ms: 50,
      };

      vi.mocked(mockBatchSearchUseCase.execute).mockResolvedValue(
        batchResponse,
      );

      const response = await app.inject({
        method: 'POST',
        url: '/v1/batch-search',
        payload: {
          requests: [{ id: '1', query: 'Bad query' }],
        },
      });

      expect(response.statusCode).toBe(207);
    });
  });

  describe('Request validation', () => {
    it('should accept valid batch request', async () => {
      const batchResponse: BatchSearchResponse = {
        batch_id: 'batch-123',
        total: 1,
        succeeded: 1,
        failed: 0,
        results: [
          {
            id: '1',
            status: 'succeeded',
            response: {} as SearchResponseV1,
          },
        ],
        processing_time_ms: 100,
      };

      vi.mocked(mockBatchSearchUseCase.execute).mockResolvedValue(
        batchResponse,
      );

      const response = await app.inject({
        method: 'POST',
        url: '/v1/batch-search',
        payload: {
          requests: [
            {
              id: 'q1',
              query: 'Cabernet 2015',
              limit: 10,
              retrieval_mode: 'hybrid',
            },
          ],
          options: {
            fail_fast: false,
            timeout_ms: 5000,
          },
          batch_id: 'my-batch',
        },
      });

      expect(response.statusCode).toBe(207);
    });

    it('should reject empty requests array', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/batch-search',
        payload: {
          requests: [],
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject oversized batch (21+ items)', async () => {
      const requests = Array.from({ length: 21 }, (_, i) => ({
        id: String(i + 1),
        query: `Query ${i + 1}`,
      }));

      const response = await app.inject({
        method: 'POST',
        url: '/v1/batch-search',
        payload: { requests },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject request with missing query', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/batch-search',
        payload: {
          requests: [{ id: '1' }], // Missing query
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject request with missing id', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/batch-search',
        payload: {
          requests: [{ query: 'Test' }], // Missing id
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject query exceeding max length (2000)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/batch-search',
        payload: {
          requests: [
            {
              id: '1',
              query: 'x'.repeat(2001),
            },
          ],
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject timeout_ms below minimum (1000)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/batch-search',
        payload: {
          requests: [{ id: '1', query: 'Test' }],
          options: { timeout_ms: 500 },
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject timeout_ms above maximum (30000)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/batch-search',
        payload: {
          requests: [{ id: '1', query: 'Test' }],
          options: { timeout_ms: 40000 },
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject invalid retrieval_mode', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/batch-search',
        payload: {
          requests: [
            {
              id: '1',
              query: 'Test',
              retrieval_mode: 'invalid_mode',
            },
          ],
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('Response structure', () => {
    it('should return batch response with all required fields', async () => {
      const batchResponse: BatchSearchResponse = {
        batch_id: 'batch-abc',
        total: 1,
        succeeded: 1,
        failed: 0,
        results: [
          {
            id: '1',
            status: 'succeeded',
            response: {
              queryType: 'search',
              engineDecision: { status: 'resolved' } as any,
              results: [],
              meta: { requestId: 'req1', queryTimeMs: 50 } as any,
            },
          },
        ],
        processing_time_ms: 52,
      };

      vi.mocked(mockBatchSearchUseCase.execute).mockResolvedValue(
        batchResponse,
      );

      const response = await app.inject({
        method: 'POST',
        url: '/v1/batch-search',
        payload: {
          requests: [{ id: '1', query: 'Test' }],
        },
      });

      const body = JSON.parse(response.body);

      expect(body).toMatchObject({
        batch_id: 'batch-abc',
        total: 1,
        succeeded: 1,
        failed: 0,
        processing_time_ms: expect.any(Number),
        results: expect.any(Array),
      });
    });

    it('should include error details in failed results', async () => {
      const batchResponse: BatchSearchResponse = {
        batch_id: 'batch-123',
        total: 1,
        succeeded: 0,
        failed: 1,
        results: [
          {
            id: '1',
            status: 'failed',
            error: {
              code: 'POLICY_BLOCKED',
              message: 'Query blocked by policy',
            },
          },
        ],
        processing_time_ms: 10,
      };

      vi.mocked(mockBatchSearchUseCase.execute).mockResolvedValue(
        batchResponse,
      );

      const response = await app.inject({
        method: 'POST',
        url: '/v1/batch-search',
        payload: {
          requests: [{ id: '1', query: 'Blocked' }],
        },
      });

      const body = JSON.parse(response.body);
      const failedResult = body.results[0];

      expect(failedResult.status).toBe('failed');
      expect(failedResult.error).toMatchObject({
        code: 'POLICY_BLOCKED',
        message: 'Query blocked by policy',
      });
    });
  });

  describe('Batch ID handling', () => {
    it('should pass batch_id to use case when provided', async () => {
      const batchResponse: BatchSearchResponse = {
        batch_id: 'my-batch-123',
        total: 1,
        succeeded: 1,
        failed: 0,
        results: [
          {
            id: '1',
            status: 'succeeded',
            response: {} as SearchResponseV1,
          },
        ],
        processing_time_ms: 50,
      };

      vi.mocked(mockBatchSearchUseCase.execute).mockResolvedValue(
        batchResponse,
      );

      await app.inject({
        method: 'POST',
        url: '/v1/batch-search',
        payload: {
          requests: [{ id: '1', query: 'Test' }],
          batch_id: 'my-batch-123',
        },
      });

      expect(mockContainer.batchSearchUseCase?.execute).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(Object),
        'my-batch-123',
      );
    });

    it('should pass undefined batch_id when not provided', async () => {
      const batchResponse: BatchSearchResponse = {
        batch_id: 'batch_12345_abc123',
        total: 1,
        succeeded: 1,
        failed: 0,
        results: [
          {
            id: '1',
            status: 'succeeded',
            response: {} as SearchResponseV1,
          },
        ],
        processing_time_ms: 50,
      };

      vi.mocked(mockBatchSearchUseCase.execute).mockResolvedValue(
        batchResponse,
      );

      await app.inject({
        method: 'POST',
        url: '/v1/batch-search',
        payload: {
          requests: [{ id: '1', query: 'Test' }],
        },
      });

      expect(mockContainer.batchSearchUseCase?.execute).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(Object),
        undefined,
      );
    });
  });

  describe('Options propagation', () => {
    it('should pass fail_fast and timeout_ms to use case', async () => {
      const batchResponse: BatchSearchResponse = {
        batch_id: 'batch-123',
        total: 1,
        succeeded: 1,
        failed: 0,
        results: [
          {
            id: '1',
            status: 'succeeded',
            response: {} as SearchResponseV1,
          },
        ],
        processing_time_ms: 100,
      };

      vi.mocked(mockBatchSearchUseCase.execute).mockResolvedValue(
        batchResponse,
      );

      await app.inject({
        method: 'POST',
        url: '/v1/batch-search',
        payload: {
          requests: [{ id: '1', query: 'Test' }],
          options: {
            fail_fast: true,
            timeout_ms: 10000,
          },
        },
      });

      expect(mockContainer.batchSearchUseCase?.execute).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          fail_fast: true,
          timeout_ms: 10000,
        }),
        undefined,
      );
    });
  });
});
