import { afterAll, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerBatchSearchRoute } from '../../../../src/interface/http/routes/batch-search.route.js';
import type { BatchSearchRouteDeps } from '../../../../src/interface/http/routes/route-deps.js';
import type { BatchSearchResponse } from '../../../../src/application/search/batch-search.usecase.js';
import type { BatchSearchUseCase } from '../../../../src/application/search/batch-search.usecase.js';
import { errorHandler } from '../../../../src/interface/http/middleware/error-handler.js';

/**
 * Integration tests for the batch search HTTP route.
 *
 * Coverage:
 * - HTTP 200 OK response with batch_status summary
 * - Valid request validation and error handling
 * - Invalid request rejection (400 Bad Request)
 * - Batch ID propagation
 * - Request body parsing
 * - Error response structure
 */

function makeSearchResponse(overrides: Record<string, unknown> = {}) {
  return {
    query_type: 'search',
    engine_decision: {
      decision_status: 'resolved',
      next_action: 'return_result',
      route: 'hybrid',
      decision_confidence: 0.95,
      confidence_semantics: 'calibrated_decision_confidence',
      decision_trace_ref: 'trace-1',
      decision_snapshot: {
        snapshot_id: 'snap-1',
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1',
        threshold_profile_id: 'default',
        planner_version: '1',
        feature_flags: {},
        response_contract_version: 'search_response_v1',
      },
    },
    results: [],
    clarification: null,
    meta: {
      request_id: 'req-1',
      query_time_ms: 100,
      route: 'hybrid',
      version: '1.0.0',
      engine_schema_version: 'search_response_v1',
      decision_snapshot: {
        snapshot_id: 'snap-1',
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1',
        threshold_profile_id: 'default',
        planner_version: '1',
        feature_flags: {},
        response_contract_version: 'search_response_v1',
      },
      response_hash: 'abc123',
    },
    ...overrides,
  };
}

describe('POST /v1/batch-search', () => {
  let app: FastifyInstance;
  let mockBatchSearchUseCase: BatchSearchUseCase;
  let mockDeps: BatchSearchRouteDeps;

  beforeAll(async () => {
    app = Fastify();

    mockBatchSearchUseCase = {
      execute: vi.fn(),
    } as unknown as BatchSearchUseCase;

    mockDeps = {
      batchSearchUseCase: mockBatchSearchUseCase,
    };

    // Register error handler to properly handle Zod validation errors
    app.setErrorHandler(errorHandler);

    registerBatchSearchRoute(app, mockDeps);
  });

  beforeEach(() => {
    vi.mocked(mockBatchSearchUseCase.execute).mockReset();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('HTTP 200 OK', () => {
    it('should return 200 when all requests succeed', async () => {
      const mockResponse = makeSearchResponse();

      const batchResponse: BatchSearchResponse = {
        batch_id: 'batch-123',
        total: 1,
        succeeded: 1,
        failed: 0,
        not_executed: 0,
        batch_status: 'succeeded',
        has_failures: false,
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

      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.batch_id).toBe('batch-123');
      expect(body.total).toBe(1);
      expect(body.succeeded).toBe(1);
      expect(body.failed).toBe(0);
      expect(body.batch_status).toBe('succeeded');
      expect(body.has_failures).toBe(false);
      expect(body.results).toHaveLength(1);
      expect(body.results[0]).toMatchObject({
        id: '1',
        status: 'succeeded',
      });
      expect(body.results[0].response).toBeDefined();
    });

    it('should return 200 when requests partially fail', async () => {
      const batchResponse: BatchSearchResponse = {
        batch_id: 'batch-123',
        total: 2,
        succeeded: 1,
        failed: 1,
        not_executed: 0,
        batch_status: 'partial_failure',
        has_failures: true,
        results: [
          {
            id: '1',
            status: 'succeeded',
            response: makeSearchResponse(),
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

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.succeeded).toBe(1);
      expect(body.failed).toBe(1);
      expect(body.batch_status).toBe('partial_failure');
      expect(body.has_failures).toBe(true);
    });

    it('should return 200 when all requests fail', async () => {
      const batchResponse: BatchSearchResponse = {
        batch_id: 'batch-123',
        total: 1,
        succeeded: 0,
        failed: 1,
        not_executed: 0,
        batch_status: 'failed',
        has_failures: true,
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

      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.total).toBe(1);
      expect(body.succeeded).toBe(0);
      expect(body.failed).toBe(1);
      expect(body.batch_status).toBe('failed');
      expect(body.has_failures).toBe(true);
      expect(body.results).toHaveLength(1);
      expect(body.results[0]).toMatchObject({
        id: '1',
        status: 'failed',
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
        },
      });
    });
  });

  describe('Request validation', () => {
    it('should accept valid batch request', async () => {
      const batchResponse: BatchSearchResponse = {
        batch_id: 'batch-123',
        total: 1,
        succeeded: 1,
        failed: 0,
        not_executed: 0,
        batch_status: 'succeeded',
        has_failures: false,
        results: [
          {
            id: '1',
            status: 'succeeded',
            response: makeSearchResponse(),
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

      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.results).toHaveLength(1);
      expect(body.results[0].status).toBe('succeeded');
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

    it('should reject query exceeding max length (500)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/batch-search',
        payload: {
          requests: [
            {
              id: '1',
              query: 'x'.repeat(501),
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
        not_executed: 0,
        results: [
          {
            id: '1',
            status: 'succeeded',
            response: {
              ...makeSearchResponse(),
              meta: {
                ...makeSearchResponse().meta,
                query_time_ms: 50,
              },
            },
          },
        ],
        batch_status: 'succeeded',
        has_failures: false,
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
        not_executed: 0,
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
        batch_status: 'failed',
        has_failures: true,
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
        not_executed: 0,
        batch_status: 'succeeded',
        has_failures: false,
        results: [
          {
            id: '1',
            status: 'succeeded',
            response: makeSearchResponse(),
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

      expect(mockBatchSearchUseCase.execute).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: '1', query: 'Test' }),
        ]),
        undefined,
        'my-batch-123',
      );
    });

    it('should pass undefined batch_id when not provided', async () => {
      const batchResponse: BatchSearchResponse = {
        batch_id: 'batch_12345_abc123',
        total: 1,
        succeeded: 1,
        failed: 0,
        not_executed: 0,
        batch_status: 'succeeded',
        has_failures: false,
        results: [
          {
            id: '1',
            status: 'succeeded',
            response: makeSearchResponse(),
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

      expect(mockBatchSearchUseCase.execute).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: '1', query: 'Test' }),
        ]),
        undefined,
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
            response: makeSearchResponse(),
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

      expect(mockBatchSearchUseCase.execute).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: '1', query: 'Test' }),
        ]),
        expect.objectContaining({
          fail_fast: true,
          timeout_ms: 10000,
        }),
        undefined,
      );
    });
  });
});
