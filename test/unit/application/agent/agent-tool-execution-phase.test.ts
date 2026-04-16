import { describe, expect, it, vi } from 'vitest';
import { AgentToolExecutionPhase } from '../../../../src/application/agent/agent-tool-execution-phase.js';
import { createAgentExecutionState } from '../../../../src/application/agent/agent-execution-state.js';
import type { PlannerPhaseResult } from '../../../../src/application/agent/agent-planner-phase-runner.js';
import type { AgentToolDeps } from '../../../../src/application/agent/agent-tools.js';
import { DEFAULT_AGENT_CONFIG } from '../../../../src/domain/agent/model/agent-config.js';
import { StepBudget } from '../../../../src/domain/agent/service/step-budget.js';
import type { SearchResponseV1 } from '../../../../src/domain/response/model/search-response.js';
import { PolicyBlockedError } from '../../../../src/domain/shared/error/policy-blocked.js';

function makeSearchResponse(): SearchResponseV1 {
  return {
    queryType: 'search',
    results: [
      {
        entity: {
          entityId: 'wine-1',
          canonicalLabel: 'Opus One 2018',
          type: 'wine',
          producer: 'Opus One',
          region: 'Napa Valley',
        },
        relevanceScore: 0.95,
        match: {
          matchType: 'hybrid',
          scoreComponents: {
            lexical: 0.9,
            semantic: 0.9,
            attribute: 0.8,
            popularity: 0.5,
            preferenceAlignment: 0.5,
          },
        },
        constraints: { matched: [], unmet: [], inferred: [] },
        uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
        evidenceItems: [],
      },
    ],
    engineDecision: {
      decisionStatus: 'resolved',
      nextAction: 'return_result',
      route: 'hybrid',
      decisionConfidence: 0.9,
      confidenceSemantics: 'calibrated_decision_confidence',
      decisionTraceRef: 'trace-1',
      decisionSnapshot: {
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1',
        threshold_profile_id: 'default',
        planner_version: '1',
        feature_flags: {},
      },
    },
    meta: {
      requestId: 'req-1',
      queryTimeMs: 10,
      route: 'hybrid',
      version: '1.0.0',
      engine_schema_version: 'search_response_v1',
    },
  };
}

function makeEmptySearchResponse(): SearchResponseV1 {
  return {
    ...makeSearchResponse(),
    results: [],
  };
}

function plannerPhase(parsed: PlannerPhaseResult['parsed']): PlannerPhaseResult {
  return {
    stepStartMs: Date.now(),
    parsed,
    inputTokens: 11,
    outputTokens: 7,
    wasTruncated: false,
  };
}

function makePhase(toolDeps: AgentToolDeps) {
  const runDrinkabilityChecks = vi.fn().mockResolvedValue(true);
  return {
    phase: new AgentToolExecutionPhase({
      toolDeps,
      contractExecutionPhase: { runDrinkabilityChecks },
    }),
    runDrinkabilityChecks,
  };
}

