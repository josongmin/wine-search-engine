/**
 * AgentRuntimeSessionState — the session-scoped runtime state seam (T-MTA-06).
 *
 * The principle (borrowed from the `quanta` reference, WITHOUT its WS/kernel
 * substrate): provider-specific conversational state — continuation handles,
 * prompt-cache fingerprints, per-session trace context — is owned by the
 * SESSION EXECUTION PLANE, never by the orchestrator core or a singleton
 * provider adapter. A `ClaudeStructuredLlmAdapter` is a process-wide singleton
 * holding only immutable config; if it grew a mutable `continuationState`
 * field, two concurrent sessions would corrupt each other.
 *
 * This module is the SEAM only — there is no provider continuation feature
 * today, so the state is deliberately minimal. When such a feature lands, its
 * mutable state attaches HERE (a per-session instance), and flows to the
 * provider edge via {@link WineSearchInput.runtimeState} — it does NOT become
 * an adapter field.
 *
 * Lifecycle: created per server-managed turn by {@link AgentSessionService}
 * (or per single-shot run by the caller), and discarded when the run
 * completes. Never shared across sessions; never global.
 */

/** Opaque, provider-specific continuation/cache state. Kept `unknown`-typed so
 *  the application core never depends on a concrete provider's wire shape — the
 *  provider adapter at the edge is the only thing that interprets it. */
export interface AgentProviderRuntimeState {
  /** Provider continuation handle (e.g. a server-side conversation/response id
   *  for a future stateful-provider feature). Absent today. */
  readonly continuation?: unknown;
  /** Stable fingerprint a provider may use to key prompt-cache reuse across
   *  the turns of ONE session. Absent today. */
  readonly promptCacheFingerprint?: string | undefined;
}

export interface AgentRuntimeSessionState {
  /** The session this runtime state belongs to (`undefined` for a single-shot
   *  run with no server-managed session). */
  readonly sessionId?: string | undefined;
  /** Per-session trace correlation surfaced into orchestrator/loop log context
   *  so multi-turn runs are traceable end-to-end. */
  readonly traceContext?: Readonly<Record<string, string>> | undefined;
  /** Provider-edge state — owned here, NEVER on a singleton adapter. */
  readonly provider?: AgentProviderRuntimeState | undefined;
}

/** Build a fresh, session-scoped runtime state. One instance per run; the
 *  composition root / service calls this — never a module-level singleton. */
export function createAgentRuntimeSessionState(
  init: AgentRuntimeSessionState = {},
): AgentRuntimeSessionState {
  return {
    ...(init.sessionId !== undefined ? { sessionId: init.sessionId } : {}),
    ...(init.traceContext !== undefined ? { traceContext: init.traceContext } : {}),
    ...(init.provider !== undefined ? { provider: init.provider } : {}),
  };
}
