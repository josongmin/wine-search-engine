import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { errorHandler } from '../../../../src/interface/http/middleware/error-handler.js';
import { registerRequestContext } from '../../../../src/interface/http/middleware/request-context.js';
import {
  mapResultToResponse,
  registerWineSearchRoute,
  type WineSearchOrchestrator,
  type WineSearchResult,
  type WineSearchRouteDeps,
} from '../../../../src/interface/http/routes/wine-search.route.js';
import {
  WineSearchResponseSchema,
  ANSWER_MAX_CHARS,
} from '../../../../src/interface/http/schemas/wine-search.schema.js';
import { MAX_AGENT_HTTP_QUERY_CHARS } from '../../../../src/interface/http/constants.js';

/**
 * Minimal canonical orchestrator result — used as the default mock return
 * across tests. Individual cases override fields they care about.
 */
function makeBaseResult(overrides: Partial<WineSearchResult> = {}): WineSearchResult {
  return {
    answer: '추천 결과를 정리했습니다.',
    executionSteps: [],
    toolCallCount: 0,
    totalDurationMs: 5,
    tokenUsage: {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    intent: 'search',
    planKind: 'single-search',
    terminationReason: 'answer',
    layer: 'primary',
    policyBlocked: false,
    ...overrides,
  };
}

interface TestHarness {
  readonly app: FastifyInstance;
  readonly orchestrator: WineSearchOrchestrator & {
    execute: ReturnType<typeof vi.fn>;
  };
}

async function buildHarness(): Promise<TestHarness> {
  const orchestrator = {
    execute: vi.fn().mockResolvedValue(makeBaseResult()),
  };
  const app = Fastify();
  registerRequestContext(app);
  app.setErrorHandler(errorHandler);
  const deps: WineSearchRouteDeps = {
    wineSearchOrchestrator: orchestrator as unknown as WineSearchOrchestrator,
  };
  registerWineSearchRoute(app, deps);
  await app.ready();
  return { app, orchestrator: orchestrator as TestHarness['orchestrator'] };
}

describe('POST /v1/wine-search', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('returns a contract-valid 200 response for a Korean query', async () => {
    harness.orchestrator.execute = vi.fn().mockResolvedValue(
      makeBaseResult({
        answer: '부르고뉴 피노누아 추천을 정리했습니다. 가성비 옵션 3종을 골랐습니다.',
        intent: 'search',
        planKind: 'single-search',
      }),
    );

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/wine-search',
      headers: { 'content-type': 'application/json' },
      payload: { query: '부르고뉴 피노누아 추천' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    // Strict-parse the full envelope so any drift fails loudly.
    const parsed = WineSearchResponseSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
    expect(body.query_type).toBe('wine_search');
    expect(body.answer.length).toBeGreaterThan(0);
    // UTF-8 byte parity: Korean answer must round-trip unchanged.
    expect(body.answer).toBe('부르고뉴 피노누아 추천을 정리했습니다. 가성비 옵션 3종을 골랐습니다.');
    expect(body.meta.intent).toBe('search');
    expect(body.meta.plan_kind).toBe('single-search');
    expect(body.meta.termination).toEqual({ reason: 'answer', layer: 'primary' });
    expect(body.meta.policy_blocked).toBe(false);
  });

  it('returns 200 for an English query and echoes total_tokens unchanged', async () => {
    harness.orchestrator.execute = vi.fn().mockResolvedValue(
      makeBaseResult({
        answer: 'Opus One 2018 — California, USA. Cabernet-led Bordeaux blend.',
        intent: 'search',
        planKind: 'single-search',
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 200,
          cacheReadTokens: 50,
          cacheCreationTokens: 25,
        },
      }),
    );

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/wine-search',
      headers: { 'content-type': 'application/json' },
      payload: { query: 'Opus One 2018' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.meta.total_tokens).toEqual({
      input_tokens: 100,
      output_tokens: 200,
      cache_read_tokens: 50,
      cache_creation_tokens: 25,
    });
  });

  it('rejects an empty query with 400 (Zod validation)', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/wine-search',
      headers: { 'content-type': 'application/json' },
      payload: { query: '' },
    });

    expect(response.statusCode).toBe(400);
    expect(harness.orchestrator.execute).not.toHaveBeenCalled();
  });

  it('rejects a too-long query with 400 (Zod validation)', async () => {
    const tooLong = 'a'.repeat(MAX_AGENT_HTTP_QUERY_CHARS + 1);
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/wine-search',
      headers: { 'content-type': 'application/json' },
      payload: { query: tooLong },
    });

    expect(response.statusCode).toBe(400);
  });

  it.each([0, 11])(
    'rejects max_steps=%s with 400 (NOT silently bumped to default cap)',
    async (badSteps) => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/wine-search',
        headers: { 'content-type': 'application/json' },
        payload: { query: 'test', options: { max_steps: badSteps } },
      });
      expect(response.statusCode).toBe(400);
      expect(harness.orchestrator.execute).not.toHaveBeenCalled();
    },
  );

  it('rejects non-numeric max_steps with 400', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/wine-search',
      headers: { 'content-type': 'application/json' },
      payload: { query: 'test', options: { max_steps: 'abc' } },
    });
    expect(response.statusCode).toBe(400);
  });

  it('passes max_steps=10 (boundary) through to the orchestrator', async () => {
    const execute = vi.fn().mockResolvedValue(makeBaseResult());
    harness.orchestrator.execute = execute;

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/wine-search',
      headers: { 'content-type': 'application/json' },
      payload: { query: 'test', options: { max_steps: 10 } },
    });

    expect(response.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
    const call = execute.mock.calls[0]?.[0];
    expect(call.maxSteps).toBe(10);
  });

  it('forwards per_step_timeout_ms / agent_timeout_ms / max_total_tokens to the orchestrator', async () => {
    const execute = vi.fn().mockResolvedValue(makeBaseResult());
    harness.orchestrator.execute = execute;

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/wine-search',
      headers: { 'content-type': 'application/json' },
      payload: {
        query: 'test',
        options: {
          max_steps: 4,
          per_step_timeout_ms: 5_000,
          agent_timeout_ms: 30_000,
          max_total_tokens: 20_000,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const call = execute.mock.calls[0]?.[0];
    expect(call.perStepTimeoutMs).toBe(5_000);
    expect(call.agentTimeoutMs).toBe(30_000);
    expect(call.maxTotalTokens).toBe(20_000);
    expect(call.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('clamps to the cap when max_steps is omitted (defense-in-depth)', async () => {
    const execute = vi.fn().mockResolvedValue(makeBaseResult());
    harness.orchestrator.execute = execute;

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/wine-search',
      headers: { 'content-type': 'application/json' },
      payload: { query: 'test' },
    });

    expect(response.statusCode).toBe(200);
    const call = execute.mock.calls[0]?.[0];
    expect(call.maxSteps).toBe(10);
  });

  it('aborts the lifecycle signal in finally after a healthy completion', async () => {
    let capturedSignal: AbortSignal | undefined;
    harness.orchestrator.execute = vi.fn().mockImplementation(
      async (input: { readonly abortSignal: AbortSignal }) => {
        capturedSignal = input.abortSignal;
        expect(capturedSignal.aborted).toBe(false);
        return makeBaseResult();
      },
    );

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/wine-search',
      headers: { 'content-type': 'application/json' },
      payload: { query: 'signal lifecycle' },
    });

    expect(response.statusCode).toBe(200);
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('returns 500 with the RFC-014 error envelope when the orchestrator throws', async () => {
    harness.orchestrator.execute = vi.fn().mockRejectedValue(new Error('boom'));

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/wine-search',
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-boom' },
      payload: { query: 'wine please' },
    });

    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.request_id).toEqual(expect.any(String));
    expect(typeof body.error.message).toBe('string');
    expect(typeof body.error.retryable).toBe('boolean');
  });

  it('serializes multi-step execution with tool_calls and observations', async () => {
    harness.orchestrator.execute = vi.fn().mockResolvedValue(
      makeBaseResult({
        executionSteps: [
          {
            index: 0,
            source: 'analyzer',
            summary: 'Identified comparison intent across two regions',
            durationMs: 12,
            tokenUsage: {
              inputTokens: 50,
              outputTokens: 30,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
            },
          },
          {
            index: 1,
            source: 'runner',
            summary: 'Parallel search across two regions',
            toolCalls: [
              { name: 'search_wines', arguments: { query: 'bordeaux 2018' } },
              { name: 'search_wines', arguments: { query: 'burgundy 2018' } },
            ],
            observations: ['Found 5 bordeaux', 'Found 7 burgundy'],
            durationMs: 220,
          },
          {
            index: 2,
            source: 'synthesizer',
            summary: 'Composed final comparison answer',
            durationMs: 50,
          },
        ],
        toolCallCount: 2,
        planKind: 'parallel-search',
        intent: 'compare',
      }),
    );

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/wine-search',
      headers: { 'content-type': 'application/json' },
      payload: { query: '보르도 vs 부르고뉴 2018' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    // Schema must still pass strict parse with this richer payload.
    const parsed = WineSearchResponseSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);

    expect(body.execution.steps).toHaveLength(3);
    expect(body.execution.steps[0].source).toBe('analyzer');
    expect(body.execution.steps[0].token_usage.input_tokens).toBe(50);
    expect(body.execution.steps[1].tool_calls).toHaveLength(2);
    expect(body.execution.steps[1].observations).toEqual([
      'Found 5 bordeaux',
      'Found 7 burgundy',
    ]);
    expect(body.execution.tool_call_count).toBe(2);
    expect(body.meta.plan_kind).toBe('parallel-search');
    expect(body.meta.intent).toBe('compare');
  });

  it('surfaces termination.degraded_reason when the orchestrator reports a fallback', async () => {
    harness.orchestrator.execute = vi.fn().mockResolvedValue(
      makeBaseResult({
        layer: 'layer2',
        terminationReason: 'fallback',
        degradedReason: 'malformed_llm_output',
      }),
    );

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/wine-search',
      headers: { 'content-type': 'application/json' },
      payload: { query: 'pinot noir' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.meta.termination).toEqual({
      reason: 'fallback',
      layer: 'layer2',
      degraded_reason: 'malformed_llm_output',
    });
  });

  it('surfaces policy_blocked=true when the orchestrator blocks the query', async () => {
    harness.orchestrator.execute = vi.fn().mockResolvedValue(
      makeBaseResult({
        answer: '죄송하지만 해당 질의는 처리할 수 없습니다.',
        terminationReason: 'blocked',
        layer: 'layer4',
        degradedReason: 'policy_blocked',
        intent: 'rejected',
        planKind: 'reject',
        policyBlocked: true,
      }),
    );

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/wine-search',
      headers: { 'content-type': 'application/json' },
      payload: { query: 'malicious payload' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.meta.policy_blocked).toBe(true);
    expect(body.meta.intent).toBe('rejected');
    expect(body.meta.plan_kind).toBe('reject');
    expect(body.meta.termination.reason).toBe('blocked');
  });
});

