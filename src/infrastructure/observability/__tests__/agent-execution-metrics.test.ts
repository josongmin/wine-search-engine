import { describe, expect, it } from 'vitest';
import { AgentExecutionMetricsCollector } from '../agent-execution-metrics.js';

describe('AgentExecutionMetricsCollector', () => {
  it('aggregates runs, reasons, fallback, and timeout stats', () => {
    const collector = new AgentExecutionMetricsCollector();

    collector.onExecutionComplete({
      terminationReason: 'answer',
      fallbackApplied: false,
      toolCallCount: 2,
      totalDurationMs: 100,
      timeoutStats: { llmStep: 0, tool: 1, parallelBatch: 0 },
    });
    collector.onExecutionComplete({
      terminationReason: 'fallback',
      fallbackApplied: true,
      toolCallCount: 0,
      totalDurationMs: 50,
      timeoutStats: { llmStep: 1, tool: 0, parallelBatch: 1 },
    });

    const metrics = collector.getMetrics();
    expect(metrics.runs).toBe(2);
    expect(metrics.byTerminationReason['answer']).toBe(1);
    expect(metrics.byTerminationReason['fallback']).toBe(1);
    expect(metrics.fallbackRuns).toBe(1);
    expect(metrics.totalToolCalls).toBe(2);
    expect(metrics.avgDurationMs).toBe(75);
    expect(metrics.timeouts).toEqual({ llmStep: 1, tool: 1, parallelBatch: 1 });
  });
});
