import { describe, expect, it } from 'vitest';
import { createAgentExecutionState } from '../../../../src/application/agent/agent-execution-state.js';
import { AgentToolExecutionPolicy } from '../../../../src/application/agent/agent-tool-execution-policy.js';

describe('AgentToolExecutionPolicy', () => {
  it('normalizes exact metadata single search into exact lookup input', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: { query: 'opus one', country: 'United States', vintage_min: 2018 },
      queryExecutionContract: { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: true },
    });

    expect(resolved).toEqual({ query: 'opus one', limit: 1 });
  });

  it('normalizes only eligible search calls inside parallel batches', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveParallelBatch({
      calls: [
        { tool: 'search_wines', input: { query: 'opus one', country: 'United States' } },
        { tool: 'check_drinking_window', input: { entity_id: 'wine-1' } },
      ],
      queryExecutionContract: { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: true },
    });

    expect(resolved[0]).toEqual({ tool: 'search_wines', input: { query: 'opus one', limit: 1 } });
    expect(resolved[1]).toEqual({ tool: 'check_drinking_window', input: { entity_id: 'wine-1' } });
  });

  it('injects refinement hint only once when no-match observations appear with enough remaining steps', () => {
    const policy = new AgentToolExecutionPolicy();
    const state = createAgentExecutionState();

    policy.maybeInjectRefinementHint(state, ['검색 결과가 없습니다'], 3);
    const firstHint = state.pendingRefinementHint;
    policy.maybeInjectRefinementHint(state, ['NO_MATCH: none'], 5);

    expect(firstHint).toContain('HINT:');
    expect(state.pendingRefinementHint).toBe(firstHint);
    expect(state.hasInjectedRefinementHint).toBe(true);
  });

  it('does not inject refinement hint when remaining step budget is too low', () => {
    const policy = new AgentToolExecutionPolicy();
    const state = createAgentExecutionState();

    policy.maybeInjectRefinementHint(state, ['검색 결과가 없습니다'], 2);

    expect(state.hasInjectedRefinementHint).toBe(false);
    expect(state.pendingRefinementHint).toBeUndefined();
  });

});
