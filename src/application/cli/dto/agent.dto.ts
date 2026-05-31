export interface AgentMessageInput {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly name?: string | undefined;
  readonly timestamp?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface AgentContextInput {
  readonly locale?: string | undefined;
  readonly currency?: string | undefined;
}

export interface AgentOptionsInput {
  readonly maxSteps?: number | undefined;
  readonly perStepTimeoutMs?: number | undefined;
  readonly agentTimeoutMs?: number | undefined;
  readonly maxTotalTokens?: number | undefined;
}

export interface AgentRunInput {
  readonly messages: readonly AgentMessageInput[];
  readonly context?: AgentContextInput | undefined;
  readonly options?: AgentOptionsInput | undefined;
}

export interface AgentSessionStartInput {
  readonly clientSessionId?: string | undefined;
  readonly context?: AgentContextInput | undefined;
  readonly options?: AgentOptionsInput | undefined;
}

export interface AgentSessionTurnInput {
  readonly sessionId: string;
  readonly clientTurnId: string;
  readonly messages: readonly AgentMessageInput[];
  // Per-turn `context` is intentionally unsupported — execution context is
  // fixed at session-create time (parity with the HTTP turn contract).
  readonly options?: AgentOptionsInput | undefined;
  readonly expectedSessionVersion?: number | undefined;
}

export type AgentRunResult = unknown;
export type AgentSessionStartResult = unknown;
export type AgentSessionTurnResult = unknown;
