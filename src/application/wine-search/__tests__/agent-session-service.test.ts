import { describe, expect, it, vi } from 'vitest';
import { AgentSessionService } from '../agent-session-service.js';
import {
  computeAgentSessionExpiry,
  createProcessLocalAgentSessionStore,
} from '../../../config/agent-session-store.js';
import { createSqliteAgentSessionStore } from '../../../infrastructure/db/agent-session-store.js';
import { ORCHESTRATOR_MAX_HISTORY_APPLIED } from '../wine-search-result-schemas.js';
import type { WineSearchInput, WineSearchOrchestratorContract } from '../wine-search-orchestrator.js';
import type { WineSearchResult } from '../wine-search-result-schemas.js';

function makeResult(answer: string): WineSearchResult {
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

function buildService(
  execute: (input: WineSearchInput) => Promise<WineSearchResult>,
) {
  const orchestrator: WineSearchOrchestratorContract = { execute: vi.fn(execute) };
  const store = createProcessLocalAgentSessionStore();
  const service = new AgentSessionService({
    store,
    orchestrator,
    computeExpiry: (now) => computeAgentSessionExpiry(now),
  });
  return { service, orchestrator, store };
}

describe('AgentSessionService — server-managed history custody (T-MTA-02)', () => {
  it('persists BOTH the user messages and the synthesized assistant answer per turn', async () => {
    const { service } = buildService(async () => makeResult('첫 답변입니다.'));
    const created = await service.createSession({ clientSessionId: 'cs-1' });
    const outcome = await service.runTurn({
      sessionId: created.session.sessionId,
      clientTurnId: 't-1',
      messages: [{ role: 'user', content: '부르고뉴 추천' }],
      requestId: 'req-1',
      expectedSessionVersion: 0,
    });

    expect(outcome.kind).toBe('appended');
    if (outcome.kind !== 'appended') return;
    // The persisted turn transcript is user + assistant — NOT user-only.
    expect(outcome.turn.messages).toEqual([
      { role: 'user', content: '부르고뉴 추천' },
      { role: 'assistant', content: '첫 답변입니다.' },
    ]);
    expect(outcome.session.sessionVersion).toBe(1);
  });

  it('feeds the prior transcript (user + assistant) to the orchestrator on the next turn', async () => {
    const { service, orchestrator } = buildService(async () => makeResult('답변'));
    const created = await service.createSession({ clientSessionId: 'cs-2' });
    await service.runTurn({
      sessionId: created.session.sessionId,
      clientTurnId: 't-1',
      messages: [{ role: 'user', content: '부르고뉴 추천' }],
      requestId: 'req-1',
      expectedSessionVersion: 0,
    });
    await service.runTurn({
      sessionId: created.session.sessionId,
      clientTurnId: 't-2',
      messages: [{ role: 'user', content: '10만원 이하로' }],
      requestId: 'req-2',
      expectedSessionVersion: 1,
    });

    const secondCall = (orchestrator.execute as ReturnType<typeof vi.fn>).mock.calls[1]?.[0] as WineSearchInput;
    expect(secondCall.messages).toEqual([
      { role: 'user', content: '부르고뉴 추천' },
      { role: 'assistant', content: '답변' },
      { role: 'user', content: '10만원 이하로' },
    ]);
  });

  it('replays an existing clientTurnId WITHOUT re-running the orchestrator', async () => {
    const { service, orchestrator } = buildService(async () => makeResult('한 번만'));
    const created = await service.createSession({ clientSessionId: 'cs-3' });
    await service.runTurn({
      sessionId: created.session.sessionId,
      clientTurnId: 't-1',
      messages: [{ role: 'user', content: 'q' }],
      requestId: 'req-1',
      expectedSessionVersion: 0,
    });
    const replay = await service.runTurn({
      sessionId: created.session.sessionId,
      clientTurnId: 't-1',
      messages: [{ role: 'user', content: 'q' }],
      requestId: 'req-2',
    });

    expect(replay.kind).toBe('idempotent_replay');
    if (replay.kind === 'idempotent_replay') expect(replay.replayed).toBe(true);
    // Orchestrator ran exactly once across the original + replay.
    expect((orchestrator.execute as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('fails closed on a stale expected_session_version WITHOUT running the orchestrator', async () => {
    const { service, orchestrator } = buildService(async () => makeResult('x'));
    const created = await service.createSession({ clientSessionId: 'cs-4' });
    await service.runTurn({
      sessionId: created.session.sessionId,
      clientTurnId: 't-1',
      messages: [{ role: 'user', content: 'q' }],
      requestId: 'req-1',
      expectedSessionVersion: 0,
    });
    const conflict = await service.runTurn({
      sessionId: created.session.sessionId,
      clientTurnId: 't-2',
      messages: [{ role: 'user', content: 'q2' }],
      requestId: 'req-2',
      expectedSessionVersion: 0, // stale — session is now at version 1
    });

    expect(conflict.kind).toBe('version_conflict');
    if (conflict.kind === 'version_conflict') expect(conflict.currentVersion).toBe(1);
    // Only the first turn hit the orchestrator; the stale turn did not.
    expect((orchestrator.execute as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('returns session_not_found for an unknown session', async () => {
    const { service, orchestrator } = buildService(async () => makeResult('x'));
    const outcome = await service.runTurn({
      sessionId: 'does-not-exist',
      clientTurnId: 't-1',
      messages: [{ role: 'user', content: 'q' }],
      requestId: 'req-1',
    });
    expect(outcome.kind).toBe('session_not_found');
    expect((orchestrator.execute as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('windows history so a long session never overflows the cap or bricks on read (SQLite, T-MTA-07 fix)', async () => {
    const orchestrator = { execute: vi.fn(async () => makeResult('ok')) };
    const store = createSqliteAgentSessionStore({ path: ':memory:' });
    const service = new AgentSessionService({
      store,
      orchestrator,
      computeExpiry: (now) => computeAgentSessionExpiry(now),
    });
    const created = await service.createSession({ clientSessionId: 'cs-long' });
    const sessionId = created.session.sessionId;

    // Each turn persists 2 messages (user + assistant); 80 turns = 160 > 128.
    let lastHistoryLen = 0;
    for (let i = 0; i < 80; i += 1) {
      const outcome = await service.runTurn({
        sessionId,
        clientTurnId: `t-${String(i)}`,
        messages: [{ role: 'user', content: `turn ${String(i)}` }],
        requestId: `req-${String(i)}`,
        expectedSessionVersion: i,
      });
      expect(outcome.kind).toBe('appended');
      if (outcome.kind === 'appended') {
        lastHistoryLen = outcome.turn.historyApplied.length;
      }
    }

    // History stayed bounded by the cap (no unbounded growth).
    expect(lastHistoryLen).toBeLessThanOrEqual(ORCHESTRATOR_MAX_HISTORY_APPLIED);
    // The session is still READABLE — the store re-validates the persisted
    // result on read, which would throw if historyApplied exceeded the cap.
    const fetched = await store.getSession(sessionId);
    expect(fetched).not.toBeNull();
    expect(fetched?.sessionVersion).toBe(80);
    // The orchestrator received the windowed (bounded) conversation each turn.
    const lastCall = orchestrator.execute.mock.calls.at(-1)?.[0] as { messages: unknown[] };
    expect(lastCall.messages.length).toBeLessThanOrEqual(ORCHESTRATOR_MAX_HISTORY_APPLIED);
  });

  it('merges session-level options with per-turn overrides (turn wins)', async () => {
    const { service, orchestrator } = buildService(async () => makeResult('x'));
    const created = await service.createSession({
      clientSessionId: 'cs-5',
      options: { maxSteps: 4, maxTotalTokens: 20_000 },
    });
    await service.runTurn({
      sessionId: created.session.sessionId,
      clientTurnId: 't-1',
      messages: [{ role: 'user', content: 'q' }],
      requestId: 'req-1',
      options: { maxSteps: 7 },
      expectedSessionVersion: 0,
    });
    const call = (orchestrator.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as WineSearchInput;
    expect(call.options).toEqual({ maxSteps: 7, maxTotalTokens: 20_000 });
  });
});
