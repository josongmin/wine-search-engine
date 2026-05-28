import { afterAll, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerBatchSearchRoute } from '../../../../src/interface/http/routes/batch-search.route.js';
import type { BatchSearchRouteDeps } from '../../../../src/interface/http/routes/route-deps.js';
import type { BatchSearchResponse } from '../../../../src/application/search/batch-search.dto.js';
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

/** Matches SearchResponseSchema / EngineDecisionSchema canonical trace ref regex. */
const CANONICAL_HYBRID_TRACE_REF =
  'decision:v1:hybrid:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function makeSearchResponse(overrides: Record<string, unknown> = {}) {
  return {
    query_type: 'search',
    engine_decision: {
      decision_status: 'resolved',
      next_action: 'return_result',
      route: 'hybrid',
      decision_confidence: 0.95,
      confidence_semantics: 'calibrated_decision_confidence',
      decision_trace_ref: CANONICAL_HYBRID_TRACE_REF,
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

function makeBatchRequestItem(overrides: Record<string, unknown> = {}) {
  return {
    id: '1',
    query: 'Test',
    ...overrides,
  };
}

function makeBatchResponse(
  overrides: Partial<BatchSearchResponse> = {},
): BatchSearchResponse {
  return {
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
    ...overrides,
  };
}

function parseBody(response: { body: string }) {
  return JSON.parse(response.body) as unknown as Record<string, unknown>;
}

function injectBatchSearch(app: FastifyInstance, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1/batch-search',
    payload,
  });
}

async function sendBatchSearch(app: FastifyInstance, payload: Record<string, unknown>) {
  const response = await injectBatchSearch(app, payload);
  return {
    response,
    body: parseBody(response),
  };
}

function expectUseCaseCalledWith(
  execute: BatchSearchUseCase['execute'],
  options: {
    /** Literal batch id or Vitest asymmetric matcher (e.g. `expect.any(String)`). */
    batchId?: unknown;
    routeOptions?: Record<string, unknown>;
  } = {},
) {
  expect(execute).toHaveBeenCalledWith(
    expect.arrayContaining([expect.objectContaining({ id: '1', query: 'Test' })]),
    options.routeOptions !== undefined
      ? expect.objectContaining(options.routeOptions)
      : undefined,
    options.batchId,
    expect.objectContaining({
      abortSignal: expect.any(AbortSignal),
    }),
  );
}

