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
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  maxSteps: 5,
  agentTimeoutMs: 30_000,
  perStepTimeoutMs: 10_000,
  maxContextChars: 8_000,
  maxTotalTokens: 50_000,
} as const;
