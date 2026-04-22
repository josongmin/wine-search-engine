import { describe, expect, it, vi } from 'vitest';
import { AgentToolExecutionPhase } from '../../../../src/application/agent/agent-tool-execution-phase.js';
import { createAgentExecutionState } from '../../../../src/application/agent/agent-execution-state.js';
import type { PlannerPhaseResult } from '../../../../src/application/agent/agent-planner-phase-runner.js';
import type { AgentToolDeps } from '../../../../src/application/agent/agent-tools.js';
import { DEFAULT_AGENT_CONFIG } from '../../../../src/domain/agent/model/agent-config.js';
import { StepBudget } from '../../../../src/domain/agent/service/step-budget.js';
import type { SearchResponseV1 } from '../../../../src/domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../../../src/domain/response/model/comparison-response.js';
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

function makeComparisonResponse(): ComparisonSearchResponse {
  return {
    queryType: 'comparison',
    originalQuery: 'Barolo vs Brunello',
    comparisonIntent: 'compare',
    entities: [
      {
        subQuery: 'Barolo',
        topResult: {
          entity: {
            entityId: 'wine-barolo-2018',
            canonicalLabel: 'Barolo 2018',
            type: 'wine',
          },
          relevanceScore: 0.95,
          match: {
            matchType: 'alias_exact',
            scoreComponents: {
              lexical: 0.9,
              semantic: 0.9,
              attribute: 0.9,
              popularity: 0.5,
            },
          },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
          drinkingWindow: {
            drinkingWindowStart: 2024,
            drinkingWindowEnd: 2034,
            currentlyDrinkable: true,
            confidence: 'medium',
            modelVersion: 'compare-dw-v1',
          },
        },
        resultCount: 1,
        resolutionStatus: 'resolved',
        allResults: [],
      },
      { subQuery: 'Brunello', topResult: null, resultCount: 0, resolutionStatus: 'ambiguous', allResults: [] },
    ],
    overallStatus: 'resolved',
    requestId: 'req-compare',
    executionTimeMs: 5,
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
    expect(searchRequest).toMatchObject({ query: 'opus one wine' });
    expect(searchRequest?.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: 'country', operator: '=', value: 'United States' }),
      expect.objectContaining({ attribute: 'vintage_year', operator: '>=', value: 2018 }),
    ]));
    expect(runDrinkabilityChecks).toHaveBeenCalledTimes(1);
    expect(state.lastSearchResult).toBeDefined();
    expect(state.lastSearchResult?.results[0]?.entity.entityId).toBe('wine-1');
    expect(state.steps[0]?.action?.input).toEqual({
      query: 'opus one',
      country: 'United States',
      vintage_min: 2018,
    });
  });

  it('executes the required food-pairing tool when the planner emitted search_wines for a pairing contract', async () => {
    const execute = vi.fn().mockResolvedValue(makeSearchResponse());
    const { phase } = makePhase({
      searchUseCase: { execute } as never,
    });
    const state = createAgentExecutionState();
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 5 });

    const shouldBreak = await phase.run(
      'req-pairing-reroute',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
        requiredTool: 'get_food_pairings',
        foodPairing: { food: '회 먹을 건데 와인 추천해줘', pairingTags: ['white_fish'] },
      },
      plannerPhase({
        thought: 'planner picked generic search',
        action: {
          tool: 'search_wines',
          input: { query: '회 먹을 건데 와인 추천해줘', wine_type: 'white' },
        },
      }),
    );

    expect(shouldBreak).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    const [searchRequest] = execute.mock.calls[0]!;
    expect(searchRequest?.query).toContain('wine pairing for 회 먹을 건데 와인 추천해줘');
    expect(searchRequest?.query).not.toContain('white wine');
    expect(searchRequest?.options).toEqual({ mode: 'hybrid', explain: false, clarification: false });
    expect(state.steps[0]?.action).toEqual({
      tool: 'get_food_pairings',
      input: {
        food: '회 먹을 건데 와인 추천해줘',
        color: 'white',
        pairing_tags: ['white_fish'],
      },
    });
    expect(state.toolOutcomes[0]?.tool).toBe('get_food_pairings');
  });

  it('executes explicit red plus white single-search defects as a repaired parallel batch', async () => {
    const execute = vi.fn().mockResolvedValue(makeSearchResponse());
    const { phase } = makePhase({
      searchUseCase: { execute } as never,
    });
    const state = createAgentExecutionState();
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 8 });

    const shouldBreak = await phase.run(
      'req-red-white-repair',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
        searchDefaults: { occasion: ['gift'] },
        requiredParallelSearches: [
          { wineType: 'red', limit: 1 },
          { wineType: 'white', limit: 1 },
        ],
      },
      plannerPhase({
        thought: 'planner collapsed the set into one search',
        action: {
          tool: 'search_wines',
          input: { query: '커플 세트로 레드 화이트 한 병씩, 예쁜 거' },
        },
      }),
    );

    expect(shouldBreak).toBe(false);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(state.steps[0]?.actions).toEqual([
      {
        tool: 'search_wines',
        input: {
          query: '커플 세트로 레드 한 병씩 예쁜 거',
          occasion: ['gift'],
          wine_type: 'red',
          limit: 1,
        },
      },
      {
        tool: 'search_wines',
        input: {
          query: '커플 세트로 화이트 한 병씩 예쁜 거',
          occasion: ['gift'],
          wine_type: 'white',
          limit: 1,
        },
      },
    ]);
    expect(state.toolOutcomes).toEqual([
      expect.objectContaining({ tool: 'search_wines', kind: 'success' }),
      expect.objectContaining({ tool: 'search_wines', kind: 'success' }),
    ]);
  });

  it('surfaces planner repair provenance while still executing repaired parallel batches', async () => {
    const execute = vi.fn().mockResolvedValue(makeSearchResponse());
    const { phase } = makePhase({
      searchUseCase: { execute } as never,
    });
    const state = createAgentExecutionState();
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 5 });

    const shouldBreak = await phase.run(
      'req-partial-batch',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
      plannerPhase({
        thought: 'run what survived',
        actions: [
          { tool: 'search_wines', input: { query: 'barolo' } },
          { tool: 'get_food_pairings', input: { food: 'steak' } },
        ],
        plannerRepair: {
          code: 'partial_actions_batch',
          observation: 'Recovered 2 valid action(s) while dropping 1 invalid batch item(s).',
          rawText: '{"actions":[...]}',
          recoveredFrom: 'actions',
        },
      }),
    );

    expect(shouldBreak).toBe(false);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(state.reasoningFailureDetected).toBe(true);
    expect(state.steps[0]?.observations?.[0]).toContain('[PLANNER_REPAIR] Recovered 2 valid action(s)');
    expect(state.steps[0]?.observations?.[1]).toContain('[PLANNER_REPAIR] Recovered 2 valid action(s)');
    expect(state.steps[0]?.actions).toHaveLength(2);
  });

  it('surfaces planner repair provenance on repaired single-tool execution', async () => {
    const execute = vi.fn().mockResolvedValue(makeSearchResponse());
    const { phase } = makePhase({
      searchUseCase: { execute } as never,
    });
    const state = createAgentExecutionState();
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 5 });

    const shouldBreak = await phase.run(
      'req-embedded-repair',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
      plannerPhase({
        thought: 'recovered tool',
        action: { tool: 'search_wines', input: { query: 'barolo' } },
        plannerRepair: {
          code: 'embedded_tool_recovery',
          observation: 'Recovered embedded tool call from malformed planner output.',
          rawText: '{"thought":"..."}',
          recoveredFrom: 'embedded_json',
        },
      }),
    );

    expect(shouldBreak).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(state.reasoningFailureDetected).toBe(true);
    expect(state.steps[0]?.observation).toContain('[PLANNER_REPAIR] Recovered embedded tool call');
  });

  it('hydrates drinkability checks from grounded comparison projections across steps', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('search fallback must not run'));
    const decomposedSearchExecute = vi.fn().mockResolvedValue(makeComparisonResponse());
    const { phase } = makePhase({
      searchUseCase: { execute } as never,
      decomposedSearchExecute,
    });
    const state = createAgentExecutionState();
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 5 });

    const compareShouldBreak = await phase.run(
      'req-compare-cache',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: true },
      plannerPhase({
        thought: 'compare first',
        action: {
          tool: 'compare_wines',
          input: {
            query_a: 'barolo 2018',
            query_b: 'brunello 2018',
          },
        },
      }),
    );

    const checkShouldBreak = await phase.run(
      'req-compare-cache',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: true },
      plannerPhase({
        thought: 'verify drinkability',
        action: {
          tool: 'check_drinking_window',
          input: {
            entity_id: 'wine-barolo-2018',
            target_year: 2026,
          },
        },
      }),
    );

    expect(compareShouldBreak).toBe(false);
    expect(checkShouldBreak).toBe(false);
    expect(decomposedSearchExecute).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(state.groundedDrinkingWindowByEntityId.get('wine-barolo-2018')).toMatchObject({
      canonicalLabel: 'Barolo 2018',
      drinkingWindowStart: 2024,
      drinkingWindowEnd: 2034,
      drinkingWindowModelVersion: 'compare-dw-v1',
    });
    expect(state.steps[1]?.observation).toContain('Barolo 2018: drinking window 2024-2034');
    expect(state.steps[1]?.observation).toContain('currently drinkable');
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
    const firstDirective = state.pendingPlannerDirective;

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
    expect(firstDirective).toEqual({ kind: 'relax_constraints_retry' });
    expect(state.pendingPlannerDirective).toBe(firstDirective);
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
    expect(state.pendingPlannerDirective).toEqual({
      kind: 'pending_drinkability_check',
      entityIds: ['wine-1'],
    });
  });

  it('defers direct answers when a generic decanting request still requires grounded search', async () => {
    const { phase } = makePhase({
      searchUseCase: { execute: vi.fn() } as never,
    });
    const state = createAgentExecutionState();
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 5 });

    const shouldBreak = await phase.run(
      'req-grounded-search',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
        requiresGroundedWineSearch: true,
      },
      plannerPhase({
        thought: 'just answer from general knowledge',
        answer: '디캔팅 필요한 와인은 미리 알려드릴게요.',
      }),
    );

    expect(shouldBreak).toBe(false);
    expect(state.answer).toBe('');
    expect(state.pendingPlannerDirective).toEqual({
      kind: 'grounded_search_required',
      instruction: 'This request still requires a grounded wine search before answering. Call search_wines first and answer only from the returned evidence.',
    });
  });

  it('defers direct answers while a refinement retry is still pending', async () => {
    const { phase } = makePhase({
      searchUseCase: { execute: vi.fn() } as never,
    });
    const state = createAgentExecutionState();
    state.pendingRefinementRetry = true;
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 5 });

    const shouldBreak = await phase.run(
      'req-refinement-retry',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
      plannerPhase({
        thought: 'answer after empty search',
        answer: '검색 결과가 없었습니다.',
      }),
    );

    expect(shouldBreak).toBe(false);
    expect(state.answer).toBe('');
    expect(state.pendingPlannerDirective).toEqual({ kind: 'relax_constraints_retry' });
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

  it('rejects compare_wines mixed batches without dropping other calls', async () => {
    const searchExecute = vi.fn().mockResolvedValue(makeSearchResponse());
    const decomposedSearchExecute = vi.fn();
    const { phase, runDrinkabilityChecks } = makePhase({
      searchUseCase: { execute: searchExecute } as never,
      decomposedSearchExecute,
    });
    const state = createAgentExecutionState();
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 8 });

    const shouldBreak = await phase.run(
      'req-compare-mix',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
      plannerPhase({
        thought: 'bad mixed compare batch',
        actions: [
          { tool: 'compare_wines', input: { query_a: 'Barolo', query_b: 'Brunello' } },
          { tool: 'search_wines', input: { query: 'barolo' } },
        ],
      }),
    );

    expect(shouldBreak).toBe(false);
    expect(searchExecute).not.toHaveBeenCalled();
    expect(decomposedSearchExecute).not.toHaveBeenCalled();
    expect(state.steps[0]?.actions).toEqual([
      { tool: 'compare_wines', input: { query_a: 'Barolo', query_b: 'Brunello' } },
      { tool: 'search_wines', input: { query: 'barolo' } },
    ]);
    expect(state.steps[0]?.actionPairs).toHaveLength(2);
    expect(state.reasoningFailureDetected).toBe(true);
    expect(state.steps[0]?.observations?.every((observation) =>
      observation.includes('compare_wines cannot share a parallel batch'),
    )).toBe(true);
    expect(state.toolOutcomes).toEqual([
      expect.objectContaining({ tool: 'compare_wines', kind: 'policy_violation' }),
      expect.objectContaining({ tool: 'search_wines', kind: 'policy_violation' }),
    ]);
    expect(runDrinkabilityChecks).not.toHaveBeenCalled();
  });

  it('records an explicit defect for compare plus unresolved drinkability placeholders without dropping calls', async () => {
    const decomposedSearchExecute = vi.fn().mockResolvedValue(makeComparisonResponse());
    const { phase, runDrinkabilityChecks } = makePhase({
      searchUseCase: { execute: vi.fn() } as never,
      decomposedSearchExecute,
    });
    const state = createAgentExecutionState();
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 8 });

    const shouldBreak = await phase.run(
      'req-compare-placeholder-repair',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: false },
      plannerPhase({
        thought: 'compare then check returned ids',
        actions: [
          { tool: 'compare_wines', input: { query_a: 'Barolo', query_b: 'Brunello' } },
          { tool: 'check_drinking_window', input: { entity_id: '__TO_BE_FILLED__' } },
          { tool: 'check_drinking_window', input: { entity_id: '<to_be_filled_later>' } },
        ],
      }),
    );

    expect(shouldBreak).toBe(false);
    expect(decomposedSearchExecute).not.toHaveBeenCalled();
    expect(state.steps[0]?.actions).toEqual([
      {
        tool: 'compare_wines',
        input: { query_a: 'Barolo', query_b: 'Brunello', drinking_window: 'now' },
      },
      {
        tool: 'check_drinking_window',
        input: { entity_id: '__TO_BE_FILLED__' },
      },
      {
        tool: 'check_drinking_window',
        input: { entity_id: '<to_be_filled_later>' },
      },
    ]);
    expect(state.reasoningFailureDetected).toBe(true);
    expect(state.steps[0]?.observations?.every((observation) =>
      observation.includes('Deferred drinkability placeholders cannot run in the same batch'),
    )).toBe(true);
    expect(state.toolOutcomes).toEqual([
      expect.objectContaining({ tool: 'compare_wines', kind: 'policy_violation' }),
      expect.objectContaining({ tool: 'check_drinking_window', kind: 'policy_violation' }),
      expect.objectContaining({ tool: 'check_drinking_window', kind: 'policy_violation' }),
    ]);
    expect(runDrinkabilityChecks).not.toHaveBeenCalled();
  });

  it('records an explicit defect for search plus unresolved drinkability placeholder without dropping calls', async () => {
    const searchExecute = vi.fn().mockResolvedValue(makeSearchResponse());
    const { phase, runDrinkabilityChecks } = makePhase({
      searchUseCase: { execute: searchExecute } as never,
    });
    const state = createAgentExecutionState();
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 8 });

    const shouldBreak = await phase.run(
      'req-search-placeholder-repair',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: false },
      plannerPhase({
        thought: 'search then check returned id',
        actions: [
          { tool: 'search_wines', input: { query: 'Opus One 2018' } },
          { tool: 'check_drinking_window', input: { entity_id: '<top_result_entity_id>' } },
        ],
      }),
    );

    expect(shouldBreak).toBe(false);
    expect(searchExecute).not.toHaveBeenCalled();
    expect(state.steps[0]?.actions).toEqual([
      { tool: 'search_wines', input: { query: 'Opus One 2018' } },
      { tool: 'check_drinking_window', input: { entity_id: '<top_result_entity_id>' } },
    ]);
    expect(state.reasoningFailureDetected).toBe(true);
    expect(state.steps[0]?.observations?.every((observation) =>
      observation.includes('Deferred drinkability placeholders cannot run in the same batch'),
    )).toBe(true);
    expect(state.toolOutcomes).toEqual([
      expect.objectContaining({ tool: 'search_wines', kind: 'policy_violation' }),
      expect.objectContaining({ tool: 'check_drinking_window', kind: 'policy_violation' }),
    ]);
    expect(runDrinkabilityChecks).not.toHaveBeenCalled();
  });

  it('collapses duplicate compare calls with lossless non-conflicting constraint union', async () => {
    const decomposedSearchExecute = vi.fn().mockResolvedValue(makeComparisonResponse());
    const { phase } = makePhase({
      searchUseCase: { execute: vi.fn() } as never,
      decomposedSearchExecute,
    });
    const state = createAgentExecutionState();
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 8 });

    const shouldBreak = await phase.run(
      'req-compare-duplicate',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
      plannerPhase({
        thought: 'duplicate side-specific compare batch',
        actions: [
          {
            tool: 'compare_wines',
            input: {
              query_a: 'Barolo',
              query_b: 'Brunello',
              max_price_krw: 100000,
              styles: ['structured'],
            },
          },
          {
            tool: 'compare_wines',
            input: {
              query_a: 'Barolo',
              query_b: 'Brunello',
              country: 'Italy',
              max_price_krw: 100000,
              styles: ['savory', 'structured'],
            },
          },
        ],
      }),
    );

    expect(shouldBreak).toBe(false);
    expect(decomposedSearchExecute).toHaveBeenCalledOnce();
    expect(state.steps[0]?.actions).toEqual([
      {
        tool: 'compare_wines',
        input: {
          query_a: 'Barolo',
          query_b: 'Brunello',
          country: 'Italy',
          max_price_krw: 100000,
          styles: ['structured', 'savory'],
        },
      },
    ]);
    const [subQueries, , , , , parentContext, , retrievalSubQueries] = decomposedSearchExecute.mock.calls[0] ?? [];
    expect(subQueries).toEqual(['Barolo', 'Brunello']);
    expect(parentContext?.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: 'country', operator: '=', value: 'Italy' }),
    ]));
    expect(retrievalSubQueries[0]).toContain('100000원 이하');
    expect(retrievalSubQueries[1]).toContain('100000원 이하');
  });

  it('records an explicit defect for conflicting duplicate compare constraints', async () => {
    const decomposedSearchExecute = vi.fn().mockResolvedValue(makeComparisonResponse());
    const { phase } = makePhase({
      searchUseCase: { execute: vi.fn() } as never,
      decomposedSearchExecute,
    });
    const state = createAgentExecutionState();
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 8 });

    const shouldBreak = await phase.run(
      'req-compare-duplicate-conflict',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
      plannerPhase({
        thought: 'conflicting duplicate compare batch',
        actions: [
          {
            tool: 'compare_wines',
            input: { query_a: '바롤로', query_b: '브루넬로', appellation: 'Barolo', max_price_krw: 100000 },
          },
          {
            tool: 'compare_wines',
            input: { query_a: '바롤로', query_b: '브루넬로', appellation: 'Brunello di Montalcino', max_price_krw: 100000 },
          },
        ],
      }),
    );

    expect(shouldBreak).toBe(false);
    expect(decomposedSearchExecute).not.toHaveBeenCalled();
    expect(state.steps[0]?.actions).toEqual([
      {
        tool: 'compare_wines',
        input: { query_a: '바롤로', query_b: '브루넬로', appellation: 'Barolo', max_price_krw: 100000 },
      },
      {
        tool: 'compare_wines',
        input: { query_a: '바롤로', query_b: '브루넬로', appellation: 'Brunello di Montalcino', max_price_krw: 100000 },
      },
    ]);
    expect(state.reasoningFailureDetected).toBe(true);
    expect(state.steps[0]?.observations?.[0]).toContain('conflicting duplicate compare_wines constraints');
    expect(state.steps[0]?.observations?.[0]).toContain('appellation');
    expect(state.toolOutcomes).toEqual([
      expect.objectContaining({ tool: 'compare_wines', kind: 'policy_violation' }),
      expect.objectContaining({ tool: 'compare_wines', kind: 'policy_violation' }),
    ]);
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
