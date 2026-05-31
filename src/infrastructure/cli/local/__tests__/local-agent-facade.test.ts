import { describe, expect, it } from 'vitest';
import { LocalAgentFacade } from '../local-agent-facade.js';
import { CliError } from '../../../../application/cli/command/cli-error.js';
import { mapWineSearchResultToResponse } from '../../../../application/wine-search/presentation/agent-presentation.js';
import { AgentUseCase } from '../../../../application/wine-search/agent-usecase.js';
import type { WineSearchOrchestratorContract } from '../../../../application/wine-search/wine-search-orchestrator.js';
import type { AgentSessionService } from '../../../../application/wine-search/agent-session-service.js';

interface OrchestratorCall {
  input: Record<string, unknown>;
}

function buildFakeOrchestratorResult(): unknown {
  return {
    answer: 'an answer',
    executionSteps: [],
    toolCallCount: 0,
    totalDurationMs: 100,
    tokenUsage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    intent: 'wine_search',
    planKind: 'wine_agent_loop',
    terminationReason: 'final_answer',
    layer: 'agent',
    policyBlocked: false,
  };
}

/** Wrap mocked deps in a REAL AgentUseCase so the test exercises the actual
 *  delegation seam (the facade only ever sees `container.wineSearch.agentUseCase`). */
function makeUseCase(
  orchestratorExecute: (input: Record<string, unknown>) => Promise<unknown>,
  sessionService?: unknown,
): AgentUseCase {
  return new AgentUseCase({
    orchestrator: { execute: orchestratorExecute } as unknown as WineSearchOrchestratorContract,
    ...(sessionService !== undefined ? { sessionService: sessionService as AgentSessionService } : {}),
  });
}

