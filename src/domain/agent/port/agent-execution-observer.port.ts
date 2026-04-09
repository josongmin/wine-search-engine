export interface AgentExecutionTimeoutStats {
  readonly llmStep: number;
  readonly tool: number;
  readonly parallelBatch: number;
}

export interface AgentExecutionRecord {
  readonly terminationReason: string;
  readonly fallbackApplied: boolean;
  readonly toolCallCount: number;
  readonly totalDurationMs: number;
  readonly timeoutStats: AgentExecutionTimeoutStats;
}

export interface AgentExecutionObserver {
  onExecutionComplete(record: AgentExecutionRecord): void;
}
