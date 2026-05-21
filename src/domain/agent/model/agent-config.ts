/**
 * Agent configuration — safety bounds for the ReAct loop.
 */
export interface AgentConfig {
  /** Maximum number of tool-call steps before forced termination. */
  readonly maxSteps: number;
  /** Total wall-clock timeout for the entire agent run (ms). */
  readonly agentTimeoutMs: number;
  /** Per-step tool execution timeout (ms). */
  readonly perStepTimeoutMs: number;
  /** Maximum phrases sent to LLM context per step. */
  readonly maxContextChars: number;
  /** Hard cap on total tokens (input+output). Terminates agent when exceeded. */
  readonly maxTotalTokens: number;
  /** Deterministic seed for LLM calls (propagated to ChatCompletionRequest.seed). */
  readonly seed?: number | undefined;
  /** Per-tool execution timeout (ms) for single tool calls in the loop. */
  readonly toolTimeoutMs?: number | undefined;
  /** Parallel batch timeout (ms) for Promise.all tool batches. */
  readonly parallelBatchTimeoutMs?: number | undefined;
  /**
   * P0 termination guard: when true (default), the planner is forced to issue a
   * second-step verify/synthesize action for queries with hard reasoning
   * obligations identified by `AgentQueryExecutionContract.requiresVerificationStep`.
   * When false, the legacy "one tool + answer" path is preserved.
   */
  readonly requireVerificationStep?: boolean | undefined;
  /**
   * L1.C structural latency lever: short-circuit the run loop after a single
   * tool call whose observation already satisfies every contract gate the
   * planner would itself enforce on emit-answer. The orchestrator's terminal
   * routing then drives `AgentObservationSynthesisRunner` to produce the
   * grounded answer directly, replacing one planner LLM RTT with a (cheaper)
   * synthesis RTT.
   *
   * Bypass predicate is the SAME constraint-coverage signal the planner's
   * answer-acceptance gate already uses (no required-tool gap, no grounded-
   * search gap, no pending drinkability, no food-pairing follow-up, no
   * refinement retry pending) - evaluated from the other side of the
   * boolean. Not a heuristic.
   *
   * Default: true. Override via env AGENT_FAST_ANSWER_BYPASS_PLANNER.
   */
  readonly fastAnswerBypassPlanner?: boolean | undefined;
}

/**
 * Mutual consistency of timing limits (CLAUDE.md rule 22):
 *   maxSteps=5, perStepTimeoutMs=10_000 → naive max = 5 × 10s = 50s
 *   agentTimeoutMs=25_000 < HTTP_DEFAULT_REQUEST_TIMEOUT_MS (30_000) intentionally.
 *   The 5s buffer lets the HTTP layer synthesise and send the response after the
 *   agent loop terminates. Without the gap both timers fire simultaneously and
 *   Fastify closes the connection while the route handler is still serialising.
 *
 *   Naive max wall-clock: maxSteps=5 × perStepTimeoutMs=10_000 = 50s.
 *   agentTimeoutMs=25_000 is the hard cut that fires well before that worst case.
 *
 *   Token budget: maxTotalTokens=50_000 / maxSteps=5 = 10_000 tokens/step.
 *   System prompt ≈ 700 tokens; 5 step messages ≈ 3_000 tokens; response ≈ 1_024 tokens.
 *   Headroom per step ≈ 10_000 − 700 − 3_000 − 1_024 ≈ 5_276 tokens for context.
 */
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  maxSteps: 5,
  agentTimeoutMs: 25_000,
  perStepTimeoutMs: 10_000,
  maxContextChars: 8_000,
  maxTotalTokens: 50_000,
  requireVerificationStep: true,
  // L1.C: structural one-RTT save on simple lookups. Off-switch via env
  // AGENT_FAST_ANSWER_BYPASS_PLANNER=false at the composition root (see
  // src/config/container.ts where the orchestrator is wired).
  fastAnswerBypassPlanner: true,
} as const;
