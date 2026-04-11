export interface AgentExecutionTimeoutStats {
  readonly llmStep: number;
  readonly tool: number;
  readonly parallelBatch: number;
}

export interface AgentExecutionSynthesisSummary {
  readonly reasoningFailure: boolean;
  readonly fallbackApplied: 'layer2' | 'layer3' | 'layer4' | null;
}

export interface AgentExecutionRecord {
  readonly terminationReason: string;
  readonly fallbackApplied: boolean;
  readonly toolCallCount: number;
  readonly totalDurationMs: number;
  readonly timeoutStats: AgentExecutionTimeoutStats;
  readonly synthesis?: AgentExecutionSynthesisSummary | undefined;
  readonly toolOutcomeKinds?: readonly string[] | undefined;
  readonly failedOutcomeKinds?: readonly string[] | undefined;
}

export interface AgentExecutionObserver {
  onExecutionComplete(record: AgentExecutionRecord): void;
}
