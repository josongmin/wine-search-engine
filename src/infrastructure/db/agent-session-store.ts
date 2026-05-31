/**
 * SqliteAgentSessionStore — durable {@link AgentSessionStorePort} backed by
 * SQLite via Node's built-in `node:sqlite` driver (T-MTA-03).
 *
 * SOLID / abstraction notes:
 *   - This is the ONLY module that knows about SQLite. Everything upstream
 *     (the service, routes, CLI) depends on the `AgentSessionStorePort`
 *     abstraction, so the storage engine is swappable without touching them.
 *   - The constructor takes an already-open `DatabaseSync` handle (dependency
 *     inversion) so tests can drive an in-memory DB and production can inject a
 *     file-backed one. The `createSqliteAgentSessionStore` factory wires the
 *     concrete handle + schema.
 *   - The port's two correctness guarantees are enforced HERE, atomically:
 *       · idempotent create (unique `client_session_id`)
 *       · idempotent append (unique `(session_id, client_turn_id)`)
 *       · optimistic concurrency (`expected_session_version` re-checked inside
 *         the append transaction — never last-write-wins).
 *   - Lazy TTL: expired rows are treated as absent on read and swept.
 *   - Rows are persisted as JSON TEXT and VALIDATED on read with Zod
 *     (CLAUDE.md rules 11/12 — JSONB/JSON.parse never cast with `as`). A
 *     validation failure means on-disk corruption and throws (fail-closed).
 */

import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type {
  AgentSessionRecord,
  AgentSessionStorePort,
  AgentSessionTurn,
  AppendAgentTurnInput,
  AppendAgentTurnResult,
  CreateAgentSessionInput,
  CreateAgentSessionResult,
} from '../../application/wine-search/port/agent-session-store.port.js';
import {
  AgentMessageSchema,
  type AgentMessage,
} from '../../application/wine-search/wine-search-schemas.js';
import {
  ORCHESTRATOR_MAX_HISTORY_APPLIED,
  WineSearchResultSchema,
} from '../../application/wine-search/wine-search-result-schemas.js';

// ---------------------------------------------------------------------------
// On-disk JSON validation schemas (CLAUDE.md rule 12)
// ---------------------------------------------------------------------------

/** Upper bound on the per-turn tool-trace summary array. A single turn cannot
 *  emit more tool calls than the orchestrator's per-step cap allows; 64 is a
 *  generous ceiling that rejects a corrupt/oversized array. */
const MAX_STORED_TOOL_TRACE_ENTRIES = 64;

/** SQLite `busy_timeout` (ms) — how long a writer waits for a lock before
 *  giving up. 5s lets concurrent appends (BEGIN IMMEDIATE) serialize on a
 *  shared file rather than failing fast under brief contention. */
const SQLITE_BUSY_TIMEOUT_MS = 5_000;

const StoredToolTraceEntrySchema = z.object({
  tool: z.string(),
  outcome: z.string(),
}).strict();

const StoredContextSchema = z.object({
  locale: z.string().optional(),
  currency: z.string().optional(),
}).strict();

const StoredOptionsSchema = z.object({
  maxSteps: z.number().int().optional(),
  perStepTimeoutMs: z.number().int().optional(),
  agentTimeoutMs: z.number().int().optional(),
  maxTotalTokens: z.number().int().optional(),
}).strict();

/** The JSON payload persisted per turn (everything except the columns we
 *  index on: turn_index, client_turn_id, created_at). Arrays are bounded
 *  (schema-quality bar) so a corrupt/oversized on-disk payload is rejected.
 *  Message shape comes from the canonical {@link AgentMessageSchema} (SSoT). */
const StoredTurnPayloadSchema = z.object({
  messages: z.array(AgentMessageSchema).max(ORCHESTRATOR_MAX_HISTORY_APPLIED),
  historyApplied: z.array(AgentMessageSchema).max(ORCHESTRATOR_MAX_HISTORY_APPLIED),
  result: WineSearchResultSchema,
  toolTraceSummary: z.array(StoredToolTraceEntrySchema).max(MAX_STORED_TOOL_TRACE_ENTRIES),
}).strict();

