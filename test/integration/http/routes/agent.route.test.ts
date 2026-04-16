import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { errorHandler } from '../../../../src/interface/http/middleware/error-handler.js';
import { registerRequestContext } from '../../../../src/interface/http/middleware/request-context.js';
import { registerAgentRoute } from '../../../../src/interface/http/routes/agent.route.js';
import type { AgentRouteDeps } from '../../../../src/interface/http/routes/agent.route.js';

describe('POST /v1/agent', () => {
  let app: FastifyInstance;
  let deps: AgentRouteDeps;

  beforeAll(async () => {
    app = Fastify();
    registerRequestContext(app);
    app.setErrorHandler(errorHandler);

    deps = {
      agentOrchestrator: {
        execute: vi.fn().mockResolvedValue({
          answer: 'ok',
          steps: [],
          totalDurationMs: 1,
          totalTokens: { input: 1, output: 1 },
          toolCallCount: 0,
          fallbackApplied: false,
          terminationReason: 'answer',
        }),
      } as never,
    };

    registerAgentRoute(app, deps);
    await app.ready();
  });

  beforeEach(() => {
    deps.agentOrchestrator.execute = vi.fn().mockResolvedValue({
      answer: 'ok',
      steps: [],
      totalDurationMs: 1,
      totalTokens: { input: 1, output: 1 },
      toolCallCount: 0,
      fallbackApplied: false,
      terminationReason: 'answer',
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('serializes parallel actionPairs into actions/observations transport fields', async () => {
    deps.agentOrchestrator.execute = vi.fn().mockResolvedValue({
      answer: '병렬 호출 완료',
      steps: [
        {
          index: 0,
          thought: 'run parallel',
          actionPairs: [
            { action: { tool: 'search_wines', input: { query: 'barolo' } }, observation: 'Found 3 results' },
            { action: { tool: 'get_food_pairings', input: { food: 'steak' } }, observation: 'Pairs with steak' },
          ],
          durationMs: 12,
          tokenCount: { input: 20, output: 10 },
        },
      ],
      totalDurationMs: 12,
      totalTokens: { input: 20, output: 10 },
      toolCallCount: 2,
      fallbackApplied: false,
      terminationReason: 'answer',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/agent',
      headers: { 'content-type': 'application/json' },
      payload: {
        query: '바롤로랑 스테이크 페어링 동시에',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0]?.actions).toHaveLength(2);
    expect(body.steps[0]?.observations).toEqual(['Found 3 results', 'Pairs with steak']);
    expect(body.steps[0]?.action).toBeUndefined();
    expect(body.steps[0]?.observation).toBeUndefined();
    expect(body.meta.tool_call_count).toBe(2);
    expect(body.meta.termination_reason).toBe('answer');
    expect(body.meta.fallback_applied).toBe(false);
  });

  it('passes bounded max_steps and AbortSignal to orchestrator', async () => {
    const execute = vi.fn().mockResolvedValue({
      answer: 'ok',
      steps: [],
      totalDurationMs: 2,
      totalTokens: { input: 1, output: 1 },
      toolCallCount: 0,
      fallbackApplied: false,
      terminationReason: 'answer',
    });
    deps.agentOrchestrator.execute = execute as never;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/agent',
      headers: { 'content-type': 'application/json' },
      payload: {
        query: 'test query',
        options: { max_steps: 3 },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
    const call = execute.mock.calls[0];
    expect(call?.[0]).toBe('test query');
    expect(call?.[2]).toEqual({ maxSteps: 3 });
    expect(call?.[3]).toBeInstanceOf(AbortSignal);
  });

  it('aborts lifecycle signal in finally after successful request completion', async () => {
    let capturedSignal: AbortSignal | undefined;
    deps.agentOrchestrator.execute = vi.fn().mockImplementation(
      async (_query: string, _requestId: string, _overrides: unknown, signal?: AbortSignal) => {
        capturedSignal = signal;
        return {
          answer: 'ok',
          steps: [],
          totalDurationMs: 1,
          totalTokens: { input: 1, output: 1 },
          toolCallCount: 0,
          fallbackApplied: false,
          terminationReason: 'answer',
        };
      },
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v1/agent',
      headers: { 'content-type': 'application/json' },
      payload: {
        query: 'signal cleanup check',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('serializes fallback_trace when the orchestrator reports agent fallback', async () => {
    deps.agentOrchestrator.execute = vi.fn().mockResolvedValue({
      answer: 'fallback answer',
      steps: [],
      totalDurationMs: 4,
      totalTokens: { input: 2, output: 1 },
      toolCallCount: 1,
      fallbackApplied: true,
      fallbackTrace: {
        fallbackApplied: 'layer2',
        reasoningFailure: false,
        failedSynthesisAttempts: 0,
        fallbackSearchUsed: true,
      },
      terminationReason: 'fallback',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/agent',
      headers: { 'content-type': 'application/json' },
      payload: {
        query: 'fallback trace check',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.meta.fallback_applied).toBe(true);
    expect(body.meta.fallback_trace).toEqual({
      fallbackApplied: 'layer2',
      reasoningFailure: false,
      failedSynthesisAttempts: 0,
      fallbackSearchUsed: true,
    });
  });

  it('fails closed when a known tool trace contains unexpected input keys', async () => {
    deps.agentOrchestrator.execute = vi.fn().mockResolvedValue({
      answer: 'bad trace',
      steps: [
        {
          index: 0,
          thought: 'search',
          action: {
            tool: 'search_wines',
            input: { query: 'opus one', unexpected: true },
          },
          observation: 'Found 1 result',
          durationMs: 2,
          tokenCount: { input: 1, output: 1 },
        },
      ],
      totalDurationMs: 2,
      totalTokens: { input: 1, output: 1 },
      toolCallCount: 1,
      fallbackApplied: false,
      terminationReason: 'answer',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/agent',
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-bad-trace' },
      payload: {
        query: 'test bad trace',
      },
    });

    expect(response.statusCode).toBe(500);
    const body = response.json() as {
      error: { code: string; request_id: string };
    };
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.request_id).toEqual(expect.any(String));
  });
});