async function mockUseCaseAndSend(
  execute: BatchSearchUseCase['execute'],
  app: FastifyInstance,
  batchResponse: BatchSearchResponse,
  payload: Record<string, unknown>,
) {
  vi.mocked(execute).mockResolvedValue(batchResponse);
  return sendBatchSearch(app, payload);
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
    it.each([
      [
        'all requests succeed',
        makeBatchResponse(),
        { requests: [makeBatchRequestItem()] },
        {
          total: 1,
          succeeded: 1,
          failed: 0,
          batch_status: 'succeeded',
          has_failures: false,
          firstResult: { id: '1', status: 'succeeded' },
        },
      ],
      [
        'requests partially fail',
        makeBatchResponse({
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
        }),
        {
          requests: [
            makeBatchRequestItem({ id: '1', query: 'Query 1' }),
            makeBatchRequestItem({ id: '2', query: 'Query 2' }),
          ],
        },
        {
          total: 2,
          succeeded: 1,
          failed: 1,
          batch_status: 'partial_failure',
          has_failures: true,
          firstResult: { id: '1', status: 'succeeded' },
        },
      ],
      [
        'all requests fail',
        makeBatchResponse({
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
        }),
        {
          requests: [makeBatchRequestItem({ query: 'Bad query' })],
        },
        {
          total: 1,
          succeeded: 0,
          failed: 1,
          batch_status: 'failed',
          has_failures: true,
          firstResult: {
            id: '1',
            status: 'failed',
            error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
          },
        },
      ],
    ])('should return 200 when %s', async (_label, batchResponse, payload, expected) => {
      vi.mocked(mockBatchSearchUseCase.execute).mockResolvedValue(batchResponse);

      const { response, body } = await sendBatchSearch(app, payload);

      expect(response.statusCode).toBe(200);
      expect(body.total).toBe(expected.total);
      expect(body.succeeded).toBe(expected.succeeded);
      expect(body.failed).toBe(expected.failed);
      expect(body.batch_status).toBe(expected.batch_status);
      expect(body.has_failures).toBe(expected.has_failures);
      expect(body.results).toHaveLength(batchResponse.results.length);
      expect(body.results[0]).toMatchObject(expected.firstResult);
    });
  });

  describe('Request validation', () => {
    it('should accept valid batch request', async () => {
      const { response, body } = await mockUseCaseAndSend(
        mockBatchSearchUseCase.execute,
        app,
        makeBatchResponse(),
        {
        requests: [
          makeBatchRequestItem({
            id: 'q1',
            query: 'Cabernet 2015',
            limit: 10,
            retrieval_mode: 'hybrid',
          }),
        ],
        options: {
          fail_fast: false,
          timeout_ms: 5000,
        },
        batch_id: 'my-batch',
        },
      );

      expect(response.statusCode).toBe(200);
      expect(body.results).toHaveLength(1);
      expect(body.results[0].status).toBe('succeeded');
    });

    it.each([
      ['empty requests array', { requests: [] }],
      [
        'oversized batch (21+ items)',
        {
          requests: Array.from({ length: 21 }, (_, i) =>
            makeBatchRequestItem({ id: String(i + 1), query: `Query ${i + 1}` }),
          ),
        },
      ],
      ['request with missing query', { requests: [{ id: '1' }] }],
      ['request with missing id', { requests: [{ query: 'Test' }] }],
      ['query exceeding max length (500)', { requests: [makeBatchRequestItem({ query: 'x'.repeat(501) })] }],
      ['timeout_ms below minimum (1000)', { requests: [makeBatchRequestItem()], options: { timeout_ms: 500 } }],
      ['timeout_ms above maximum (30000)', { requests: [makeBatchRequestItem()], options: { timeout_ms: 40000 } }],
      ['invalid retrieval_mode', { requests: [makeBatchRequestItem({ retrieval_mode: 'invalid_mode' })] }],
    ])('should reject %s', async (_label, payload) => {
      const response = await injectBatchSearch(app, payload);

      expect(response.statusCode).toBe(400);
      const body = parseBody(response);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Response structure', () => {
    it.each([
      [
        'successful result envelope',
        makeBatchResponse({
          batch_id: 'batch-abc',
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
          processing_time_ms: 52,
        }),
        { requests: [makeBatchRequestItem()] },
        (body: Record<string, any>) => {
          expect(body).toMatchObject({
            batch_id: 'batch-abc',
            total: 1,
            succeeded: 1,
            failed: 0,
            processing_time_ms: expect.any(Number),
            results: expect.any(Array),
          });
        },
      ],
      [
        'failed result envelope',
        makeBatchResponse({
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
        }),
        { requests: [makeBatchRequestItem({ query: 'Blocked' })] },
        (body: Record<string, any>) => {
          expect(body.results[0]).toMatchObject({
            status: 'failed',
            error: {
              code: 'POLICY_BLOCKED',
              message: 'Query blocked by policy',
            },
          });
        },
      ],
    ])('should return %s', async (_label, batchResponse, payload, assertBody) => {
      const { body } = await mockUseCaseAndSend(
        mockBatchSearchUseCase.execute,
        app,
        batchResponse,
        payload,
      );

      assertBody(body);
    });

    it('fails closed when a V2 human payload leaks into a succeeded batch item response', async () => {
      vi.mocked(mockBatchSearchUseCase.execute).mockResolvedValue({
        batch_id: 'batch-v2-leak',
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
            response: {
              queryId: 'q-v2',
              queryType: 'search',
              results: [],
              totalCandidates: 0,
              version: '2',
              responseType: 'human',
            } as never,
          },
        ],
        processing_time_ms: 5,
      });

      const response = await injectBatchSearch(app, {
        requests: [makeBatchRequestItem()],
      });

      expect(response.statusCode).toBe(500);
      const body = parseBody(response);
      expect(body.error).toMatchObject({
        code: 'INTERNAL_ERROR',
        retryable: false,
      });
    });
  });

  describe('Batch ID handling', () => {
    it('should pass batch_id to use case when provided', async () => {
      const batchResponse = makeBatchResponse({
        batch_id: 'my-batch-123',
        processing_time_ms: 50,
      });

      vi.mocked(mockBatchSearchUseCase.execute).mockResolvedValue(
        batchResponse,
      );

      await injectBatchSearch(app, {
        requests: [makeBatchRequestItem()],
        batch_id: 'my-batch-123',
      });

      expectUseCaseCalledWith(mockBatchSearchUseCase.execute, {
        batchId: 'my-batch-123',
      });
    });

    it('should pass request-scoped batch_id when not provided', async () => {
      const batchResponse = makeBatchResponse({
        batch_id: 'batch_12345_abc123',
        processing_time_ms: 50,
      });

      vi.mocked(mockBatchSearchUseCase.execute).mockResolvedValue(
        batchResponse,
      );

      await injectBatchSearch(app, {
        requests: [makeBatchRequestItem()],
      });

      expectUseCaseCalledWith(mockBatchSearchUseCase.execute, {
        batchId: expect.any(String),
      });
    });
  });

  describe('Options propagation', () => {
    it('should pass fail_fast and timeout_ms to use case', async () => {
      const batchResponse = makeBatchResponse({
        processing_time_ms: 100,
      });

      vi.mocked(mockBatchSearchUseCase.execute).mockResolvedValue(
        batchResponse,
      );

      await injectBatchSearch(app, {
        requests: [makeBatchRequestItem()],
        options: {
          fail_fast: true,
          timeout_ms: 10000,
        },
      });

      expectUseCaseCalledWith(mockBatchSearchUseCase.execute, {
        routeOptions: {
          fail_fast: true,
          timeout_ms: 10000,
        },
        batchId: expect.any(String),
      });
    });
  });
});