describe('mapResultToResponse — pure mapper', () => {
  it('omits step.tool_calls when toolCalls is undefined (exactOptionalPropertyTypes)', () => {
    const result = makeBaseResult({
      executionSteps: [
        {
          index: 0,
          source: 'analyzer',
          summary: 'analysis only',
          durationMs: 1,
        },
      ],
    });
    const wire = mapResultToResponse(result, 'req-1');
    expect(wire.execution.steps[0]).not.toHaveProperty('tool_calls');
    expect(wire.execution.steps[0]).not.toHaveProperty('observations');
    expect(wire.execution.steps[0]).not.toHaveProperty('token_usage');
  });

  it('omits termination.degraded_reason when degradedReason is undefined', () => {
    const result = makeBaseResult({ terminationReason: 'answer', layer: 'primary' });
    const wire = mapResultToResponse(result, 'req-2');
    expect(wire.meta.termination).not.toHaveProperty('degraded_reason');
  });

  it('produces a snake_case envelope that passes strict Zod parse', () => {
    const result = makeBaseResult({
      answer: 'hi',
      executionSteps: [
        {
          index: 0,
          source: 'runner',
          summary: 's',
          toolCalls: [{ name: 'search_wines', arguments: { query: 'merlot' } }],
          observations: ['ok'],
          durationMs: 5,
          tokenUsage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        },
      ],
      toolCallCount: 1,
    });
    const wire = mapResultToResponse(result, 'req-3');
    const parsed = WineSearchResponseSchema.safeParse(wire);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
  });

  it('refuses an answer longer than the ANSWER_MAX_CHARS bound (schema enforcement)', () => {
    const tooLongAnswer = 'a'.repeat(ANSWER_MAX_CHARS + 1);
    const result = makeBaseResult({ answer: tooLongAnswer });
    const wire = mapResultToResponse(result, 'req-4');
    const parsed = WineSearchResponseSchema.safeParse(wire);
    expect(parsed.success).toBe(false);
  });
});
