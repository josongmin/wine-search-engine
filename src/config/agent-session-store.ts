/**
 * Process-local, in-memory {@link AgentSessionStorePort} — a TEST SEAM ONLY
 * (T-MTA-03). Production multi-turn is served by the durable
 * {@link import('../infrastructure/db/agent-session-store.js').SqliteAgentSessionStore};
 * the composition root NEVER wires this one (it would lose history across
 * restarts/instances). Kept here so unit/integration tests can drive session
 * flows without a SQLite file.
 *
 * `computeAgentSessionExpiry` is the shared TTL policy and IS used in
 * production (injected into {@link AgentSessionService} by the container).
 */

import { randomUUID } from 'node:crypto';
import { MS_PER_DAY } from '@shared/utils/time-units.js';
import type {
  AgentSessionRecord,
  AgentSessionStorePort,
  AgentSessionTurn,
  AppendAgentTurnInput,
  AppendAgentTurnResult,
  CreateAgentSessionInput,
  CreateAgentSessionResult,
} from '../application/wine-search/port/agent-session-store.port.js';

const DEFAULT_AGENT_SESSION_TTL_MS = MS_PER_DAY;

interface AgentSessionStoreClock {
  readonly now: () => Date;
}

interface AgentSessionStoreOptions {
  readonly clock?: AgentSessionStoreClock | undefined;
}

interface StoredSessionEntry {
  readonly clientSessionId?: string | undefined;
  readonly session: AgentSessionRecord;
}

function cloneRecord<T>(value: T): T {
  return structuredClone(value);
}

export function computeAgentSessionExpiry(
  now: Date,
  ttlMs = DEFAULT_AGENT_SESSION_TTL_MS,
): Date {
  return new Date(now.getTime() + ttlMs);
}

class ProcessLocalAgentSessionStore implements AgentSessionStorePort {
  private readonly sessions = new Map<string, StoredSessionEntry>();
  private readonly clientSessionIndex = new Map<string, string>();
  private readonly clock: AgentSessionStoreClock;

  constructor(clock?: AgentSessionStoreClock) {
    this.clock = clock ?? { now: () => new Date() };
  }

  // In-memory store; the port is async (provider-agnostic). No `await` here.
  // eslint-disable-next-line @typescript-eslint/require-await
  async createSession(input: CreateAgentSessionInput): Promise<CreateAgentSessionResult> {
    const now = this.clock.now();

    if (input.clientSessionId !== undefined) {
      const existingSessionId = this.clientSessionIndex.get(input.clientSessionId);
      if (existingSessionId !== undefined) {
        const existing = this.readLiveEntry(existingSessionId, now);
        if (existing !== null) {
          return { kind: 'idempotent_replay', session: cloneRecord(existing.session) };
        }
      }
    }

    const sessionId = randomUUID();
    const session: AgentSessionRecord = {
      sessionId,
      sessionVersion: 0,
      ...(input.context !== undefined ? { context: cloneRecord(input.context) } : {}),
      ...(input.options !== undefined ? { options: cloneRecord(input.options) } : {}),
      turns: [],
      createdAt: new Date(now),
      updatedAt: new Date(now),
      expiresAt: new Date(input.expiresAt),
    };
    this.sessions.set(sessionId, {
      clientSessionId: input.clientSessionId,
      session,
    });
    if (input.clientSessionId !== undefined) {
      this.clientSessionIndex.set(input.clientSessionId, sessionId);
    }
    return { kind: 'created', session: cloneRecord(session) };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async appendTurn(input: AppendAgentTurnInput): Promise<AppendAgentTurnResult> {
    const now = this.clock.now();
    const entry = this.readLiveEntry(input.sessionId, now);
    if (entry === null) {
      return { kind: 'session_not_found' };
    }

    const current = entry.session;

    // Idempotent replay FIRST: a retry of an already-applied clientTurnId is
    // not a conflict even if the caller now passes a stale expectedSessionVersion
    // (it never observed the first success). MUST match the SQLite store's
    // ordering exactly — the two AgentSessionStorePort impls are one behavioral
    // contract (CLAUDE.md rule 30); a store-parity test pins this.
    const replayedTurn = current.turns.find((turn) => turn.clientTurnId === input.clientTurnId);
    if (replayedTurn !== undefined) {
      return {
        kind: 'idempotent_replay',
        session: cloneRecord(current),
        turn: cloneRecord(replayedTurn),
      };
    }

    // Optimistic concurrency: reject a stale expected version (new turn only).
    if (
      input.expectedSessionVersion !== undefined
      && current.sessionVersion !== input.expectedSessionVersion
    ) {
      return {
        kind: 'version_conflict',
        currentVersion: current.sessionVersion,
      };
    }

    const nextTurn: AgentSessionTurn = {
      turnIndex: current.turns.length,
      clientTurnId: input.clientTurnId,
      messages: cloneRecord(input.messages),
      historyApplied: cloneRecord(input.historyApplied),
      result: cloneRecord(input.result),
      toolTraceSummary: cloneRecord(input.toolTraceSummary),
      createdAt: new Date(now),
    };

    const nextSession: AgentSessionRecord = {
      ...current,
      turns: [...current.turns, nextTurn],
      sessionVersion: current.sessionVersion + 1,
      updatedAt: new Date(now),
      expiresAt: new Date(input.expiresAt),
    };
    this.sessions.set(input.sessionId, {
      clientSessionId: entry.clientSessionId,
      session: nextSession,
    });
    return {
      kind: 'appended',
      session: cloneRecord(nextSession),
      turn: cloneRecord(nextTurn),
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getSession(sessionId: string): Promise<AgentSessionRecord | null> {
    const entry = this.readLiveEntry(sessionId, this.clock.now());
    return entry === null ? null : cloneRecord(entry.session);
  }

  private readLiveEntry(sessionId: string, now: Date): StoredSessionEntry | null {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) {
      return null;
    }
    if (entry.session.expiresAt.getTime() <= now.getTime()) {
      this.sessions.delete(sessionId);
      if (entry.clientSessionId !== undefined) {
        this.clientSessionIndex.delete(entry.clientSessionId);
      }
      return null;
    }
    return entry;
  }
}

export function createProcessLocalAgentSessionStore(
  options?: AgentSessionStoreOptions,
): AgentSessionStorePort {
  return new ProcessLocalAgentSessionStore(options?.clock);
}
