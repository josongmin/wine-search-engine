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

export interface AgentStep {
  readonly index: number;
  readonly thought: string;
  // ── single tool call (legacy / sequential) ────────────────────────────────
  readonly action?: AgentToolCall | undefined;
  readonly observation?: string | undefined;
  // ── parallel batch (2+ tools fired simultaneously) ────────────────────────
  readonly actions?: readonly AgentToolCall[] | undefined;
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
  | 'blocked';
