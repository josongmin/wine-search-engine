import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { errorHandler } from '../../../../src/interface/http/middleware/error-handler.js';
import { registerRequestContext } from '../../../../src/interface/http/middleware/request-context.js';
import {
  registerAgentRunRoute,
  registerAgentSessionCreateRoute,
  registerAgentSessionTurnRoute,
  type AgentRouteDeps,
} from '../../../../src/interface/http/routes/agent.route.js';
import {
  AgentSessionCreateResponseSchema,
  AgentSessionTurnResponseSchema,
} from '../../../../src/interface/http/schemas/agent.schema.js';
import type {
  WineSearchOrchestratorContract as WineSearchOrchestrator,
  WineSearchResult,
} from '../../../../src/application/wine-search/wine-search-orchestrator.js';
import {
  computeAgentSessionExpiry,
  createProcessLocalAgentSessionStore,
} from '../../../../src/config/agent-session-store.js';
import { AgentSessionService } from '../../../../src/application/wine-search/agent-session-service.js';
import { AgentUseCase } from '../../../../src/application/wine-search/agent-usecase.js';

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
    execute: vi.fn()
      .mockResolvedValueOnce(makeBaseResult({ answer: '첫 답변입니다.' }))
      .mockResolvedValueOnce(makeBaseResult({ answer: '두 번째 답변입니다.' })),
  };
  const app = Fastify();
  registerRequestContext(app);
  app.setErrorHandler(errorHandler);
  const deps: AgentRouteDeps = {
    agentUseCase: new AgentUseCase({
      orchestrator: orchestrator as unknown as WineSearchOrchestrator,
      sessionService: new AgentSessionService({
        store: createProcessLocalAgentSessionStore(),
        orchestrator: orchestrator as unknown as WineSearchOrchestrator,
        computeExpiry: (now) => computeAgentSessionExpiry(now),
      }),
    }),
  };
  registerAgentRunRoute(app, deps);
  registerAgentSessionCreateRoute(app, deps);
  registerAgentSessionTurnRoute(app, deps);
  await app.ready();
  return { app, orchestrator: orchestrator as TestHarness['orchestrator'] };
}

