import type {
  AgentExecutionObserver,
  AgentExecutionRecord,
} from '../../domain/agent/port/agent-execution-observer.port.js';

export interface AgentExecutionMetrics {
  readonly runs: number;
  readonly byTerminationReason: Readonly<Record<string, number>>;
  readonly fallbackRuns: number;
  readonly totalToolCalls: number;
  readonly avgDurationMs: number;
  readonly timeouts: {
    readonly llmStep: number;
    readonly tool: number;
    readonly parallelBatch: number;
  };
}

export class AgentExecutionMetricsCollector implements AgentExecutionObserver {
  private runs = 0;
  private fallbackRuns = 0;
  private totalToolCalls = 0;
  private totalDurationMs = 0;
  private timeoutLlmStep = 0;
  private timeoutTool = 0;
  private timeoutParallelBatch = 0;
  private readonly byTerminationReason = new Map<string, number>();

  onExecutionComplete(record: AgentExecutionRecord): void {
    this.runs++;
    if (record.fallbackApplied) this.fallbackRuns++;
    this.totalToolCalls += record.toolCallCount;
    this.totalDurationMs += record.totalDurationMs;
    this.timeoutLlmStep += record.timeoutStats.llmStep;
    this.timeoutTool += record.timeoutStats.tool;
    this.timeoutParallelBatch += record.timeoutStats.parallelBatch;
    this.byTerminationReason.set(
      record.terminationReason,
      (this.byTerminationReason.get(record.terminationReason) ?? 0) + 1,
    );
  }

  getMetrics(): AgentExecutionMetrics {
    const byReason: Record<string, number> = {};
    for (const [k, v] of this.byTerminationReason.entries()) {
      byReason[k] = v;
    }
    return {
      runs: this.runs,
      byTerminationReason: byReason,
      fallbackRuns: this.fallbackRuns,
      totalToolCalls: this.totalToolCalls,
      avgDurationMs: this.runs > 0 ? this.totalDurationMs / this.runs : 0,
      timeouts: {
        llmStep: this.timeoutLlmStep,
        tool: this.timeoutTool,
        parallelBatch: this.timeoutParallelBatch,
      },
    };
  }

  reset(): void {
    this.runs = 0;
    this.fallbackRuns = 0;
    this.totalToolCalls = 0;
    this.totalDurationMs = 0;
    this.timeoutLlmStep = 0;
    this.timeoutTool = 0;
    this.timeoutParallelBatch = 0;
    this.byTerminationReason.clear();
  }
}

let globalCollector: AgentExecutionMetricsCollector | undefined;

export function getAgentExecutionMetricsCollector(): AgentExecutionMetricsCollector {
  if (globalCollector === undefined) {
    globalCollector = new AgentExecutionMetricsCollector();
  }
  return globalCollector;
}
