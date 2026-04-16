import { describe, expect, it } from 'vitest';
import { AgentContractPolicy } from '../../../../src/application/agent/agent-contract-policy.js';
import { createAgentExecutionState } from '../../../../src/application/agent/agent-execution-state.js';

describe('AgentContractPolicy', () => {
  it('extracts pending drinkability ids from state tool outcomes', () => {
    const policy = new AgentContractPolicy();
    const state = createAgentExecutionState();
    state.toolOutcomes.push({
      stepId: 'req:0:0',
      tool: 'search_wines',
      kind: 'success',
      result: {
        queryType: 'search',
        results: [{ entity: { entityId: 'wine-1', canonicalLabel: 'Wine 1' } }],
      },
      durationMs: 1,
    });

    const pending = policy.getPendingDrinkabilityEntityIds(
      { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: false },
      state,
    );

    expect(pending).toEqual(['wine-1']);
  });

  it('validates pending drinkability for single and batch steps', () => {
    const policy = new AgentContractPolicy();

    expect(policy.validateDrinkabilitySingleStep(['wine-1'], 'search_wines', { query: 'x' })).toContain('check_drinking_window');
    expect(policy.validateDrinkabilitySingleStep(['wine-1'], 'check_drinking_window', { entity_id: 'wine-2' })).toContain('check_drinking_window');
    expect(policy.validateDrinkabilitySingleStep(['wine-1'], 'check_drinking_window', { entity_id: 'wine-1' })).toBeNull();
    expect(policy.validateDrinkabilityBatch(['wine-1'], [
      { tool: 'search_wines', input: { query: 'x' } },
    ])).toContain('check_drinking_window');
    expect(policy.validateDrinkabilityBatch(['wine-1'], [
      { tool: 'check_drinking_window', input: { entity_id: 'wine-1' } },
    ])).toBeNull();
  });

  it('builds a typed pending drinkability directive', () => {
    const policy = new AgentContractPolicy();

    expect(policy.buildPendingDrinkabilityDirective(['wine-1', 'wine-2'])).toEqual({
      kind: 'pending_drinkability_check',
      entityIds: ['wine-1', 'wine-2'],
    });
  });
});
