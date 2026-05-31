import { describe, expect, it, vi } from 'vitest';
import { AgentUseCase } from '../agent-usecase.js';
import { AgentSessionService } from '../agent-session-service.js';
import {
  computeAgentSessionExpiry,
  createProcessLocalAgentSessionStore,
} from '../../../config/agent-session-store.js';
import { DomainError } from '../../../domain/shared/error/domain-error.js';
import type { WineSearchInput, WineSearchOrchestratorContract } from '../wine-search-orchestrator.js';
import type { WineSearchResult } from '../wine-search-result-schemas.js';

function makeResult(answer = 'ok'): WineSearchResult {
  return {
    answer,
    layer: 'primary',
    groundedOnToolResults: true,
    toolOutcomes: [],
    executionSteps: [],
    toolCallCount: 0,
    tokenUsage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    totalDurationMs: 1,
    terminationReason: 'answer',
    policyBlocked: false,
    intent: 'search',
    planKind: 'single-search',
  };
}

function makeUseCase(opts?: { withSessions?: boolean; execute?: (i: WineSearchInput) => Promise<WineSearchResult> }) {
  const execute = vi.fn(opts?.execute ?? (async () => makeResult()));
  const orchestrator: WineSearchOrchestratorContract = { execute };
  const useCase = new AgentUseCase({
    orchestrator,
    ...(opts?.withSessions === true
      ? {
          sessionService: new AgentSessionService({
            store: createProcessLocalAgentSessionStore(),
            orchestrator,
            computeExpiry: (now) => computeAgentSessionExpiry(now),
          }),
        }
      : {}),
  });
  return { useCase, execute };
}

describe('AgentUseCase — single seam guards', () => {
  it('run() throws INVALID_REQUEST when messages is empty (before touching orchestrator)', async () => {
    const { useCase, execute } = makeUseCase();
    await expect(useCase.run({ messages: [], requestId: 'r1' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('run() throws INVALID_REQUEST when there is no user-role message (assistant-only)', async () => {
    const { useCase, execute } = makeUseCase();
    await expect(
      useCase.run({ messages: [{ role: 'assistant', content: 'hi' }], requestId: 'r1' }),
    ).rejects.toBeInstanceOf(DomainError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('run() delegates to the orchestrator on a valid conversation', async () => {
    const { useCase, execute } = makeUseCase();
    const result = await useCase.run({
      messages: [{ role: 'user', content: 'recommend a Burgundy' }],
      requestId: 'r1',
    });
    expect(result.answer).toBe('ok');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      messages: [{ role: 'user', content: 'recommend a Burgundy' }],
      requestId: 'r1',
    });
  });

  it('session ops throw SERVICE_UNAVAILABLE (→503) when no store is wired', async () => {
    const { useCase } = makeUseCase({ withSessions: false });
    await expect(useCase.createSession({})).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    await expect(useCase.getSession('s1')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    await expect(
      useCase.runTurn({
        sessionId: 's1',
        clientTurnId: 't1',
        messages: [{ role: 'user', content: 'q' }],
        requestId: 'r1',
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('runTurn() throws INVALID_REQUEST for a turn with no user message (store wired)', async () => {
    const { useCase, execute } = makeUseCase({ withSessions: true });
    const created = await useCase.createSession({ clientSessionId: 'cs-1' });
    if (created.kind !== 'created') throw new Error('expected created');
    await expect(
      useCase.runTurn({
        sessionId: created.session.sessionId,
        clientTurnId: 't1',
        messages: [{ role: 'assistant', content: 'x' }],
        requestId: 'r1',
        expectedSessionVersion: 0,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('createSession + runTurn delegate end-to-end when the store is wired', async () => {
    const { useCase } = makeUseCase({ withSessions: true });
    const created = await useCase.createSession({ clientSessionId: 'cs-2' });
    if (created.kind !== 'created') throw new Error('expected created');
    const outcome = await useCase.runTurn({
      sessionId: created.session.sessionId,
      clientTurnId: 't1',
      messages: [{ role: 'user', content: 'q' }],
      requestId: 'r1',
      expectedSessionVersion: 0,
    });
    expect(outcome.kind).toBe('appended');
    const fetched = await useCase.getSession(created.session.sessionId);
    expect(fetched?.turns).toHaveLength(1);
  });
});