describe('AgentToolExecutionPhase', () => {
  it('normalizes exact metadata search input before executing a specific SKU lookup', async () => {
    const execute = vi.fn().mockResolvedValue(makeSearchResponse());
    const { phase, runDrinkabilityChecks } = makePhase({
      searchUseCase: { execute } as never,
    });
    const state = createAgentExecutionState();
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 5 });

    const shouldBreak = await phase.run(
      'req-exact',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: true },
      plannerPhase({
        thought: 'exact metadata lookup',
        action: {
          tool: 'search_wines',
          input: { query: 'opus one', country: 'United States', vintage_min: 2018 },
        },
      }),
    );

    expect(shouldBreak).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    const [searchRequest] = execute.mock.calls[0]!;
    expect(searchRequest).toMatchObject({ query: 'opus one', limit: 1 });
    expect(searchRequest).not.toHaveProperty('filters');
    expect(runDrinkabilityChecks).toHaveBeenCalledTimes(1);
    expect(state.lastSearchResult).toBeDefined();
    expect(state.lastSearchResult?.results[0]?.entity.entityId).toBe('wine-1');
    expect(state.steps[0]?.action?.input).toEqual({ query: 'opus one', limit: 1 });
  });

  it('injects a refinement hint once when search returns a no-match observation', async () => {
    const execute = vi.fn().mockResolvedValue(makeEmptySearchResponse());
    const { phase } = makePhase({
      searchUseCase: { execute } as never,
    });
    const state = createAgentExecutionState();
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 5 });

    const firstShouldBreak = await phase.run(
      'req-refine',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
      plannerPhase({
        thought: 'search strict constraints',
        action: { tool: 'search_wines', input: { query: 'rare wine under impossible budget' } },
      }),
    );
    const firstHint = state.pendingRefinementHint;

    const secondShouldBreak = await phase.run(
      'req-refine',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
      plannerPhase({
        thought: 'search again',
        action: { tool: 'search_wines', input: { query: 'different impossible budget' } },
      }),
    );

    expect(firstShouldBreak).toBe(false);
    expect(secondShouldBreak).toBe(false);
    expect(firstHint).toContain('HINT:');
    expect(state.pendingRefinementHint).toBe(firstHint);
    expect(state.hasInjectedRefinementHint).toBe(true);
  });

  it('blocks oversized parallel batches without executing any tool', async () => {
    const execute = vi.fn().mockResolvedValue(makeSearchResponse());
    const { phase } = makePhase({
      searchUseCase: { execute } as never,
    });
    const state = createAgentExecutionState();
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 8 });

    const shouldBreak = await phase.run(
      'req-batch',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
      plannerPhase({
        thought: 'too much parallelism',
        actions: [
          { tool: 'search_wines', input: { query: 'a' } },
          { tool: 'search_wines', input: { query: 'b' } },
          { tool: 'search_wines', input: { query: 'c' } },
          { tool: 'search_wines', input: { query: 'd' } },
          { tool: 'search_wines', input: { query: 'e' } },
        ],
      }),
    );

    expect(shouldBreak).toBe(true);
    expect(state.terminationReason).toBe('error');
    expect(state.steps[0]?.actionPairs).toHaveLength(4);
    expect(state.toolOutcomes).toHaveLength(4);
    expect(execute).not.toHaveBeenCalled();
  });

  it('enforces pending drinkability checks before allowing another non-drinkability tool', async () => {
    const execute = vi.fn().mockResolvedValue(makeSearchResponse());
    const { phase } = makePhase({
      searchUseCase: { execute } as never,
    });
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
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 5 });

    const shouldBreak = await phase.run(
      'req-contract',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: false },
      plannerPhase({
        thought: 'continue searching instead',
        action: { tool: 'search_wines', input: { query: 'another wine' } },
      }),
    );

    expect(shouldBreak).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(state.steps[0]?.observation).toContain('Tool contract violation');
    expect(state.toolOutcomes.at(-1)).toMatchObject({
      tool: 'search_wines',
      kind: 'policy_violation',
    });
  });

  it('rejects pending drinkability checks that target the wrong entity id', async () => {
    const execute = vi.fn();
    const { phase } = makePhase({
      searchUseCase: { execute } as never,
    });
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
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 5 });

    const shouldBreak = await phase.run(
      'req-wrong-contract-id',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: false },
      plannerPhase({
        thought: 'check wrong wine',
        action: { tool: 'check_drinking_window', input: { entity_id: 'wine-2' } },
      }),
    );

    expect(shouldBreak).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(state.steps[0]?.observation).toContain('check_drinking_window next for "wine-1"');
    expect(state.toolOutcomes.at(-1)).toMatchObject({
      tool: 'check_drinking_window',
      kind: 'policy_violation',
    });
  });

  it('defers direct answers when pending drinkability checks still exist', async () => {
    const { phase } = makePhase({
      searchUseCase: { execute: vi.fn() } as never,
    });
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
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 5 });

    const shouldBreak = await phase.run(
      'req-answer-gate',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: false },
      plannerPhase({
        thought: 'answer directly',
        answer: '지금 마시기 좋습니다.',
      }),
    );

    expect(shouldBreak).toBe(false);
    expect(state.answer).toBe('');
    expect(state.pendingRefinementHint).toContain('check_drinking_window');
  });

  it('rejects mixed pending-drinkability batches that omit required checks', async () => {
    const execute = vi.fn().mockResolvedValue(makeSearchResponse());
    const { phase } = makePhase({
      searchUseCase: { execute } as never,
    });
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
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 5 });

    const shouldBreak = await phase.run(
      'req-batch-contract',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: false },
      plannerPhase({
        thought: 'mix batch incorrectly',
        actions: [
          { tool: 'check_drinking_window', input: { entity_id: 'wine-2' } },
          { tool: 'search_wines', input: { query: 'another wine' } },
        ],
      }),
    );

    expect(shouldBreak).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(state.steps[0]?.observations?.[0]).toContain('Tool contract violation');
    expect(state.toolOutcomes).toHaveLength(3);
    expect(state.toolOutcomes.slice(1)).toEqual([
      expect.objectContaining({ tool: 'check_drinking_window', kind: 'policy_violation' }),
      expect.objectContaining({ tool: 'search_wines', kind: 'policy_violation' }),
    ]);
  });

  it('executes an allowed parallel batch and records both tool outcomes', async () => {
    const execute = vi.fn().mockResolvedValue(makeSearchResponse());
    const { phase, runDrinkabilityChecks } = makePhase({
      searchUseCase: { execute } as never,
    });
    const state = createAgentExecutionState();
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 8 });

    const shouldBreak = await phase.run(
      'req-batch-success',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
      plannerPhase({
        thought: 'search in parallel',
        actions: [
          { tool: 'search_wines', input: { query: 'opus one' } },
          { tool: 'search_wines', input: { query: 'sassicaia' } },
        ],
      }),
    );

    expect(shouldBreak).toBe(false);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(state.steps[0]?.actionPairs).toHaveLength(2);
    expect(state.toolOutcomes).toHaveLength(2);
    expect(state.lastSearchResult?.results[0]?.entity.entityId).toBe('wine-1');
    expect(runDrinkabilityChecks).toHaveBeenCalledTimes(1);
  });

  it('records unknown single-tool attempts without executing any dependency', async () => {
    const execute = vi.fn();
    const { phase } = makePhase({
      searchUseCase: { execute } as never,
    });
    const state = createAgentExecutionState();
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 5 });

    const shouldBreak = await phase.run(
      'req-unknown-tool',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
      plannerPhase({
        thought: 'invent a tool',
        action: { tool: 'inspect_cellar', input: { query: 'opus one' } },
      }),
    );

    expect(shouldBreak).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(state.reasoningFailureDetected).toBe(true);
    expect(state.unknownToolAttempts).toBe(1);
    expect(state.steps[0]?.observation).toContain('Unknown tool: inspect_cellar');
  });

  it('marks tool timeout when single-tool execution exceeds configured timeout', async () => {
    const execute = vi.fn().mockRejectedValue(
      Object.assign(new Error('tool timed out'), { code: 'TIMEOUT' }),
    );
    const { phase } = makePhase({
      searchUseCase: { execute } as never,
    });
    const state = createAgentExecutionState();
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 5 });

    const shouldBreak = await phase.run(
      'req-timeout-tool',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
      plannerPhase({
        thought: 'slow search',
        action: { tool: 'search_wines', input: { query: 'opus one' } },
      }),
    );

    expect(shouldBreak).toBe(true);
    expect(state.timeoutStats.tool).toBe(1);
    expect(state.terminationReason).toBe('timeout');
    expect(state.steps[0]?.observation).toContain('[TIMEOUT]');
    expect(state.toolOutcomes.at(-1)).toMatchObject({
      tool: 'search_wines',
      kind: 'timeout',
    });
  });

  it('maps policy-blocked single-tool failures into blocked termination state', async () => {
    const execute = vi.fn().mockRejectedValue(
      new PolicyBlockedError('unsafe query', { layer: 'SYSTEM', reason: 'SYSTEM_PROMPT_INJECTION' }),
    );
    const { phase } = makePhase({
      searchUseCase: { execute } as never,
    });
    const state = createAgentExecutionState();
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 5 });

    const shouldBreak = await phase.run(
      'req-policy-blocked',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
      plannerPhase({
        thought: 'blocked search',
        action: { tool: 'search_wines', input: { query: 'opus one' } },
      }),
    );

    expect(shouldBreak).toBe(true);
    expect(state.policyBlocked).toBe(true);
    expect(state.terminationReason).toBe('blocked');
    expect(state.steps[0]?.observation).toContain('Policy blocked');
    expect(state.toolOutcomes.at(-1)).toMatchObject({
      tool: 'search_wines',
      kind: 'policy_violation',
    });
  });
});
