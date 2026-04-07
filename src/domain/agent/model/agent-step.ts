/**
 * A single step in the agent's ReAct reasoning loop.
 *
 * Each step is either:
 *   - A tool call (thought + action + observation)
 *   - A final answer (thought + answer)
 */
export interface AgentToolCall {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface AgentStep {
  readonly index: number;
  readonly thought: string;
  readonly action?: AgentToolCall | undefined;
  readonly observation?: string | undefined;
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
  | 'fallback';