describe('agent session routes', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('creates a session and replays the same session for the same client_session_id', async () => {
    const first = await harness.app.inject({
      method: 'POST',
      url: '/v1/agent/sessions',
      headers: { 'content-type': 'application/json' },
      payload: {
        client_session_id: 'client-session-1',
        options: { max_steps: 4 },
      },
    });

    expect(first.statusCode).toBe(201);
    const firstBody = AgentSessionCreateResponseSchema.parse(first.json());
    expect(firstBody.replayed).toBe(false);
    expect(firstBody.session.session_version).toBe(0);

    const replay = await harness.app.inject({
      method: 'POST',
      url: '/v1/agent/sessions',
      headers: { 'content-type': 'application/json' },
      payload: {
        client_session_id: 'client-session-1',
        options: { max_steps: 4 },
      },
    });

    expect(replay.statusCode).toBe(200);
    const replayBody = AgentSessionCreateResponseSchema.parse(replay.json());
    expect(replayBody.replayed).toBe(true);
    expect(replayBody.session.session_id).toBe(firstBody.session.session_id);
  });

  it('appends turns with server-managed history custody and reuses the same planner surface', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: '/v1/agent/sessions',
      headers: { 'content-type': 'application/json' },
      payload: {
        client_session_id: 'client-session-2',
        options: { max_steps: 4 },
      },
    });
    const createBody = AgentSessionCreateResponseSchema.parse(created.json());
    const sessionId = createBody.session.session_id;

    const firstTurn = await harness.app.inject({
      method: 'POST',
      url: `/v1/agent/sessions/${sessionId}/turns`,
      headers: { 'content-type': 'application/json' },
      payload: {
        client_turn_id: 'turn-1',
        messages: [{ role: 'user', content: '부르고뉴 피노누아 추천' }],
        expected_session_version: 0,
      },
    });

    expect(firstTurn.statusCode).toBe(201);
    const firstTurnBody = AgentSessionTurnResponseSchema.parse(firstTurn.json());
    expect(firstTurnBody.turn.replayed).toBe(false);
    expect(firstTurnBody.session.session_version).toBe(1);
    expect(firstTurnBody.history_applied).toEqual([
      { role: 'user', content: '부르고뉴 피노누아 추천' },
    ]);

    const secondTurn = await harness.app.inject({
      method: 'POST',
      url: `/v1/agent/sessions/${sessionId}/turns`,
      headers: { 'content-type': 'application/json' },
      payload: {
        client_turn_id: 'turn-2',
        messages: [{ role: 'user', content: '가격대는 10만원 이하로' }],
        expected_session_version: 1,
      },
    });

    expect(secondTurn.statusCode).toBe(201);
    const secondTurnBody = AgentSessionTurnResponseSchema.parse(secondTurn.json());
    expect(secondTurnBody.session.session_version).toBe(2);
    expect(secondTurnBody.history_applied).toEqual([
      { role: 'user', content: '부르고뉴 피노누아 추천' },
      { role: 'assistant', content: '첫 답변입니다.' },
      { role: 'user', content: '가격대는 10만원 이하로' },
    ]);

    expect(harness.orchestrator.execute).toHaveBeenCalledTimes(2);
    // Messages-native (T-MTA-01): the server-managed turn feeds the WHOLE
    // stitched conversation to the orchestrator — there is no last-message
    // `query` extraction at the route boundary.
    expect(harness.orchestrator.execute.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        messages: [{ role: 'user', content: '부르고뉴 피노누아 추천' }],
        options: expect.objectContaining({ maxSteps: 4 }),
      }),
    );
    expect(harness.orchestrator.execute.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        messages: [
          { role: 'user', content: '부르고뉴 피노누아 추천' },
          { role: 'assistant', content: '첫 답변입니다.' },
          { role: 'user', content: '가격대는 10만원 이하로' },
        ],
        options: expect.objectContaining({ maxSteps: 4 }),
      }),
    );
  });

  it('replays an existing client_turn_id without re-running the orchestrator', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: '/v1/agent/sessions',
      headers: { 'content-type': 'application/json' },
      payload: { client_session_id: 'client-session-3' },
    });
    const createBody = AgentSessionCreateResponseSchema.parse(created.json());

    const first = await harness.app.inject({
      method: 'POST',
      url: `/v1/agent/sessions/${createBody.session.session_id}/turns`,
      headers: { 'content-type': 'application/json' },
      payload: {
        client_turn_id: 'turn-1',
        messages: [{ role: 'user', content: '오퍼스 원 알려줘' }],
      },
    });
    expect(first.statusCode).toBe(201);
    expect(harness.orchestrator.execute).toHaveBeenCalledTimes(1);

    const replay = await harness.app.inject({
      method: 'POST',
      url: `/v1/agent/sessions/${createBody.session.session_id}/turns`,
      headers: { 'content-type': 'application/json' },
      payload: {
        client_turn_id: 'turn-1',
        messages: [{ role: 'user', content: '오퍼스 원 알려줘' }],
      },
    });

    expect(replay.statusCode).toBe(200);
    const replayBody = AgentSessionTurnResponseSchema.parse(replay.json());
    expect(replayBody.turn.replayed).toBe(true);
    expect(harness.orchestrator.execute).toHaveBeenCalledTimes(1);
  });

  it('fails closed on missing sessions and stale expected_session_version', async () => {
    const missing = await harness.app.inject({
      method: 'POST',
      url: '/v1/agent/sessions/does-not-exist/turns',
      headers: { 'content-type': 'application/json' },
      payload: {
        client_turn_id: 'turn-x',
        messages: [{ role: 'user', content: '샴페인 추천' }],
      },
    });
    expect(missing.statusCode).toBe(404);
    // RFC-014 envelope on the 404 (not just the status code).
    const missingErr = (missing.json() as { error: { code: string; failure_reason: string; request_id: string; retryable: boolean } }).error;
    expect(missingErr.code).toBe('NOT_FOUND');
    expect(missingErr.failure_reason).toBe('session_not_found');
    expect(typeof missingErr.request_id).toBe('string');
    expect(missingErr.retryable).toBe(false);

    const created = await harness.app.inject({
      method: 'POST',
      url: '/v1/agent/sessions',
      headers: { 'content-type': 'application/json' },
      payload: { client_session_id: 'client-session-4' },
    });
    const createBody = AgentSessionCreateResponseSchema.parse(created.json());

    const stale = await harness.app.inject({
      method: 'POST',
      url: `/v1/agent/sessions/${createBody.session.session_id}/turns`,
      headers: { 'content-type': 'application/json' },
      payload: {
        client_turn_id: 'turn-y',
        messages: [{ role: 'user', content: '리슬링 추천' }],
        expected_session_version: 9,
      },
    });
    expect(stale.statusCode).toBe(409);
    const staleErr = (stale.json() as { error: { code: string; failure_reason: string; retryable: boolean } }).error;
    expect(staleErr.code).toBe('CONFLICT');
    expect(staleErr.failure_reason).toBe('version_conflict');
    expect(staleErr.retryable).toBe(false);
    expect(harness.orchestrator.execute).not.toHaveBeenCalled();
  });
});
