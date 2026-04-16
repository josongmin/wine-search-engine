import { describe, expect, it, vi } from 'vitest';
import { AgentResultFinalizer } from '../../../../src/application/agent/agent-result-finalizer.js';
import { createAgentExecutionState } from '../../../../src/application/agent/agent-execution-state.js';
import { DEFAULT_AGENT_CONFIG } from '../../../../src/domain/agent/model/agent-config.js';
import { StepBudget } from '../../../../src/domain/agent/service/step-budget.js';

describe('AgentResultFinalizer', () => {
  it('builds result telemetry from the shared execution state', () => {
    const observer = { onExecutionComplete: vi.fn() };
    const finalizer = new AgentResultFinalizer({ executionObserver: observer });
    const state = createAgentExecutionState();
    state.terminationReason = 'answer';
    state.fallbackApplied = true;
    state.fallbackLayer = 'layer3';
    state.failedSynthesisAttempts = 2;
    state.fallbackSearchUsed = false;
    state.steps.push({
      index: 0,
      thought: 'parallel',
      actionPairs: [
        { action: { tool: 'search_wines', input: { query: 'opus one' } }, observation: 'found' },
        { action: { tool: 'search_wines', input: { query: 'barolo' } }, observation: 'found' },
      ],
      actions: [
        { tool: 'search_wines', input: { query: 'opus one' } },
        { tool: 'search_wines', input: { query: 'barolo' } },
      ],
      observations: ['found', 'found'],
      durationMs: 1,
      tokenCount: { input: 3, output: 4 },
    });
    state.toolOutcomes.push({
      stepId: 'req:0:0',
      tool: 'search_wines',
      kind: 'success',
      result: { queryType: 'search', results: [] },
      durationMs: 1,
    });

    const result = finalizer.finalize({
      query: 'opus one',
      requestId: 'req-finalize',
      answer: '  정리된 답변입니다.  ',
      observedToolOutput: true,
      budget: new StepBudget(DEFAULT_AGENT_CONFIG),
      state,
    });

    expect(result.answer).toBe('정리된 답변입니다.');
    expect(result.toolCallCount).toBe(2);
    expect(result.fallbackTrace).toMatchObject({
      fallbackApplied: 'layer3',
      reasoningFailure: true,
      failedSynthesisAttempts: 2,
      fallbackSearchUsed: false,
    });
    expect(observer.onExecutionComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        terminationReason: 'answer',
        fallbackApplied: true,
        toolCallCount: 2,
        synthesis: expect.objectContaining({
          reasoningFailure: true,
          fallbackApplied: 'layer3',
        }),
      }),
    );
  });
});
