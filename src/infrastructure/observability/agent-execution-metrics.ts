import type {
  AgentExecutionObserver,
  AgentExecutionRecord,
} from '../../domain/agent/port/agent-execution-observer.port.js';

export interface AgentExecutionMetrics {
  readonly runs: number;
  readonly byTerminationReason: Readonly<Record<string, number>>;
  readonly fallbackRuns: number;
  readonly fallbackRate: number;
  readonly fallbackByLayer: Readonly<Record<string, number>>;
  readonly reasoningFailureRuns: number;
  readonly totalToolCalls: number;
  readonly avgDurationMs: number;
  readonly toolOutcomeKinds: Readonly<Record<string, number>>;
  readonly failedOutcomeKinds: Readonly<Record<string, number>>;
  readonly timeouts: {
    readonly llmStep: number;
    readonly tool: number;
    readonly parallelBatch: number;
    readonly eventRatePerRun: number;
  };
  readonly alerts: readonly string[];
}

const MIN_RUNS_FOR_ALERT = 20;
const FALLBACK_RATE_ALERT_THRESHOLD = 0.3;
const TIMEOUT_EVENT_RATE_ALERT_THRESHOLD = 0.2;
const PARALLEL_BATCH_TIMEOUT_RATE_ALERT_THRESHOLD = 0.1;

export class AgentExecutionMetricsCollector implements AgentExecutionObserver {
  private runs = 0;
  private fallbackRuns = 0;
  private reasoningFailureRuns = 0;
  private totalToolCalls = 0;
  private totalDurationMs = 0;
  private timeoutLlmStep = 0;
  private timeoutTool = 0;
  private timeoutParallelBatch = 0;
  private readonly byTerminationReason = new Map<string, number>();
  private readonly fallbackByLayer = new Map<string, number>();
  private readonly toolOutcomeKinds = new Map<string, number>();
  private readonly failedOutcomeKinds = new Map<string, number>();

  onExecutionComplete(record: AgentExecutionRecord): void {
    this.runs++;
    if (record.fallbackApplied) this.fallbackRuns++;
    if (record.synthesis?.reasoningFailure === true) {
      this.reasoningFailureRuns++;
    }
    if (record.synthesis?.fallbackApplied !== null && record.synthesis?.fallbackApplied !== undefined) {
      this.fallbackByLayer.set(
        record.synthesis.fallbackApplied,
        (this.fallbackByLayer.get(record.synthesis.fallbackApplied) ?? 0) + 1,
      );
    }
    this.totalToolCalls += record.toolCallCount;
    this.totalDurationMs += record.totalDurationMs;
    this.timeoutLlmStep += record.timeoutStats.llmStep;
    this.timeoutTool += record.timeoutStats.tool;
    this.timeoutParallelBatch += record.timeoutStats.parallelBatch;
    this.byTerminationReason.set(
      record.terminationReason,
      (this.byTerminationReason.get(record.terminationReason) ?? 0) + 1,
    );
    for (const kind of record.toolOutcomeKinds ?? []) {
      this.toolOutcomeKinds.set(kind, (this.toolOutcomeKinds.get(kind) ?? 0) + 1);
    }
    for (const kind of record.failedOutcomeKinds ?? []) {
      this.failedOutcomeKinds.set(kind, (this.failedOutcomeKinds.get(kind) ?? 0) + 1);
    }
  }

  getMetrics(): AgentExecutionMetrics {
    const byReason: Record<string, number> = {};
    for (const [k, v] of this.byTerminationReason.entries()) {
      byReason[k] = v;
    }
    const fallbackByLayer: Record<string, number> = {};
    for (const [k, v] of this.fallbackByLayer.entries()) {
      fallbackByLayer[k] = v;
    }
    const toolOutcomeKinds: Record<string, number> = {};
    for (const [k, v] of this.toolOutcomeKinds.entries()) {
      toolOutcomeKinds[k] = v;
    }
    const failedOutcomeKinds: Record<string, number> = {};
    for (const [k, v] of this.failedOutcomeKinds.entries()) {
      failedOutcomeKinds[k] = v;
    }
    const fallbackRate = this.runs > 0 ? this.fallbackRuns / this.runs : 0;
    const timeoutEventTotal = this.timeoutLlmStep + this.timeoutTool + this.timeoutParallelBatch;
    const timeoutEventRatePerRun = this.runs > 0 ? timeoutEventTotal / this.runs : 0;
    const parallelBatchTimeoutRate = this.runs > 0 ? this.timeoutParallelBatch / this.runs : 0;
    const alerts: string[] = [];
    if (this.runs >= MIN_RUNS_FOR_ALERT) {
      if (fallbackRate >= FALLBACK_RATE_ALERT_THRESHOLD) {
        alerts.push('agent_fallback_rate_high');
      }
      if (timeoutEventRatePerRun >= TIMEOUT_EVENT_RATE_ALERT_THRESHOLD) {
        alerts.push('agent_timeout_event_rate_high');
      }
      if (parallelBatchTimeoutRate >= PARALLEL_BATCH_TIMEOUT_RATE_ALERT_THRESHOLD) {
        alerts.push('agent_parallel_batch_timeout_rate_high');
      }
    }
    return {
      runs: this.runs,
      byTerminationReason: byReason,
      fallbackRuns: this.fallbackRuns,
      fallbackRate,
      fallbackByLayer,
      reasoningFailureRuns: this.reasoningFailureRuns,
      totalToolCalls: this.totalToolCalls,
      avgDurationMs: this.runs > 0 ? this.totalDurationMs / this.runs : 0,
      toolOutcomeKinds,
      failedOutcomeKinds,
      timeouts: {
        llmStep: this.timeoutLlmStep,
        tool: this.timeoutTool,
        parallelBatch: this.timeoutParallelBatch,
        eventRatePerRun: timeoutEventRatePerRun,
      },
      alerts,
    };
  }

  reset(): void {
    this.runs = 0;
    this.fallbackRuns = 0;
    this.reasoningFailureRuns = 0;
    this.totalToolCalls = 0;
    this.totalDurationMs = 0;
    this.timeoutLlmStep = 0;
    this.timeoutTool = 0;
    this.timeoutParallelBatch = 0;
    this.byTerminationReason.clear();
    this.fallbackByLayer.clear();
    this.toolOutcomeKinds.clear();
    this.failedOutcomeKinds.clear();
  }
}

let globalCollector: AgentExecutionMetricsCollector | undefined;

export function getAgentExecutionMetricsCollector(): AgentExecutionMetricsCollector {
  globalCollector ??= new AgentExecutionMetricsCollector();
  return globalCollector;
}