describe('LocalAgentFacade', () => {
  it('throws CliError(execution) when wineSearch wiring is absent', async () => {
    const facade = new LocalAgentFacade({
      withContainer: async (work) => await work({ wineSearch: undefined } as never),
    });

    await expect(
      facade.run({ messages: [{ role: 'user', content: 'q' }] }, { requestId: 'req-1' }),
    ).rejects.toBeInstanceOf(CliError);
    await expect(
      facade.run({ messages: [{ role: 'user', content: 'q' }] }, { requestId: 'req-1' }),
    ).rejects.toMatchObject({
      kind: 'execution',
      message: expect.stringContaining('unavailable') as unknown as string,
    });
  });

  it('invokes the orchestrator with messages + requestId and omits unset optional fields', async () => {
    const calls: OrchestratorCall[] = [];
    const orchestratorResult = buildFakeOrchestratorResult();
    const facade = new LocalAgentFacade({
      withContainer: async (work) =>
        await work({
          wineSearch: {
            agentUseCase: makeUseCase(async (input) => {
              calls.push({ input });
              return orchestratorResult;
            }),
          },
        } as never),
    });

    await facade.run({ messages: [{ role: 'user', content: 'opus one' }] }, { requestId: 'req-2' });

    expect(calls).toHaveLength(1);
    // Messages-native, no `query` extraction; unset options/context/abort omitted.
    expect(calls[0]?.input).toEqual({
      messages: [{ role: 'user', content: 'opus one' }],
      requestId: 'req-2',
    });
    expect(Object.keys(calls[0]?.input ?? {}).sort()).toEqual(['messages', 'requestId']);
  });

  it('threads maxSteps / perStepTimeoutMs / agentTimeoutMs / maxTotalTokens / abortSignal through', async () => {
    const calls: OrchestratorCall[] = [];
    const facade = new LocalAgentFacade({
      withContainer: async (work) =>
        await work({
          wineSearch: {
            agentUseCase: makeUseCase(async (input) => {
              calls.push({ input });
              return buildFakeOrchestratorResult();
            }),
          },
        } as never),
    });
    const controller = new AbortController();

    await facade.run(
      {
        messages: [{ role: 'user', content: 'q' }],
        options: {
          maxSteps: 5,
          perStepTimeoutMs: 2000,
          agentTimeoutMs: 10000,
          maxTotalTokens: 30000,
        },
      },
      { requestId: 'req-3', abortSignal: controller.signal },
    );

    expect(calls[0]?.input).toEqual({
      messages: [{ role: 'user', content: 'q' }],
      requestId: 'req-3',
      options: {
        maxSteps: 5,
        perStepTimeoutMs: 2000,
        agentTimeoutMs: 10000,
        maxTotalTokens: 30000,
      },
      abortSignal: controller.signal,
    });
  });

  it('returns the orchestrator result mapped through mapWineSearchResultToResponse', async () => {
    const orchestratorResult = buildFakeOrchestratorResult();
    const facade = new LocalAgentFacade({
      withContainer: async (work) =>
        await work({
          wineSearch: { agentUseCase: makeUseCase(async () => orchestratorResult) },
        } as never),
    });

    const res = await facade.run({ messages: [{ role: 'user', content: 'q' }] }, { requestId: 'req-4' });

    expect(res).toEqual(
      mapWineSearchResultToResponse(
        orchestratorResult as Parameters<typeof mapWineSearchResultToResponse>[0],
        'req-4',
      ),
    );
  });

  it('fails closed for local sessions when no session service is wired', async () => {
    const facade = new LocalAgentFacade({
      withContainer: async (work) =>
        await work({ wineSearch: { agentUseCase: makeUseCase(async () => ({})) } } as never),
    });

    await expect(facade.startSession({}, { requestId: 'req-5' })).rejects.toMatchObject({
      kind: 'execution',
      message: expect.stringContaining('AGENT_SESSION_DB_PATH') as unknown as string,
    });
  });

  it('startSession delegates through the use case and returns the create wire shape (T-MTA-05)', async () => {
    const now = new Date('2026-05-30T00:00:00Z');
    const sessionRecord = {
      sessionId: 'sess-local-1',
      sessionVersion: 0,
      turns: [],
      createdAt: now,
      updatedAt: now,
      expiresAt: now,
    };
    const facade = new LocalAgentFacade({
      withContainer: async (work) =>
        await work({
          wineSearch: {
            agentUseCase: makeUseCase(async () => ({}), {
              createSession: async () => ({ kind: 'created', session: sessionRecord }),
            }),
          },
        } as never),
    });

    const body = await facade.startSession(
      { clientSessionId: 'cs-1' },
      { requestId: 'req-5' },
    ) as { session: { session_id: string; session_version: number }; replayed: boolean };
    expect(body.session.session_id).toBe('sess-local-1');
    expect(body.session.session_version).toBe(0);
    expect(body.replayed).toBe(false);
  });

  it('turnSession delegates through the use case and returns the turn wire shape (T-MTA-05)', async () => {
    const now = new Date('2026-05-30T00:00:00Z');
    const session = {
      sessionId: 'sess-local-2',
      sessionVersion: 1,
      turns: [],
      createdAt: now,
      updatedAt: now,
      expiresAt: now,
    };
    const turn = {
      turnIndex: 0,
      clientTurnId: 'turn-1',
      messages: [{ role: 'user' as const, content: 'q' }],
      historyApplied: [{ role: 'user' as const, content: 'q' }],
      result: buildFakeOrchestratorResult(),
      toolTraceSummary: [],
      createdAt: now,
    };
    const facade = new LocalAgentFacade({
      withContainer: async (work) =>
        await work({
          wineSearch: {
            agentUseCase: makeUseCase(async () => ({}), {
              runTurn: async () => ({ kind: 'appended', session, turn, result: turn.result, replayed: false }),
            }),
          },
        } as never),
    });

    const body = await facade.turnSession(
      { sessionId: 'sess-local-2', clientTurnId: 'turn-1', messages: [{ role: 'user', content: 'q' }] },
      { requestId: 'req-6' },
    ) as { session: { session_id: string }; turn: { turn_index: number; replayed: boolean }; history_applied: unknown[] };
    expect(body.session.session_id).toBe('sess-local-2');
    expect(body.turn.turn_index).toBe(0);
    expect(body.turn.replayed).toBe(false);
    expect(body.history_applied).toEqual([{ role: 'user', content: 'q' }]);
  });
});