interface SqliteAgentSessionStoreClock {
  readonly now: () => Date;
}

// ---------------------------------------------------------------------------
// Row shapes (as returned by node:sqlite — plain objects)
// ---------------------------------------------------------------------------

interface SessionRow {
  readonly session_id: string;
  readonly client_session_id: string | null;
  readonly session_version: number;
  readonly context: string | null;
  readonly options: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly expires_at: number;
}

interface TurnRow {
  readonly turn_index: number;
  readonly client_turn_id: string;
  readonly payload: string;
  readonly created_at: number;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_sessions (
  session_id        TEXT PRIMARY KEY,
  client_session_id TEXT UNIQUE,
  session_version   INTEGER NOT NULL,
  context           TEXT,
  options           TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_session_turns (
  session_id     TEXT NOT NULL,
  turn_index     INTEGER NOT NULL,
  client_turn_id TEXT NOT NULL,
  payload        TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (session_id, turn_index),
  UNIQUE (session_id, client_turn_id),
  FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_expires_at ON agent_sessions(expires_at);
`;

function parseJson<T>(raw: string, schema: z.ZodType<T>, what: string): T {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new Error(`[sqlite-agent-session-store] corrupt ${what} JSON: ${(err as Error).message}`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `[sqlite-agent-session-store] ${what} failed validation: ${parsed.error.issues
        .slice(0, 3)
        .map((iss) => `${iss.path.join('.')}: ${iss.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

export class SqliteAgentSessionStore implements AgentSessionStorePort {
  private readonly db: DatabaseSync;
  private readonly clock: SqliteAgentSessionStoreClock;

  constructor(db: DatabaseSync, clock?: SqliteAgentSessionStoreClock) {
    this.db = db;
    this.clock = clock ?? { now: () => new Date() };
  }

  // node:sqlite is synchronous; the port is async (provider-agnostic). The
  // method bodies have no `await` but MUST satisfy the Promise-returning port.
  // eslint-disable-next-line @typescript-eslint/require-await
  async createSession(input: CreateAgentSessionInput): Promise<CreateAgentSessionResult> {
    const now = this.clock.now();

    if (input.clientSessionId !== undefined) {
      const existing = this.readLiveSessionByClientId(input.clientSessionId, now);
      if (existing !== null) {
        return { kind: 'idempotent_replay', session: existing };
      }
    }

    const sessionId = randomUUID();
    // `ON CONFLICT DO NOTHING` makes the create idempotent even under a
    // cross-process race on the same SQLite file (two instances both saw no
    // existing row): the loser inserts zero rows instead of throwing a UNIQUE
    // violation, and we then return the winner's row as an idempotent replay
    // (audit T-MTA-07). Only `client_session_id` can conflict; the random
    // `session_id` never does.
    const insert = this.db
      .prepare(
        `INSERT INTO agent_sessions
           (session_id, client_session_id, session_version, context, options, created_at, updated_at, expires_at)
         VALUES (?, ?, 0, ?, ?, ?, ?, ?)
         ON CONFLICT(client_session_id) DO NOTHING`,
      )
      .run(
        sessionId,
        input.clientSessionId ?? null,
        input.context !== undefined ? JSON.stringify(input.context) : null,
        input.options !== undefined ? JSON.stringify(input.options) : null,
        now.getTime(),
        now.getTime(),
        input.expiresAt.getTime(),
      );

    if (insert.changes === 0) {
      // A concurrent create won the race on this client_session_id — return its
      // row as an idempotent replay rather than a spurious error.
      const existing = input.clientSessionId !== undefined
        ? this.readLiveSessionByClientId(input.clientSessionId, now)
        : null;
      if (existing !== null) {
        return { kind: 'idempotent_replay', session: existing };
      }
      throw new Error('[sqlite-agent-session-store] create conflicted but no live row found');
    }

    const created = this.readSessionRecord(sessionId);
    // Invariant: we just inserted it, so it must read back.
    if (created === null) {
      throw new Error('[sqlite-agent-session-store] failed to read back created session');
    }
    return { kind: 'created', session: created };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async appendTurn(input: AppendAgentTurnInput): Promise<AppendAgentTurnResult> {
    const now = this.clock.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const sessionRow = this.readLiveSessionRow(input.sessionId, now);
      if (sessionRow === null) {
        this.db.exec('ROLLBACK');
        return { kind: 'session_not_found' };
      }

      // Idempotent replay — same clientTurnId returns the persisted turn, no write.
      const existingTurn = this.readTurnByClientId(input.sessionId, input.clientTurnId);
      if (existingTurn !== null) {
        const session = this.readSessionRecord(input.sessionId);
        this.db.exec('ROLLBACK');
        if (session === null) {
          throw new Error('[sqlite-agent-session-store] session vanished mid-replay');
        }
        return { kind: 'idempotent_replay', session, turn: existingTurn };
      }

      // Optimistic concurrency — re-checked atomically inside the transaction.
      if (
        input.expectedSessionVersion !== undefined
        && sessionRow.session_version !== input.expectedSessionVersion
      ) {
        const currentVersion = sessionRow.session_version;
        this.db.exec('ROLLBACK');
        return { kind: 'version_conflict', currentVersion };
      }

      const turnIndex = sessionRow.session_version;
      const payload = JSON.stringify({
        messages: input.messages,
        historyApplied: input.historyApplied,
        result: input.result,
        toolTraceSummary: input.toolTraceSummary,
      });
      this.db
        .prepare(
          `INSERT INTO agent_session_turns
             (session_id, turn_index, client_turn_id, payload, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.sessionId, turnIndex, input.clientTurnId, payload, now.getTime());
      this.db
        .prepare(
          `UPDATE agent_sessions
              SET session_version = session_version + 1, updated_at = ?, expires_at = ?
            WHERE session_id = ?`,
        )
        .run(now.getTime(), input.expiresAt.getTime(), input.sessionId);

      this.db.exec('COMMIT');

      const session = this.readSessionRecord(input.sessionId);
      const turn = this.readTurnByClientId(input.sessionId, input.clientTurnId);
      if (session === null || turn === null) {
        throw new Error('[sqlite-agent-session-store] failed to read back appended turn');
      }
      return { kind: 'appended', session, turn };
    } catch (err) {
      // Best-effort rollback if we threw mid-transaction.
      try {
        this.db.exec('ROLLBACK');
      } catch (rollbackErr) {
        // Intentional: the transaction may already be rolled back / committed
        // (e.g. a prior ROLLBACK ran). Swallow so the ORIGINAL error wins.
        void rollbackErr;
      }
      throw err;
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getSession(sessionId: string): Promise<AgentSessionRecord | null> {
    const row = this.readLiveSessionRow(sessionId, this.clock.now());
    if (row === null) {
      return null;
    }
    return this.readSessionRecord(sessionId);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Read a session row, sweeping it (and its turns) if expired. Returns null
   *  when absent or expired. */
  private readLiveSessionRow(sessionId: string, now: Date): SessionRow | null {
    const row = this.db
      .prepare('SELECT * FROM agent_sessions WHERE session_id = ?')
      .get(sessionId) as unknown as SessionRow | undefined;
    if (row === undefined) {
      return null;
    }
    // Rule 28: a corrupt/non-finite `expires_at` (bad migration, manual edit)
    // must fail CLOSED — treat as expired and sweep, never as immortal.
    if (!Number.isFinite(row.expires_at) || row.expires_at <= now.getTime()) {
      this.deleteSession(sessionId);
      return null;
    }
    return row;
  }

  private readLiveSessionByClientId(clientSessionId: string, now: Date): AgentSessionRecord | null {
    const row = this.db
      .prepare('SELECT session_id FROM agent_sessions WHERE client_session_id = ?')
      .get(clientSessionId) as unknown as { session_id: string } | undefined;
    if (row === undefined) {
      return null;
    }
    const live = this.readLiveSessionRow(row.session_id, now);
    return live === null ? null : this.readSessionRecord(row.session_id);
  }

  private deleteSession(sessionId: string): void {
    // FK ON DELETE CASCADE removes turns; we also delete explicitly in case
    // foreign_keys PRAGMA is off in some environments.
    this.db.prepare('DELETE FROM agent_session_turns WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM agent_sessions WHERE session_id = ?').run(sessionId);
  }

  private readTurnByClientId(sessionId: string, clientTurnId: string): AgentSessionTurn | null {
    const row = this.db
      .prepare(
        'SELECT turn_index, client_turn_id, payload, created_at FROM agent_session_turns WHERE session_id = ? AND client_turn_id = ?',
      )
      .get(sessionId, clientTurnId) as unknown as TurnRow | undefined;
    return row === undefined ? null : this.rowToTurn(row);
  }

  private readSessionRecord(sessionId: string): AgentSessionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM agent_sessions WHERE session_id = ?')
      .get(sessionId) as unknown as SessionRow | undefined;
    if (row === undefined) {
      return null;
    }
    const turnRows = this.db
      .prepare(
        'SELECT turn_index, client_turn_id, payload, created_at FROM agent_session_turns WHERE session_id = ? ORDER BY turn_index ASC',
      )
      .all(sessionId) as unknown as TurnRow[];
    const turns = turnRows.map((t) => this.rowToTurn(t));

    const context = row.context !== null
      ? parseJson(row.context, StoredContextSchema, 'session.context')
      : undefined;
    const options = row.options !== null
      ? parseJson(row.options, StoredOptionsSchema, 'session.options')
      : undefined;

    return {
      sessionId: row.session_id,
      sessionVersion: row.session_version,
      ...(context !== undefined ? { context } : {}),
      ...(options !== undefined ? { options } : {}),
      turns,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      expiresAt: new Date(row.expires_at),
    };
  }

  private rowToTurn(row: TurnRow): AgentSessionTurn {
    const payload = parseJson(row.payload, StoredTurnPayloadSchema, 'turn.payload');
    return {
      turnIndex: row.turn_index,
      clientTurnId: row.client_turn_id,
      messages: payload.messages as readonly AgentMessage[],
      historyApplied: payload.historyApplied as readonly AgentMessage[],
      result: payload.result,
      toolTraceSummary: payload.toolTraceSummary,
      createdAt: new Date(row.created_at),
    };
  }

  /** Release the underlying SQLite handle. Checkpoints the WAL first so the
   *  `-wal`/`-shm` sidecars fold back into the main DB on a clean shutdown
   *  (CLI invocation end, server SIGTERM) — otherwise the WAL grows unbounded
   *  across restarts and the fd leaks. Idempotent + never throws so it is safe
   *  in a `finally`/shutdown path. */
  close(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (err) {
      void err; /* best-effort checkpoint; proceed to close regardless */
    }
    try {
      this.db.close();
    } catch (err) {
      void err; /* already closed / never opened — idempotent */
    }
  }
}

export interface CreateSqliteAgentSessionStoreOptions {
  /** SQLite database path. Use `:memory:` for an ephemeral test DB, or a file
   *  path for a durable production store. */
  readonly path: string;
  readonly clock?: SqliteAgentSessionStoreClock | undefined;
}

/**
 * Open a SQLite database, ensure the schema, and return a store. Sets WAL
 * journaling + a busy timeout so concurrent appends serialize rather than
 * failing fast, and enables foreign keys for the turns cascade.
 */
export function createSqliteAgentSessionStore(
  options: CreateSqliteAgentSessionStoreOptions,
): SqliteAgentSessionStore {
  const db = new DatabaseSync(options.path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`PRAGMA busy_timeout = ${String(SQLITE_BUSY_TIMEOUT_MS)}`);
  db.exec(SCHEMA_SQL);
  return new SqliteAgentSessionStore(db, options.clock);
}
