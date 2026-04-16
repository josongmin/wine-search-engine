import { describe, expect, it, vi } from 'vitest';
import { AgentResultTelemetryReporter } from '../../../../src/application/agent/agent-result-telemetry-reporter.js';
import { createAgentExecutionState } from '../../../../src/application/agent/agent-execution-state.js';

describe('AgentResultTelemetryReporter', () => {
  it('emits observer record from precomputed metrics', () => {
    const observer = { onExecutionComplete: vi.fn() };
    const reporter = new AgentResultTelemetryReporter({ executionObserver: observer });
    const state = createAgentExecutionState();
    state.terminationReason = 'answer';
    state.fallbackApplied = true;
    state.fallbackLayer = 'layer2';

    reporter.report({
      requestId: 'req-telemetry',
      state,
      metrics: {
        toolCallCount: 2,
        totalDurationMs: 123,
        reasoningFailure: true,
        failureTags: ['tool_timeout'],
      },
    });

    expect(observer.onExecutionComplete).toHaveBeenCalledWith({
      terminationReason: 'answer',
      fallbackApplied: true,
      toolCallCount: 2,
      totalDurationMs: 123,
      timeoutStats: state.timeoutStats,
      synthesis: {
        reasoningFailure: true,
        fallbackApplied: 'layer2',
      },
    });
  });
});
