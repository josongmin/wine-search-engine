/**
 * AgentSessionService — owner of server-managed agent session history custody
 * (T-MTA-02).
 *
 * The `POST /v1/agent/sessions*` HTTP routes and the CLI `agent session *`
 * commands are thin transports: they parse/serialize the wire shape and
 * delegate ALL session logic here. This service is the single owner of:
 *
 *   - history stitching  — prior turns + this turn's messages form the
 *     `historyApplied` that is fed to the orchestrator (no hidden stitching),
 *   - transcript custody  — the persisted turn keeps the caller's messages
 *     AND the synthesized assistant answer, so a later turn replays the real
 *     conversation rather than a user-only history,
 *   - idempotency / optimistic-concurrency semantics — surfaced verbatim from
 *     the {@link AgentSessionStorePort} discriminants,
 *   - option / context resolution — session-level defaults merged with
 *     per-turn overrides.
 *
 * Custody rule (architecture-decision §3.3):
 *   - `run`  (single-shot) = caller-managed history — NOT this service.
 *   - `turn` (session)      = server-managed history — owned here.
 *
 * The service depends ONLY on application ports (the orchestrator contract +
 * the session store port); it knows nothing about HTTP, Fastify, or the CLI.
 */

import type { WineSearchOrchestratorContract } from './wine-search-orchestrator.js';
import type {
  AgentSessionMessage,
  AgentSessionRecord,
  AgentSessionStorePort,
  AgentSessionTurn,
  AgentToolTraceSummaryEntry,
  AgentContext,
  AgentOptions,
  CreateAgentSessionResult,
} from './port/agent-session-store.port.js';
import { ORCHESTRATOR_MAX_HISTORY_APPLIED, type WineSearchResult } from './wine-search-result-schemas.js';
import { windowHistory } from './wine-search-schemas.js';
import { createAgentRuntimeSessionState } from './agent-runtime-session-state.js';

/** Wall-clock source — injected so tests pin time deterministically. */
export interface AgentSessionClock {
  now(): Date;
}

export interface AgentSessionServiceDeps {
  readonly store: AgentSessionStorePort;
  readonly orchestrator: WineSearchOrchestratorContract;
  /** TTL policy — maps "now" to the session's expiry horizon. Injected by the
   *  composition root so the service stays free of config/TTL constants. */
  readonly computeExpiry: (now: Date) => Date;
  readonly clock?: AgentSessionClock | undefined;
}

/** Command to create (or idempotently return) a session. */
export interface CreateAgentSessionCommand {
  readonly clientSessionId?: string | undefined;
  readonly context?: AgentContext | undefined;
  readonly options?: AgentOptions | undefined;
}

/** Command to run one server-managed turn. `messages` are THIS turn's inbound
 *  messages only — the service stitches them onto the prior transcript. */
export interface RunAgentTurnCommand {
  readonly sessionId: string;
  readonly clientTurnId: string;
  readonly messages: readonly AgentSessionMessage[];
  readonly options?: AgentOptions | undefined;
  readonly expectedSessionVersion?: number | undefined;
  readonly requestId: string;
  readonly abortSignal?: AbortSignal | undefined;
}

/** Outcome of {@link AgentSessionService.runTurn}. Mirrors the store
 *  discriminants and carries the orchestrator result so the transport never
 *  re-runs the planner on a replay. */
export type RunAgentTurnOutcome =
  | {
      readonly kind: 'appended';
      readonly session: AgentSessionRecord;
      readonly turn: AgentSessionTurn;
      readonly result: WineSearchResult;
      readonly replayed: false;
    }
  | {
      readonly kind: 'idempotent_replay';
      readonly session: AgentSessionRecord;
      readonly turn: AgentSessionTurn;
      readonly result: WineSearchResult;
      readonly replayed: true;
    }
  | { readonly kind: 'version_conflict'; readonly currentVersion: number }
  | { readonly kind: 'session_not_found' };

/** Merge session-level option defaults with per-turn overrides. Both are
 *  camelCase application options; the per-turn value wins on conflict. Returns
 *  `undefined` when neither side sets anything (so the orchestrator default
 *  ladder applies). */
function mergeOptions(
  sessionOptions: AgentOptions | undefined,
  turnOptions: AgentOptions | undefined,
): AgentOptions | undefined {
  if (sessionOptions === undefined && turnOptions === undefined) {
    return undefined;
  }
  return { ...(sessionOptions ?? {}), ...(turnOptions ?? {}) };
}

/** Summarize the tool trace from the orchestrator result for compact
 *  per-turn observability storage. Full traces live in logs, not the row. */
function summarizeToolTrace(result: WineSearchResult): readonly AgentToolTraceSummaryEntry[] {
  const out: AgentToolTraceSummaryEntry[] = [];
  for (const step of result.executionSteps) {
    const observed = (step.observations?.length ?? 0) > 0;
    for (const toolCall of step.toolCalls ?? []) {
      out.push({ tool: toolCall.name, outcome: observed ? 'observed' : 'called' });
    }
  }
  return out;
}

