import { describe, expect, it } from 'vitest';

import { LocalSearchFacade } from '../local/local-search-facade.js';
import { RemoteSearchFacade } from '../remote/remote-search-facade.js';
import { LocalAgentFacade } from '../local/local-agent-facade.js';
import { RemoteAgentFacade } from '../remote/remote-agent-facade.js';
import type { ResolvedCliProfile } from '../../../application/cli/context/cli-profile.js';
import { deepKeysToSnake } from '../../../interface/http/middleware/snake-case-hook.js';
import {
  mapWineSearchResultToResponse,
  buildSessionDescriptor,
  buildTurnResponse,
} from '../../../application/wine-search/presentation/agent-presentation.js';
import type { WineSearchResult, WineSearchOrchestratorContract } from '../../../application/wine-search/wine-search-orchestrator.js';
import { AgentUseCase } from '../../../application/wine-search/agent-usecase.js';
import type { AgentSessionService } from '../../../application/wine-search/agent-session-service.js';

/** Wrap mocked deps in a real AgentUseCase — the facade only sees the use-case
 *  seam, so parity must be proven through it. */
function makeUseCase(
  execute: (input: Record<string, unknown>) => Promise<unknown>,
  sessionService?: unknown,
): AgentUseCase {
  return new AgentUseCase({
    orchestrator: { execute } as unknown as WineSearchOrchestratorContract,
    ...(sessionService !== undefined ? { sessionService: sessionService as AgentSessionService } : {}),
  });
}

const REMOTE_PROFILE: ResolvedCliProfile = {
  name: 'parity-test',
  target: 'remote',
  baseUrl: 'https://api.example.com',
  authMode: 'none',
  outputFormat: 'json',
};

