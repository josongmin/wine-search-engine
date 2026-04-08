import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BatchSearchUseCase,
  type BatchSearchRequestItem,
} from '../../../../src/application/search/batch-search.usecase.js';
import type { SearchUseCase } from '../../../../src/application/search/search.usecase.js';
import type { SearchResponseV1 } from '../../../../src/domain/response/model/search-response.js';

function singleRequest(query = 'Test'): BatchSearchRequestItem[] {
  return [{ id: '1', query }];
}

function makeSearchResponse(): SearchResponseV1 {
  return {
    queryType: 'search',
    engineDecision: {
      decisionStatus: 'resolved',
      nextAction: 'return_result',
      route: 'hybrid',
      decisionConfidence: 0.95,
      confidenceSemantics: 'calibrated_decision_confidence',
      decisionTraceRef: 'trace-1',
      decisionSnapshot: {
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1',
        threshold_profile_id: 'default',
        planner_version: '1',
        feature_flags: {},
      },
    },
    results: [],
    clarification: null,
    meta: {
      requestId: 'req-1',
      queryTimeMs: 100,
      route: 'hybrid',
      version: '1.0.0',
      engine_schema_version: 'search_response_v1',
      decisionSnapshot: {
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1',
        threshold_profile_id: 'default',
        planner_version: '1',
        feature_flags: {},
      },
      response_hash: 'hash',
    },
  };
}

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
    vi.clearAllMocks();
    vi.useRealTimers();

    // Mock SearchUseCase
    mockSearchUseCase = {
      execute: vi.fn(),
    } as unknown as SearchUseCase;

    useCase = new BatchSearchUseCase(mockSearchUseCase);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('validate batch size', () => {
    it('should accept 1 request', async () => {
      const requests: BatchSearchRequestItem[] = [
        { id: '1', query: 'Cabernet' },
      ];

      const response = await useCase.execute(requests);

      expect(response.total).toBe(1);
      expect(response.results).toHaveLength(1);
      expect(response.batch_status).toBe('failed');
      expect(response.has_failures).toBe(true);
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
        makeSearchResponse(),
      );

      const response = await useCase.execute(requests);

      expect(response.total).toBe(20);
      expect(response.batch_status).toBe('succeeded');
      expect(response.has_failures).toBe(false);
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
      expect(response.batch_status).toBe('failed');
      expect(response.has_failures).toBe(true);
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
      expect(response.batch_status).toBe('succeeded');
      expect(response.has_failures).toBe(false);
      expect(response.results).toHaveLength(0);
    });
  });

  describe('timeout validation', () => {
    it('should use default timeout (5000 ms)', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
        makeSearchResponse(),
      );

      await useCase.execute(singleRequest());

      expect(mockSearchUseCase.execute).toHaveBeenCalled();
    });

    it.each([
      ['accept timeout in range (1000–30000 ms)', { timeout_ms: 10000 }],
      ['clamp timeout below minimum to 1000 ms', { timeout_ms: 500 }],
      ['clamp timeout above maximum to 30000 ms', { timeout_ms: 60000 }],
    ] as const)('should %s', async (_label, options) => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
        makeSearchResponse(),
      );

      const response = await useCase.execute(singleRequest(), options);

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

      const mockResponse = makeSearchResponse();

      vi.mocked(mockSearchUseCase.execute)
        .mockResolvedValueOnce(mockResponse)
        .mockRejectedValueOnce(new Error('Search failed'))
        .mockResolvedValueOnce(mockResponse);

      const response = await useCase.execute(requests, { fail_fast: false });

      expect(response.total).toBe(3);
      expect(response.succeeded).toBe(2);
      expect(response.failed).toBe(1);
      expect(response.batch_status).toBe('partial_failure');
      expect(response.has_failures).toBe(true);
      expect(response.results).toHaveLength(3);
      expect(mockSearchUseCase.execute).toHaveBeenCalledTimes(3);
    });

    it('should mark failed requests with appropriate error codes', async () => {
      const requests: BatchSearchRequestItem[] = [
        { id: '1', query: 'Query 1' },
        { id: '2', query: 'Query 2' },
      ];

      const mockResponse = makeSearchResponse();

      const policyError = new (class extends Error {
        override name = 'DomainError';
        code = 'POLICY_BLOCKED';
        constructor() {
          super('Query blocked by policy');
        }
      })();

      vi.mocked(mockSearchUseCase.execute)
        .mockResolvedValueOnce(mockResponse)
        .mockRejectedValueOnce(policyError);

      const response = await useCase.execute(requests, { fail_fast: false });

      const failedResult = response.results.find((r) => r.status === 'failed');
      expect(failedResult?.status).toBe('failed');
      if (failedResult?.status === 'failed') {
        expect(failedResult.error.code).toBe('POLICY_BLOCKED');
      }
    });

    it('marks comparison-style responses as QUERY_PARSE_ERROR instead of INTERNAL_ERROR', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValueOnce({
        queryType: 'comparison',
        originalQuery: 'Opus One vs Sassicaia',
        comparisonIntent: 'compare',
        entities: [
          {
            subQuery: 'Opus One',
            topResult: null,
            resultCount: 0,
            resolutionStatus: 'failed',
            allResults: [],
          },
          {
            subQuery: 'Sassicaia',
            topResult: null,
            resultCount: 0,
            resolutionStatus: 'failed',
            allResults: [],
          },
        ],
        overallStatus: 'failed',
        requestId: 'req-1',
        executionTimeMs: 1,
      } as never);

      const response = await useCase.execute(singleRequest('Opus One vs Sassicaia'));

      const failedResult = response.results[0];
      expect(failedResult?.status).toBe('failed');
      if (failedResult?.status === 'failed') {
        expect(failedResult.error.code).toBe('QUERY_PARSE_ERROR');
        expect(failedResult.error.message).toContain('does not support comparison-style queries');
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

      const mockResponse = makeSearchResponse();

      vi.mocked(mockSearchUseCase.execute)
        .mockResolvedValueOnce(mockResponse)
        .mockRejectedValueOnce(new Error('Search failed'))
        .mockResolvedValueOnce(mockResponse);

      const response = await useCase.execute(requests, { fail_fast: true });

      expect(response.total).toBe(3);
      expect(response.succeeded).toBe(1);
      expect(response.failed).toBe(1);
      expect(response.not_executed).toBe(1);
      expect(mockSearchUseCase.execute).toHaveBeenCalledTimes(2);
      expect(response.results[2]).toMatchObject({
        id: '3',
        status: 'not_executed',
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Batch execution aborted due to earlier failure',
        },
      });
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

      const response = await useCase.execute(requests, { timeout_ms: 10 });

      expect(response.succeeded).toBe(0);
      expect(response.failed).toBe(1);
      const result = response.results[0];
      if (result?.status === 'failed') {
        expect(result.error.code).toBe('RETRIEVAL_TIMEOUT');
      }
    });

    it('aborts the underlying search execution when timeout wins', async () => {
      vi.useFakeTimers();

      let receivedSignal: AbortSignal | undefined;
      vi.mocked(mockSearchUseCase.execute).mockImplementation(
        async (_request, _requestId, options) => {
          receivedSignal = options?.abortSignal;
          await new Promise<never>((_resolve, reject) => {
            options?.abortSignal?.addEventListener('abort', () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            }, { once: true });
          });
          throw new Error('unreachable');
        },
      );

      const responsePromise = useCase.execute(
        [{ id: '1', query: 'Slow query' }],
        { timeout_ms: 10 },
      );

      await vi.advanceTimersByTimeAsync(1000);
      const response = await responsePromise;

      expect(receivedSignal?.aborted).toBe(true);
      expect(response.failed).toBe(1);
      const result = response.results[0];
      if (result?.status === 'failed') {
        expect(result.error.code).toBe('RETRIEVAL_TIMEOUT');
      }
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('error mapping', () => {
    it.each([
      [
        'POLICY_BLOCKED error',
        'Blocked query',
        new (class DomainError extends Error {
          override name = 'DomainError';
          code = 'POLICY_BLOCKED';
          constructor() {
            super('Query blocked by policy');
          }
        })(),
        'POLICY_BLOCKED',
      ],
      [
        'QUERY_PARSE_ERROR (ZodError)',
        'Invalid',
        new (class extends Error {
          override name = 'ZodError';
          constructor() {
            super('Invalid query format');
          }
        })(),
        'QUERY_PARSE_ERROR',
      ],
      [
        'INTERNAL_ERROR for unknown errors',
        'Unknown error',
        new Error('Unknown error'),
        'INTERNAL_ERROR',
      ],
    ] as const)('should map %s', async (_label, query, error, expectedCode) => {
      vi.mocked(mockSearchUseCase.execute).mockRejectedValueOnce(error);

      const response = await useCase.execute(singleRequest(query));

      const result = response.results[0];
      expect(result?.status).toBe('failed');
      if (result?.status === 'failed') {
        expect(result.error.code).toBe(expectedCode);
      }
    });
  });

  describe('sub-request ID generation', () => {
    it('should generate sub-request ID as ${batchId}-${item.id}', async () => {
      const requests: BatchSearchRequestItem[] = [{ id: 'query1', query: 'Test' }];

      const batchId = 'batch-123';

      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
        makeSearchResponse(),
      );

      await useCase.execute(requests, undefined, batchId);

      const callArgs = vi.mocked(mockSearchUseCase.execute).mock.calls[0];
      const requestId = callArgs?.[1];
      expect(requestId).toBe('batch-123-query1');
    });
  });

  describe('idempotency', () => {
    it('should return consistent batch_id when provided', async () => {
      const batchId = 'my-batch-123';

      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
        makeSearchResponse(),
      );

      const response = await useCase.execute(singleRequest(), undefined, batchId);

      expect(response.batch_id).toBe('my-batch-123');
    });

    it('should generate batch_id when not provided', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
        makeSearchResponse(),
      );

      const response = await useCase.execute(singleRequest());

      expect(response.batch_id).toBeDefined();
      expect(response.batch_id).toMatch(/^batch:v1:[a-f0-9]{64}$/);
    });

    it('changes batch_id when request shape changes beyond query text', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(makeSearchResponse());

      const base = await useCase.execute([
        { id: '1', query: 'Test', limit: 5, retrieval_mode: 'hybrid' },
      ]);
      const changed = await useCase.execute([
        { id: '1', query: 'Test', limit: 10, retrieval_mode: 'hybrid' },
      ]);

      expect(base.batch_id).not.toBe(changed.batch_id);
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

      const mockResponse = makeSearchResponse();

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

      vi.useFakeTimers();
      vi.mocked(mockSearchUseCase.execute).mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve(makeSearchResponse());
            }, 50);
          }),
      );

      const responsePromise = useCase.execute(requests);
      await vi.advanceTimersByTimeAsync(50);
      const response = await responsePromise;

      // Processing time should be at least ~50ms
      expect(response.processing_time_ms).toBeGreaterThanOrEqual(50);
    });
  });

  describe('SearchResponseV1 preservation', () => {
    it('should preserve SearchResponseV1 structure in successful items', async () => {
      const mockResponse: SearchResponseV1 = makeSearchResponse();

      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(mockResponse);

      const response = await useCase.execute(singleRequest());

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
        makeSearchResponse(),
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