export class AgentSessionService {
  private readonly store: AgentSessionStorePort;
  private readonly orchestrator: WineSearchOrchestratorContract;
  private readonly computeExpiry: (now: Date) => Date;
  private readonly clock: AgentSessionClock;

  constructor(deps: AgentSessionServiceDeps) {
    this.store = deps.store;
    this.orchestrator = deps.orchestrator;
    this.computeExpiry = deps.computeExpiry;
    this.clock = deps.clock ?? { now: () => new Date() };
  }

  async createSession(cmd: CreateAgentSessionCommand): Promise<CreateAgentSessionResult> {
    return this.store.createSession({
      ...(cmd.clientSessionId !== undefined ? { clientSessionId: cmd.clientSessionId } : {}),
      ...(cmd.context !== undefined ? { context: cmd.context } : {}),
      ...(cmd.options !== undefined ? { options: cmd.options } : {}),
      expiresAt: this.computeExpiry(this.clock.now()),
    });
  }

  async getSession(sessionId: string): Promise<AgentSessionRecord | null> {
    return this.store.getSession(sessionId);
  }

  async runTurn(cmd: RunAgentTurnCommand): Promise<RunAgentTurnOutcome> {
    const session = await this.store.getSession(cmd.sessionId);
    if (session === null) {
      return { kind: 'session_not_found' };
    }

    // Idempotent replay — same clientTurnId returns the already-persisted turn
    // WITHOUT re-running the planner (correctness guarantee from the port).
    const replay = session.turns.find((turn) => turn.clientTurnId === cmd.clientTurnId);
    if (replay !== undefined) {
      return { kind: 'idempotent_replay', session, turn: replay, result: replay.result, replayed: true };
    }

    // Optimistic-concurrency pre-check. The store re-checks atomically on
    // append; this early exit avoids a wasted orchestrator run on a stale
    // version (CLAUDE.md rule 20 — guard before the expensive operation).
    if (
      cmd.expectedSessionVersion !== undefined
      && session.sessionVersion !== cmd.expectedSessionVersion
    ) {
      return { kind: 'version_conflict', currentVersion: session.sessionVersion };
    }

    // Server-managed history custody: stitch the full prior transcript with
    // this turn's messages, then keep the MOST RECENT window bounded by the
    // published cap. Without the window, the stitched history grows ~2
    // messages/turn and eventually exceeds WineSearchResultSchema's and the
    // wire response's `.max(ORCHESTRATOR_MAX_HISTORY_APPLIED)` cap, which would
    // brick the session on read (the store re-validates the persisted result).
    // The window is VISIBLE in `history_applied` — exactly what the planner
    // received — so this is bounding, not hidden truncation.
    const stitched: readonly AgentSessionMessage[] = [
      ...session.turns.flatMap((turn) => turn.messages),
      ...cmd.messages,
    ];
    const historyApplied = windowHistory(stitched, ORCHESTRATOR_MAX_HISTORY_APPLIED);

    const options = mergeOptions(session.options, cmd.options);
    // T-MTA-06: per-turn, session-scoped runtime state. Provider continuation /
    // prompt-cache state would attach HERE (not on a singleton adapter). For
    // now it carries the session id for end-to-end trace correlation.
    const runtimeState = createAgentRuntimeSessionState({ sessionId: session.sessionId });
    const result = await this.orchestrator.execute({
      messages: historyApplied,
      requestId: cmd.requestId,
      runtimeState,
      ...(session.context !== undefined ? { context: session.context } : {}),
      ...(options !== undefined ? { options } : {}),
      ...(cmd.abortSignal !== undefined ? { abortSignal: cmd.abortSignal } : {}),
    });

    // Persisted transcript for THIS turn = the caller's messages PLUS the
    // synthesized assistant answer. Storing the answer is what lets the NEXT
    // turn replay a real user/assistant conversation (architecture-decision
    // §3.3 — user-only history is forbidden).
    const persistedMessages: readonly AgentSessionMessage[] = [
      ...cmd.messages,
      { role: 'assistant', content: result.answer },
    ];

    const appended = await this.store.appendTurn({
      sessionId: session.sessionId,
      clientTurnId: cmd.clientTurnId,
      messages: persistedMessages,
      historyApplied,
      result,
      toolTraceSummary: summarizeToolTrace(result),
      ...(cmd.expectedSessionVersion !== undefined
        ? { expectedSessionVersion: cmd.expectedSessionVersion }
        : {}),
      expiresAt: this.computeExpiry(this.clock.now()),
    });

    switch (appended.kind) {
      case 'appended':
        return { kind: 'appended', session: appended.session, turn: appended.turn, result, replayed: false };
      case 'idempotent_replay':
        // A concurrent request appended the same clientTurnId between our
        // pre-check and the store write — return that persisted result.
        return {
          kind: 'idempotent_replay',
          session: appended.session,
          turn: appended.turn,
          result: appended.turn.result,
          replayed: true,
        };
      case 'version_conflict':
        return { kind: 'version_conflict', currentVersion: appended.currentVersion };
      case 'session_not_found':
        return { kind: 'session_not_found' };
    }
  }
}
