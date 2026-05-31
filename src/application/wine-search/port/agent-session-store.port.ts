/**
 * AgentSessionStorePort — persistence contract for the server-managed agent
 * surface (`POST /v1/agent/sessions`, `POST /v1/agent/sessions/:id/turns`),
 * per interface-revamp architecture-decision §6.
 *
 * Two correctness guarantees are baked into the port shape (NOT left to the
 * caller):
 *   - **idempotent turn append** keyed by `clientTurnId` — replaying the same
 *     turn returns the already-persisted result instead of double-appending.
 *   - **optimistic concurrency** keyed by `sessionVersion` — an append that
 *     carries a stale `expectedSessionVersion` fails closed (never
 *     last-write-wins).
 *
 * Store unavailability is the CALLER's concern: the composition root returns
 * `null` when no persistent store is wired, and the route layer fails closed
 * (5xx) rather than fabricating a degraded in-memory session
 * (architecture-decision §6 policy 3).
 */

import type {
  AgentMessage,
  AgentRequestContext,
  AgentRequestOptions,
} from '../wine-search-schemas.js';
import type { WineSearchResult } from '../wine-search-orchestrator.js';

/** A single persisted message inside a turn. Session history can include the
 *  agent's own synthesized answer, so the persisted shape follows the canonical
 *  application-layer {@link AgentMessage} contract. The persistence port
 *  speaks ONLY application types — the HTTP wire (snake_case) is mapped at the
 *  route edge (T-MTA-02: the port no longer depends on the interface layer). */
export type AgentSessionMessage = AgentMessage;
/** Session-scoped execution context (locale/currency). */
export type AgentContext = AgentRequestContext;
/** Session-scoped execution options (camelCase, orchestrator-ready). */
export type AgentOptions = AgentRequestOptions;

/** A summarized tool-trace line retained per turn for observability. Kept
 *  deliberately small — full traces live in logs, not the session row. */
export interface AgentToolTraceSummaryEntry {
  readonly tool: string;
  readonly outcome: string;
}

/** One appended turn within a session. */
export interface AgentSessionTurn {
  readonly turnIndex: number;
  readonly clientTurnId: string;
  /** The persisted transcript for THIS turn. This includes the caller's
   *  submitted messages PLUS the synthesized assistant answer so future turns
   *  can replay the real conversation transcript rather than a user-only
   *  history. */
  readonly messages: readonly AgentSessionMessage[];
  /** The history actually fed to the planner for this turn (prior turns +
   *  this turn's messages, after any explicit summarization). Surfaced so the
   *  caller can see what context produced the answer — no hidden stitching
   *  (architecture-decision §3.3). */
  readonly historyApplied: readonly AgentSessionMessage[];
  /** Persisted orchestrator result. Required so idempotent replays can return
   *  the same answer without re-running the planner. */
  readonly result: WineSearchResult;
  readonly toolTraceSummary: readonly AgentToolTraceSummaryEntry[];
  readonly createdAt: Date;
}

/** A persisted session aggregate. */
export interface AgentSessionRecord {
  readonly sessionId: string;
  /** Monotonic version — incremented on every successful turn append. The
   *  initial (turn-less) session is version 0. */
  readonly sessionVersion: number;
  readonly context?: AgentContext | undefined;
  readonly options?: AgentOptions | undefined;
  readonly turns: readonly AgentSessionTurn[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly expiresAt: Date;
}

/** Input to create a new session. `clientSessionId`, when provided, is the
 *  idempotency key: re-creating with the same id returns the existing
 *  session rather than minting a second one. */
export interface CreateAgentSessionInput {
  readonly clientSessionId?: string | undefined;
  readonly context?: AgentContext | undefined;
  readonly options?: AgentOptions | undefined;
  /** TTL horizon for the session row. */
  readonly expiresAt: Date;
}

export type CreateAgentSessionResult =
  | { readonly kind: 'created'; readonly session: AgentSessionRecord }
  | { readonly kind: 'idempotent_replay'; readonly session: AgentSessionRecord };

/** Input to append a turn. */
export interface AppendAgentTurnInput {
  readonly sessionId: string;
  readonly clientTurnId: string;
  readonly messages: readonly AgentSessionMessage[];
  readonly historyApplied: readonly AgentSessionMessage[];
  readonly result: WineSearchResult;
  readonly toolTraceSummary: readonly AgentToolTraceSummaryEntry[];
  /**
   * Optimistic-concurrency guard. When provided, the append fails closed with
   * `version_conflict` if the session's current version differs. When omitted,
   * the append proceeds against whatever the current version is (last-known
   * wins is NOT used — omission simply skips the precondition).
   */
  readonly expectedSessionVersion?: number | undefined;
  /** New TTL horizon to extend the session to on a successful append. */
  readonly expiresAt: Date;
}

/**
 * Result of an append. Discriminated so the route layer maps each outcome to
 * the correct HTTP status WITHOUT inspecting error strings:
 *   - `appended`          → 200/201, the new turn
 *   - `idempotent_replay` → 200, the already-persisted turn (same clientTurnId)
 *   - `version_conflict`  → 409, carries the actual current version
 *   - `session_not_found` → 404
 */
export type AppendAgentTurnResult =
  | { readonly kind: 'appended'; readonly session: AgentSessionRecord; readonly turn: AgentSessionTurn }
  | { readonly kind: 'idempotent_replay'; readonly session: AgentSessionRecord; readonly turn: AgentSessionTurn }
  | { readonly kind: 'version_conflict'; readonly currentVersion: number }
  | { readonly kind: 'session_not_found' };

export interface AgentSessionStorePort {
  /** Create (or idempotently return) a session. */
  createSession(input: CreateAgentSessionInput): Promise<CreateAgentSessionResult>;
  /** Append a turn with idempotency + optimistic concurrency. */
  appendTurn(input: AppendAgentTurnInput): Promise<AppendAgentTurnResult>;
  /** Fetch a session by id, or `null` if absent/expired. */
  getSession(sessionId: string): Promise<AgentSessionRecord | null>;
  /** Release underlying resources (DB handle, WAL). Optional — the
   *  process-local test store holds nothing to close. Durable adapters
   *  (SQLite) MUST implement it so the composition root can finalize the WAL
   *  and avoid fd leaks on shutdown / per-CLI-invocation. Idempotent; must not
   *  throw. */
  close?(): void;
}
