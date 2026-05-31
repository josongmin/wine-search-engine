import { describe, expect, it } from 'vitest';
import { createSqliteAgentSessionStore } from '../agent-session-store.js';
import type { AgentSessionStorePort } from '../../../application/wine-search/port/agent-session-store.port.js';
import type { WineSearchResult } from '../../../application/wine-search/wine-search-result-schemas.js';

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

class MutableClock {
  constructor(private ms: number) {}
  now(): Date {
    return new Date(this.ms);
  }
  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
}

function buildStore(clock?: MutableClock): AgentSessionStorePort {
  // `:memory:` is a real SQLite engine — exercises the actual transaction,
  // unique-constraint, and JSON round-trip paths, just without a file.
  return createSqliteAgentSessionStore({
    path: ':memory:',
    ...(clock !== undefined ? { clock } : {}),
  });
}

const FAR_FUTURE = new Date('2099-01-01T00:00:00Z');

describe('SqliteAgentSessionStore — persistence contract (T-MTA-03)', () => {
  it('createSession is idempotent on clientSessionId', async () => {
    const store = buildStore();
    const a = await store.createSession({ clientSessionId: 'cs-1', expiresAt: FAR_FUTURE });
    const b = await store.createSession({ clientSessionId: 'cs-1', expiresAt: FAR_FUTURE });
    expect(a.kind).toBe('created');
    expect(b.kind).toBe('idempotent_replay');
    expect(b.session.sessionId).toBe(a.session.sessionId);
  });

  it('appendTurn persists transcript + result, bumps version, round-trips through JSON', async () => {
    const store = buildStore();
    const created = await store.createSession({ expiresAt: FAR_FUTURE });
    const res = makeResult('첫 답변');
    const appended = await store.appendTurn({
      sessionId: created.session.sessionId,
      clientTurnId: 't-1',
      messages: [
        { role: 'user', content: '부르고뉴 추천' },
        { role: 'assistant', content: '첫 답변' },
      ],
      historyApplied: [{ role: 'user', content: '부르고뉴 추천' }],
      result: res,
      toolTraceSummary: [{ tool: 'search_hybrid', outcome: 'observed' }],
      expectedSessionVersion: 0,
      expiresAt: FAR_FUTURE,
    });
    expect(appended.kind).toBe('appended');
    if (appended.kind !== 'appended') return;
    expect(appended.session.sessionVersion).toBe(1);
    expect(appended.turn.turnIndex).toBe(0);

    const fetched = await store.getSession(created.session.sessionId);
    expect(fetched?.turns).toHaveLength(1);
    expect(fetched?.turns[0]?.messages).toEqual([
      { role: 'user', content: '부르고뉴 추천' },
      { role: 'assistant', content: '첫 답변' },
    ]);
    expect(fetched?.turns[0]?.result.answer).toBe('첫 답변');
    expect(fetched?.turns[0]?.toolTraceSummary).toEqual([{ tool: 'search_hybrid', outcome: 'observed' }]);
  });

  it('appendTurn is idempotent on clientTurnId (no double append)', async () => {
    const store = buildStore();
    const created = await store.createSession({ expiresAt: FAR_FUTURE });
    const base = {
      sessionId: created.session.sessionId,
      clientTurnId: 't-1',
      messages: [{ role: 'user' as const, content: 'q' }],
      historyApplied: [{ role: 'user' as const, content: 'q' }],
      result: makeResult('a'),
      toolTraceSummary: [],
      expiresAt: FAR_FUTURE,
    };
    const first = await store.appendTurn({ ...base, expectedSessionVersion: 0 });
    const replay = await store.appendTurn({ ...base, expectedSessionVersion: 0 });
    expect(first.kind).toBe('appended');
    expect(replay.kind).toBe('idempotent_replay');
    const fetched = await store.getSession(created.session.sessionId);
    expect(fetched?.sessionVersion).toBe(1);
    expect(fetched?.turns).toHaveLength(1);
  });

  it('appendTurn fails closed on a stale expected_session_version', async () => {
    const store = buildStore();
    const created = await store.createSession({ expiresAt: FAR_FUTURE });
    await store.appendTurn({
      sessionId: created.session.sessionId,
      clientTurnId: 't-1',
      messages: [{ role: 'user', content: 'q' }],
      historyApplied: [{ role: 'user', content: 'q' }],
      result: makeResult('a'),
      toolTraceSummary: [],
      expectedSessionVersion: 0,
      expiresAt: FAR_FUTURE,
    });
    const conflict = await store.appendTurn({
      sessionId: created.session.sessionId,
      clientTurnId: 't-2',
      messages: [{ role: 'user', content: 'q2' }],
      historyApplied: [{ role: 'user', content: 'q2' }],
      result: makeResult('b'),
      toolTraceSummary: [],
      expectedSessionVersion: 0, // stale: session is now at version 1
      expiresAt: FAR_FUTURE,
    });
    expect(conflict.kind).toBe('version_conflict');
    if (conflict.kind === 'version_conflict') expect(conflict.currentVersion).toBe(1);
    // The stale append must NOT have been written.
    const fetched = await store.getSession(created.session.sessionId);
    expect(fetched?.turns).toHaveLength(1);
  });

  it('appendTurn / getSession return session_not_found / null for unknown ids', async () => {
    const store = buildStore();
    const missing = await store.appendTurn({
      sessionId: 'nope',
      clientTurnId: 't-1',
      messages: [{ role: 'user', content: 'q' }],
      historyApplied: [],
      result: makeResult('a'),
      toolTraceSummary: [],
      expiresAt: FAR_FUTURE,
    });
    expect(missing.kind).toBe('session_not_found');
    expect(await store.getSession('nope')).toBeNull();
  });

  it('honors TTL — an expired session reads as absent and frees its clientSessionId', async () => {
    const clock = new MutableClock(1_000);
    const store = buildStore(clock);
    const created = await store.createSession({
      clientSessionId: 'cs-ttl',
      expiresAt: new Date(2_000),
    });
    expect(await store.getSession(created.session.sessionId)).not.toBeNull();

    clock.advance(5_000); // now well past expiresAt
    expect(await store.getSession(created.session.sessionId)).toBeNull();

    // Re-creating with the same clientSessionId after expiry mints a NEW session.
    const recreated = await store.createSession({
      clientSessionId: 'cs-ttl',
      expiresAt: new Date(clock.now().getTime() + 10_000),
    });
    expect(recreated.kind).toBe('created');
    expect(recreated.session.sessionId).not.toBe(created.session.sessionId);
  });
});
