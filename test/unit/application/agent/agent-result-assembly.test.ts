import { describe, expect, it } from 'vitest';
import {
  AgentResultAssembler,
  buildAgentResultMetrics,
} from '../../../../src/application/agent/agent-result-assembly.js';
import { createAgentExecutionState } from '../../../../src/application/agent/agent-execution-state.js';
import { DEFAULT_AGENT_CONFIG } from '../../../../src/domain/agent/model/agent-config.js';
import { StepBudget } from '../../../../src/domain/agent/service/step-budget.js';

describe('AgentResultAssembler', () => {
  it('builds pure result shape and fallback trace from execution state', () => {
    const state = createAgentExecutionState();
    state.terminationReason = 'answer';
    state.fallbackApplied = true;
    state.fallbackLayer = 'layer3';
    state.failedSynthesisAttempts = 1;
    state.steps.push({
      index: 0,
      thought: 'search',
      action: { tool: 'search_wines', input: { query: 'opus one' } },
      observation: 'found',
      durationMs: 1,
      tokenCount: { input: 1, output: 1 },
    });
    state.toolOutcomes.push({
      stepId: 'req:0:0',
      tool: 'search_wines',
      kind: 'success',
      result: { queryType: 'search', results: [] },
      durationMs: 1,
    });

    const input = {
      query: 'opus one',
      answer: '  답변  ',
      observedToolOutput: true,
      budget: new StepBudget(DEFAULT_AGENT_CONFIG),
      state,
    };
    const metrics = buildAgentResultMetrics(input);
    const result = new AgentResultAssembler().build(input, metrics);

    expect(result.answer).toBe('답변');
    expect(result.toolCallCount).toBe(1);
    expect(result.synthesisContext.reasoningFailure).toBe(true);
    expect(result.fallbackTrace).toMatchObject({
      fallbackApplied: 'layer3',
      reasoningFailure: true,
      failedSynthesisAttempts: 1,
    });
  });
});
