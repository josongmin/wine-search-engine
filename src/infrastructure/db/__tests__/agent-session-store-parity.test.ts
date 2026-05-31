import { describe, expect, it } from 'vitest';
import { createSqliteAgentSessionStore } from '../agent-session-store.js';
import { createProcessLocalAgentSessionStore } from '../../../config/agent-session-store.js';
import type {
  AgentSessionStorePort,
  AppendAgentTurnInput,
} from '../../../application/wine-search/port/agent-session-store.port.js';
import type { WineSearchResult } from '../../../application/wine-search/wine-search-result-schemas.js';

/**
 * Store parity (audit H2): the SQLite store (production) and the process-local
 * store (test seam) are ONE behavioral contract (CLAUDE.md rule 30). The same
 * command sequence MUST yield identical result discriminants on both — otherwise
 * unit tests running on the process-local store silently mask SQLite-only
 * behavior. This was a real divergence: SQLite checked idempotent-replay before
 * version, process-local checked version first.
 */

const FUTURE = new Date('2999-01-01T00:00:00Z');

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

function makeAppendInput(
  sessionId: string,
  clientTurnId: string,
  expectedSessionVersion: number,
): AppendAgentTurnInput {
  return {
    sessionId,
    clientTurnId,
    messages: [{ role: 'user', content: 'q' }],
    historyApplied: [{ role: 'user', content: 'q' }],
    result: makeResult(),
    toolTraceSummary: [],
    expectedSessionVersion,
    expiresAt: FUTURE,
  };
}

const variants: ReadonlyArray<readonly [string, () => AgentSessionStorePort]> = [
  ['process-local', () => createProcessLocalAgentSessionStore()],
  ['sqlite', () => createSqliteAgentSessionStore({ path: ':memory:' })],
];

describe('AgentSessionStorePort — process-local ↔ SQLite parity (H2)', () => {
  for (const [name, make] of variants) {
    it(`[${name}] idempotent replay wins over a stale expectedSessionVersion`, async () => {
      const store = make();
      const created = await store.createSession({ clientSessionId: 'cs', expiresAt: FUTURE });
      const sid = created.session.sessionId;
      const first = await store.appendTurn(makeAppendInput(sid, 't1', 0));
      expect(first.kind).toBe('appended');
      await store.appendTurn(makeAppendInput(sid, 't2', 1));
      // Replay t1 with now-stale version 0 → replay wins (NOT version_conflict).
      const replay = await store.appendTurn(makeAppendInput(sid, 't1', 0));
      expect(replay.kind).toBe('idempotent_replay');
      store.close?.();
    });

    it(`[${name}] version_conflict for a NEW turn with a stale version`, async () => {
      const store = make();
      const created = await store.createSession({ clientSessionId: 'cs', expiresAt: FUTURE });
      const sid = created.session.sessionId;
      await store.appendTurn(makeAppendInput(sid, 't1', 0));
      // New clientTurnId with stale version → conflict.
      const conflict = await store.appendTurn(makeAppendInput(sid, 't2', 0));
      expect(conflict.kind).toBe('version_conflict');
      store.close?.();
    });

    it(`[${name}] createSession idempotent by clientSessionId`, async () => {
      const store = make();
      const a = await store.createSession({ clientSessionId: 'cs', expiresAt: FUTURE });
      const b = await store.createSession({ clientSessionId: 'cs', expiresAt: FUTURE });
      expect(b.kind).toBe('idempotent_replay');
      expect(b.session.sessionId).toBe(a.session.sessionId);
      store.close?.();
    });

    it(`[${name}] appendTurn on unknown session → session_not_found`, async () => {
      const store = make();
      const r = await store.appendTurn(makeAppendInput('nope', 't1', 0));
      expect(r.kind).toBe('session_not_found');
      store.close?.();
    });
  }
});
