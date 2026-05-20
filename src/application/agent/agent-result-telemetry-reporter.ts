import type { AgentExecutionObserver } from '../../domain/agent/port/agent-execution-observer.port.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import type { AgentExecutionState } from './agent-execution-state.js';
import type { AgentResultMetrics } from './agent-result-assembly.js';

const log = bootstrapLogger.child({ component: 'AgentResultTelemetryReporter' });

interface AgentResultTelemetryReporterDeps {
  readonly executionObserver?: AgentExecutionObserver | undefined;
}

interface ReportAgentResultTelemetryInput {
  readonly requestId: string;
  readonly state: AgentExecutionState;
  readonly metrics: AgentResultMetrics;
}

export class AgentResultTelemetryReporter {
  constructor(private readonly deps: AgentResultTelemetryReporterDeps) {}

  report(input: ReportAgentResultTelemetryInput): void {
    const { requestId, state, metrics } = input;

    log.info(
      {
        requestId,
        steps: state.steps.length,
        toolCalls: metrics.toolCallCount,
        terminationReason: state.terminationReason,
        timeoutStats: state.timeoutStats,
        failureTags: metrics.failureTags,
        totalDurationMs: metrics.totalDurationMs,
        fallbackApplied: state.fallbackApplied,
      },
      'Agent execution complete',
    );

    this.deps.executionObserver?.onExecutionComplete({
      terminationReason: state.terminationReason,
      fallbackApplied: state.fallbackApplied,
      toolCallCount: metrics.toolCallCount,
      totalDurationMs: metrics.totalDurationMs,
      timeoutStats: state.timeoutStats,
      synthesis: {
        reasoningFailure: metrics.reasoningFailure,
        fallbackApplied: state.fallbackLayer,
      },
    });
  }
}
