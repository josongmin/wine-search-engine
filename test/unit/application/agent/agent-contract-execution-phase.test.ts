import { describe, expect, it, vi } from 'vitest';
import { AgentContractExecutionPhase } from '../../../../src/application/agent/agent-contract-execution-phase.js';
import { createAgentExecutionState } from '../../../../src/application/agent/agent-execution-state.js';
import type { AgentToolDeps } from '../../../../src/application/agent/agent-tools.js';
import { createCanonicalEntityId } from '../../../../src/domain/shared/types/index.js';
import { DEFAULT_AGENT_CONFIG } from '../../../../src/domain/agent/model/agent-config.js';
import { StepBudget } from '../../../../src/domain/agent/service/step-budget.js';
import { PolicyBlockedError } from '../../../../src/domain/shared/error/policy-blocked.js';

function makePendingDrinkabilityState() {
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
  return state;
}

describe('AgentContractExecutionPhase', () => {
  it('is a no-op when no drinkability entity is pending', async () => {
    const execute = vi.fn();
    const phase = new AgentContractExecutionPhase({
      toolDeps: { searchUseCase: { execute } as never },
    });
    const state = createAgentExecutionState();

    const ok = await phase.runDrinkabilityChecks(
      { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: false },
      'req-none',
      DEFAULT_AGENT_CONFIG,
      new StepBudget(DEFAULT_AGENT_CONFIG),
      state,
    );

    expect(ok).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(state.steps).toHaveLength(0);
  });

  it('runs pending drinkability checks through the typed entity projection port', async () => {
    const drinkingWindowEntityLookup = vi.fn().mockResolvedValue({
      entityId: createCanonicalEntityId('wine-1'),
      canonicalLabel: 'Wine 1',
      drinkingWindowStart: 2020,
      drinkingWindowEnd: 2030,
      drinkingWindowModelVersion: 'dw-v1',
    });
    const toolDeps: AgentToolDeps = {
      searchUseCase: { execute: vi.fn() } as never,
      drinkingWindowEntityLookup,
    };
    const phase = new AgentContractExecutionPhase({ toolDeps });
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

    const ok = await phase.runDrinkabilityChecks(
      { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: false },
      'req-dw',
      DEFAULT_AGENT_CONFIG,
      new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 5 }),
      state,
    );

    expect(ok).toBe(true);
    expect(drinkingWindowEntityLookup).toHaveBeenCalledWith(createCanonicalEntityId('wine-1'));
    expect(state.steps[0]?.actionPairs?.[0]?.action).toEqual({
      tool: 'check_drinking_window',
      input: { entity_id: 'wine-1' },
    });
    expect(state.steps[0]?.observations?.[0]).toContain('drinking window 2020-2030');
    expect(state.toolOutcomes.at(-1)).toMatchObject({
      tool: 'check_drinking_window',
      kind: 'success',
    });
  });

  it('reuses grounded drinkability projections captured from prior compare/search steps', async () => {
    const drinkingWindowEntityLookup = vi.fn();
    const entityLookup = vi.fn();
    const toolDeps: AgentToolDeps = {
      searchUseCase: { execute: vi.fn() } as never,
      drinkingWindowEntityLookup,
      entityLookup,
    };
    const phase = new AgentContractExecutionPhase({ toolDeps });
    const state = createAgentExecutionState();
    state.toolOutcomes.push({
      stepId: 'req:0:0',
      tool: 'compare_wines',
      kind: 'success',
      result: {
        queryType: 'comparison',
        entities: [
          { topResult: { entity: { entityId: 'wine-1', canonicalLabel: 'Wine 1' } } },
          { topResult: { entity: { entityId: 'wine-2', canonicalLabel: 'Wine 2' } } },
        ],
      },
      durationMs: 1,
    });
    state.groundedDrinkingWindowByEntityId.set('wine-1', {
      entityId: createCanonicalEntityId('wine-1'),
      canonicalLabel: 'Wine 1',
      drinkingWindowStart: 2021,
      drinkingWindowEnd: 2032,
      drinkingWindowModelVersion: 'compare-cache-v1',
    });
    state.groundedDrinkingWindowByEntityId.set('wine-2', {
      entityId: createCanonicalEntityId('wine-2'),
      canonicalLabel: 'Wine 2',
      drinkingWindowStart: 2024,
      drinkingWindowEnd: 2036,
      drinkingWindowModelVersion: 'compare-cache-v1',
    });

    const ok = await phase.runDrinkabilityChecks(
      { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: false },
      'req-cache',
      DEFAULT_AGENT_CONFIG,
      new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 5 }),
      state,
    );

    expect(ok).toBe(true);
    expect(drinkingWindowEntityLookup).not.toHaveBeenCalled();
    expect(entityLookup).not.toHaveBeenCalled();
    expect(state.steps[0]?.observations?.[0]).toContain('Wine 1: drinking window 2021-2032');
    expect(state.steps[0]?.observations?.[1]).toContain('Wine 2: drinking window 2024-2036');
  });

  it('fails closed when budget cannot reserve the required contract checks', async () => {
    const phase = new AgentContractExecutionPhase({
      toolDeps: { searchUseCase: { execute: vi.fn() } as never },
    });
    const state = createAgentExecutionState();
    state.toolOutcomes.push({
      stepId: 'req:0:0',
      tool: 'compare_wines',
      kind: 'success',
      result: {
        queryType: 'comparison',
        entities: [
          { topResult: { entity: { entityId: 'wine-a' } } },
          { topResult: { entity: { entityId: 'wine-b' } } },
        ],
      },
      durationMs: 1,
    });

    const ok = await phase.runDrinkabilityChecks(
      { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: false },
      'req-budget',
      DEFAULT_AGENT_CONFIG,
      new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 1 }),
      state,
    );

    expect(ok).toBe(false);
    expect(state.terminationReason).toBe('max_steps');
    expect(state.steps).toHaveLength(0);
  });

  it('records timeout observations when contract drinkability checks exceed the batch timeout', async () => {
    const execute = vi.fn().mockImplementation(async () => {
      await new Promise<never>(() => {});
    });
    const phase = new AgentContractExecutionPhase({
      toolDeps: { searchUseCase: { execute } as never },
    });
    const state = makePendingDrinkabilityState();

    const ok = await phase.runDrinkabilityChecks(
      { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: false },
      'req-timeout',
      { ...DEFAULT_AGENT_CONFIG, parallelBatchTimeoutMs: 1 },
      new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 5 }),
      state,
    );

    expect(ok).toBe(false);
    expect(state.timeoutStats.parallelBatch).toBe(1);
    expect(state.terminationReason).toBe('timeout');
    expect(state.steps[0]?.observations?.[0]).toContain('[TIMEOUT]');
    expect(state.toolOutcomes.at(-1)).toMatchObject({
      tool: 'check_drinking_window',
      kind: 'timeout',
    });
  });

  it('records aborted contract checks when the caller aborts mid-flight', async () => {
    const abortController = new AbortController();
    const execute = vi.fn().mockImplementation(async (_request, _requestId, options) => {
      await new Promise<never>((_resolve, reject) => {
        options?.abortSignal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
        abortController.abort();
      });
    });
    const phase = new AgentContractExecutionPhase({
      toolDeps: { searchUseCase: { execute } as never },
    });
    const state = makePendingDrinkabilityState();

    const ok = await phase.runDrinkabilityChecks(
      { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: false },
      'req-abort',
      DEFAULT_AGENT_CONFIG,
      new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 5 }),
      state,
      abortController.signal,
    );

    expect(ok).toBe(false);
    expect(state.terminationReason).toBe('aborted');
    expect(state.steps[0]?.observations?.[0]).toContain('[ABORTED]');
    expect(state.toolOutcomes.at(-1)).toMatchObject({
      tool: 'check_drinking_window',
      kind: 'tool_error',
    });
  });

  it('propagates policy-blocked contract checks into blocked termination state', async () => {
    const execute = vi.fn().mockRejectedValue(
      new PolicyBlockedError('unsafe contract tool', { layer: 'SYSTEM', reason: 'SYSTEM_PROMPT_INJECTION' }),
    );
    const phase = new AgentContractExecutionPhase({
      toolDeps: { searchUseCase: { execute } as never },
    });
    const state = makePendingDrinkabilityState();

    const ok = await phase.runDrinkabilityChecks(
      { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: false },
      'req-blocked',
      DEFAULT_AGENT_CONFIG,
      new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 5 }),
      state,
    );

    expect(ok).toBe(false);
    expect(state.policyBlocked).toBe(true);
    expect(state.terminationReason).toBe('blocked');
    expect(state.steps[0]?.observations?.[0]).toContain('Policy blocked');
    expect(state.toolOutcomes.at(-1)).toMatchObject({
      tool: 'check_drinking_window',
      kind: 'policy_violation',
    });
  });
});
