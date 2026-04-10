/**
 * A single step in the agent's ReAct reasoning loop.
 *
 * Each step is one of:
 *   - Single tool call  (thought + action  + observation)
 *   - Parallel batch    (thought + actions + observations)  ← parallel execution
 *   - Final answer      (thought + answer)
 *
 * Backward-compatibility: `action`/`observation` (singular) are preserved so
 * existing code that reads steps continues to work unchanged. New parallel
 * steps use `actions`/`observations` (plural) exclusively.
 */
export interface AgentToolCall {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/**
 * A paired action+observation for parallel batch steps.
 * Using a pair type instead of two parallel arrays prevents index-drift bugs:
 * `actions[i]` and `observations[i]` can never get out of sync because they
 * are stored together as a single object.
 */
export interface AgentToolCallPair {
  readonly action: AgentToolCall;
  readonly observation: string;
}

export interface AgentStep {
  readonly index: number;
  readonly thought: string;
  // ── single tool call (legacy / sequential) ────────────────────────────────
  readonly action?: AgentToolCall | undefined;
  readonly observation?: string | undefined;
  // ── parallel batch (2+ tools fired simultaneously) ────────────────────────
  // Stored as paired objects to enforce 1:1 action↔observation alignment at the
  // type level. The flat `actions`/`observations` arrays are derived accessors
  // kept for backward-compatibility with existing consumers.
  readonly actionPairs?: readonly AgentToolCallPair[] | undefined;
  /** @deprecated Use actionPairs instead. Kept for backward-compat. */
  readonly actions?: readonly AgentToolCall[] | undefined;
  /** @deprecated Use actionPairs instead. Kept for backward-compat. */
  readonly observations?: readonly string[] | undefined;
  // ── final answer ──────────────────────────────────────────────────────────
  readonly answer?: string | undefined;
  readonly durationMs: number;
  readonly tokenCount: { readonly input: number; readonly output: number };
}

export type AgentTerminationReason =
  | 'answer'
  | 'max_steps'
  | 'timeout'
  | 'budget'
  | 'error'
  | 'loop_detected'
  | 'fallback'
  | 'blocked'
  | 'aborted';