function makeFakeFetch(wirePayload: unknown): {
  readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  readonly calls: Array<{ input: string; init?: RequestInit | undefined }>;
} {
  const calls: Array<{ input: string; init?: RequestInit | undefined }> = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    return new Response(JSON.stringify(wirePayload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

describe('search.hybrid local↔remote parity', () => {
  it('emits identical wire JSON from local container + remote HTTP for /v1/search/hybrid', async () => {
    const domainPayload = {
      queryType: 'search',
      engineDecision: { runtimeCorrelationRef: 'runtime-1' },
      meta: { authorityTraceRef: 'authority-1' },
      results: [
        { entityId: 'e1', calibratedScore: 0.9 },
        { entityId: 'e2', calibratedScore: 0.7 },
      ],
    };
    const expectedWire = deepKeysToSnake(domainPayload);

    const local = new LocalSearchFacade({
      withContainer: async (work) =>
        await work({
          searchUseCase: { execute: async () => domainPayload },
        } as never),
    });

    const localOut = await local.hybrid(
      { query: 'opus one 2018' },
      { requestId: 'req-1' },
    );

    const { fetchImpl, calls } = makeFakeFetch(expectedWire);
    const remote = new RemoteSearchFacade(REMOTE_PROFILE, { fetchImpl });

    const remoteOut = await remote.hybrid(
      { query: 'opus one 2018' },
      { requestId: 'req-1' },
    );

    expect(localOut).toEqual(expectedWire);
    expect(remoteOut).toEqual(expectedWire);
    expect(localOut).toEqual(remoteOut);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('https://api.example.com/v1/search/hybrid');
  });
});

describe('agent.run local↔remote parity', () => {
  it('emits identical wire JSON from local container + remote HTTP for /v1/agent', async () => {
    const orchestratorResult = {
      answer: 'A representative wine answer.',
      layer: 'primary',
      groundedOnToolResults: true,
      toolOutcomes: [],
      executionSteps: [
        {
          index: 0,
          source: 'analyzer',
          summary: 'analyzed query',
          durationMs: 12,
        },
      ],
      toolCallCount: 0,
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      totalDurationMs: 42,
      terminationReason: 'answer',
      policyBlocked: false,
      intent: 'general_search',
      planKind: 'single',
    } as unknown as WineSearchResult;
    const expectedWire = mapWineSearchResultToResponse(orchestratorResult, 'req-1');

    const local = new LocalAgentFacade({
      withContainer: async (work) =>
        await work({
          wineSearch: { agentUseCase: makeUseCase(async () => orchestratorResult) },
        } as never),
    });

    const localOut = await local.run(
      { messages: [{ role: 'user', content: 'a complex wine search question' }] },
      { requestId: 'req-1' },
    );

    const { fetchImpl, calls } = makeFakeFetch(expectedWire);
    const remote = new RemoteAgentFacade(REMOTE_PROFILE, { fetchImpl });

    const remoteOut = await remote.run(
      { messages: [{ role: 'user', content: 'a complex wine search question' }] },
      { requestId: 'req-1' },
    );

    expect(localOut).toEqual(expectedWire);
    expect(remoteOut).toEqual(expectedWire);
    expect(localOut).toEqual(remoteOut);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('https://api.example.com/v1/agent');
  });
});

describe('agent.session local↔remote parity (T-MTA-05)', () => {
  const NOW = new Date('2026-05-30T00:00:00Z');
  const sessionRecord = {
    sessionId: 'sess-1',
    sessionVersion: 0,
    turns: [],
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: NOW,
  };

  it('start: identical create wire JSON from local service + remote HTTP for /v1/agent/sessions', async () => {
    const expectedWire = { session: buildSessionDescriptor(sessionRecord as never), replayed: false };

    const local = new LocalAgentFacade({
      withContainer: async (work) =>
        await work({
          wineSearch: {
            agentUseCase: makeUseCase(async () => ({}), {
              createSession: async () => ({ kind: 'created', session: sessionRecord }),
            }),
          },
        } as never),
    });
    const localOut = await local.startSession({ clientSessionId: 'cs-1' }, { requestId: 'req-1' });

    const { fetchImpl, calls } = makeFakeFetch(expectedWire);
    const remote = new RemoteAgentFacade(REMOTE_PROFILE, { fetchImpl });
    const remoteOut = await remote.startSession({ clientSessionId: 'cs-1' }, { requestId: 'req-1' });

    expect(localOut).toEqual(expectedWire);
    expect(remoteOut).toEqual(expectedWire);
    expect(localOut).toEqual(remoteOut);
    expect(calls[0]?.input).toBe('https://api.example.com/v1/agent/sessions');
  });

  it('turn: identical turn wire JSON from local service + remote HTTP for /turns', async () => {
    const result = {
      answer: 'A representative wine answer.',
      layer: 'primary',
      groundedOnToolResults: true,
      toolOutcomes: [],
      executionSteps: [],
      toolCallCount: 0,
      tokenUsage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      totalDurationMs: 1,
      terminationReason: 'answer',
      policyBlocked: false,
      intent: 'general_search',
      planKind: 'single',
    } as unknown as WineSearchResult;
    const session = { ...sessionRecord, sessionVersion: 1 };
    const turn = {
      turnIndex: 0,
      clientTurnId: 'turn-1',
      messages: [{ role: 'user' as const, content: 'q' }],
      historyApplied: [{ role: 'user' as const, content: 'q' }],
      result,
      toolTraceSummary: [],
      createdAt: NOW,
    };
    const expectedWire = buildTurnResponse(
      mapWineSearchResultToResponse(result, 'req-1'),
      session as never,
      turn as never,
      false,
    );

    const local = new LocalAgentFacade({
      withContainer: async (work) =>
        await work({
          wineSearch: {
            agentUseCase: makeUseCase(async () => ({}), {
              runTurn: async () => ({ kind: 'appended', session, turn, result, replayed: false }),
            }),
          },
        } as never),
    });
    const localOut = await local.turnSession(
      { sessionId: 'sess-1', clientTurnId: 'turn-1', messages: [{ role: 'user', content: 'q' }] },
      { requestId: 'req-1' },
    );

    const { fetchImpl, calls } = makeFakeFetch(expectedWire);
    const remote = new RemoteAgentFacade(REMOTE_PROFILE, { fetchImpl });
    const remoteOut = await remote.turnSession(
      { sessionId: 'sess-1', clientTurnId: 'turn-1', messages: [{ role: 'user', content: 'q' }] },
      { requestId: 'req-1' },
    );

    expect(localOut).toEqual(expectedWire);
    expect(remoteOut).toEqual(expectedWire);
    expect(localOut).toEqual(remoteOut);
    expect(calls[0]?.input).toBe('https://api.example.com/v1/agent/sessions/sess-1/turns');
  });
});
