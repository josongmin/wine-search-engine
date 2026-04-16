import { describe, expect, it } from 'vitest';
import {
  getGroundingObservationSteps,
  getLastGroundingObservationText,
  hasGroundingToolObservations,
} from '../../../../src/application/agent/agent-grounding-observation-policy.js';
import { createAgentExecutionState } from '../../../../src/application/agent/agent-execution-state.js';

describe('agent grounding observation policy', () => {
  it('treats successful typed outcomes as grounding observations', () => {
    const state = createAgentExecutionState();
    state.steps.push({
      index: 0,
      thought: 'search',
      action: { tool: 'search_wines', input: { query: 'opus one' } },
      observation: 'Opus One 2018',
      durationMs: 3,
      tokenCount: { input: 1, output: 1 },
    });
    state.toolOutcomes.push({
      stepId: 'req:0:0',
      tool: 'search_wines',
      kind: 'success',
      result: { queryType: 'search', results: [] },
      durationMs: 3,
    });

    expect(hasGroundingToolObservations(state)).toBe(true);
    expect(getGroundingObservationSteps(state)).toHaveLength(1);
    expect(getLastGroundingObservationText(state)).toBe('Opus One 2018');
  });

  it('does not treat timeout typed outcomes as grounding observations', () => {
    const state = createAgentExecutionState();
    state.steps.push({
      index: 0,
      thought: 'parallel',
      actionPairs: [
        { action: { tool: 'search_wines', input: { query: 'hung-a' } }, observation: '[TIMEOUT] Parallel tool batch timed out.' },
      ],
      actions: [{ tool: 'search_wines', input: { query: 'hung-a' } }],
      observations: ['[TIMEOUT] Parallel tool batch timed out.'],
      durationMs: 3,
      tokenCount: { input: 1, output: 1 },
    });
    state.toolOutcomes.push({
      stepId: 'req:0:0',
      tool: 'search_wines',
      kind: 'timeout',
      errorMessage: '[TIMEOUT] Parallel tool batch timed out.',
      durationMs: 3,
    });

    expect(hasGroundingToolObservations(state)).toBe(false);
    expect(getGroundingObservationSteps(state)).toHaveLength(0);
    expect(getLastGroundingObservationText(state)).toBeUndefined();
  });
});
