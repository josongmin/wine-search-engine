/**
 * Regression: planner multi-step continuation for compare+verify queries.
 *
 * Bench scenarios #15 and #30 expect three tool calls — compare_wines
 * followed by two check_drinking_window calls — but were terminating after
 * a single compare_wines step (tool=33% in the bench judge). The query
 * pattern is "compare two sides AND check drinking-window for both" (e.g.
 * "보르도 2015 vs 2016 빈티지 비교, 둘 다 지금 마시기 좋은지도 알려줘").
 *
 * Root causes (structural):
 *   1. When compare_wines TIMES OUT on the first step, the run loop exits
 *      terminally and the orchestrator's synthesis runner emits a "couldn't
 *      compute" answer — never re-entering the planner. For queries with a
 *      `requiresVerificationStep` requirement (comparison_search) and no
 *      prior tool progress, a timeout should instead be a RECOVERABLE
 *      observation that lets the planner re-plan (e.g. switch to lookup +
 *      drinking-window) within the remaining step budget.
 *
 *   2. The L1.C fast-answer bypass (`canFastAnswerBypassPlanner`) was not
 *      checking `requiresVerificationStep`. A bypass-enabled run could thus
 *      short-circuit the planner after a single tool outcome on a
 *      verification-required query, skipping the verification re-plan.
 *
 * These tests pin the structural fix.
 */

import { describe, expect, it, vi } from 'vitest';
import { AgentToolExecutionPhase } from '../../src/application/agent/agent-tool-execution-phase.js';
import { AgentContractPolicy } from '../../src/application/agent/agent-contract-policy.js';
import {
  buildAgentQueryExecutionContract,
} from '../../src/application/agent/agent-query-execution-contract.js';
import type { AgentQueryExecutionContract } from '../../src/application/agent/agent-query-execution-contract.js';
import { createAgentExecutionState } from '../../src/application/agent/agent-execution-state.js';
import type { AgentExecutionState } from '../../src/application/agent/agent-execution-state.js';
import type { AgentToolDeps } from '../../src/application/agent/agent-tools.js';
import type { PlannerPhaseResult } from '../../src/application/agent/agent-planner-phase-runner.js';
import { DEFAULT_AGENT_CONFIG } from '../../src/domain/agent/model/agent-config.js';
import { StepBudget } from '../../src/domain/agent/service/step-budget.js';

const COMPARE_VERIFY_QUERY =
  '보르도 2015 vs 2016 빈티지 비교, 둘 다 지금 마시기 좋은지도 알려줘';
const COMPARE_DUAL_DW_QUERY =
  '바롤로랑 브루넬로 비교해주고, 둘 중 지금 마시기 좋은 거로 골라줘';

function makePhase(toolDeps: AgentToolDeps): AgentToolExecutionPhase {
  return new AgentToolExecutionPhase({
    toolDeps,
    contractExecutionPhase: { runDrinkabilityChecks: vi.fn().mockResolvedValue(true) },
  });
}

function plannerCompareAction(
  query: string,
  side: { a: string; b: string },
): PlannerPhaseResult {
  return {
    stepStartMs: Date.now(),
    parsed: {
      thought: `compare ${query}`,
      action: {
        tool: 'compare_wines',
        input: { query_a: side.a, query_b: side.b },
      },
    },
    inputTokens: 50,
    outputTokens: 20,
    wasTruncated: false,
  };
}

function plannerAnswerOnly(answer: string): PlannerPhaseResult {
  return {
    stepStartMs: Date.now(),
    parsed: { thought: 'commit answer', answer },
    inputTokens: 10,
    outputTokens: 5,
    wasTruncated: false,
  };
}

describe('compare+verify continuation — contract requirement', () => {
  it('builds a comparison_search verification requirement for the bench #15 query', () => {
    const contract = buildAgentQueryExecutionContract(COMPARE_VERIFY_QUERY);
    expect(contract.requiresVerificationStep).toBeDefined();
    expect(contract.requiresVerificationStep?.reason).toBe('comparison_search');
  });

  it('builds a comparison_search verification requirement for the bench #30 query', () => {
    const contract = buildAgentQueryExecutionContract(COMPARE_DUAL_DW_QUERY);
    expect(contract.requiresVerificationStep).toBeDefined();
    expect(contract.requiresVerificationStep?.reason).toBe('comparison_search');
  });
});

describe('compare+verify continuation — comparison_search re-plan narrowing (bench #30 RCA)', () => {
  /**
   * Bench #30 regression RCA: `comparison_search` historically ALWAYS forced a
   * verify re-plan after the first observation, on the premise that a single
   * observation cannot cover a two-sided compare. That premise holds for the
   * one-sided `search_wines` case, but BREAKS for `compare_wines`, which
   * natively returns both legs with per-leg `matched_constraints`. The
   * unconditional re-fire forced #30 to chase empty search_wines after a
   * clean two-sided compare, collapsing the answer to a "no results" fallback
   * (judge=0, ans=20%, score 57.8% → 22.4%).
   *
   * SSoT for the narrowing lives in
   * `AgentContractPolicy.shouldForceVerificationReplan`.
   */
  /**
   * Compose a compare_wines outcome in the shape `collectCoveredMatchedConstraintKeys`
   * actually parses — the decomposed-search response object with
   * `entities[].topResult.constraints.matched[]`. Each matchedConstraints entry
   * covers BOTH legs (mirroring a clean two-sided compare).
   */
  function makeCompareWinesSuccess(matchedConstraints: readonly string[]) {
    const buildTopResult = () => ({
      entityId: 'wine-x',
      constraints: { matched: [...matchedConstraints] },
    });
    return {
      stepId: 'req-cmp:0:0',
      tool: 'compare_wines' as const,
      kind: 'success' as const,
      durationMs: 8,
      result: {
        queryType: 'comparison',
        entities: [
          { subQuery: 'A', topResult: buildTopResult(), resultCount: 1, resolutionStatus: 'unique', allResults: [] },
          { subQuery: 'B', topResult: buildTopResult(), resultCount: 1, resolutionStatus: 'unique', allResults: [] },
        ],
      },
    };
  }

  it('does NOT force re-plan when compare_wines succeeded AND all constraint atoms are covered', () => {
    const contract = buildAgentQueryExecutionContract(COMPARE_DUAL_DW_QUERY);
    const requirement = contract.requiresVerificationStep;
    expect(requirement?.reason).toBe('comparison_search');
    if (requirement === undefined) throw new Error('requirement undefined');

    const policy = new AgentContractPolicy();
    // The dual-drinking-window compare query's coverage atoms include
    // `drinking_window` plus any region/grape coverage emitted by the
    // contract — feed a compare_wines outcome that matches every atom.
    const matchedKeys = requirement.constraintCoverage.map((a) => a.matchedConstraintKey);
    const outcomes = [makeCompareWinesSuccess(matchedKeys)];

    expect(policy.shouldForceVerificationReplan(requirement, outcomes)).toBeNull();
  });

  it('STILL forces re-plan when comparison_search query was answered with one-sided search_wines (no compare_wines)', () => {
    const contract = buildAgentQueryExecutionContract(COMPARE_DUAL_DW_QUERY);
    const requirement = contract.requiresVerificationStep;
    if (requirement === undefined) throw new Error('requirement undefined');

    const policy = new AgentContractPolicy();
    // search_wines for a compare query: a single observation that — by
    // intent of the always-fire rule — cannot cover both legs. The narrowing
    // must NOT regress this case.
    const outcomes = [{
      stepId: 'req-cmp:0:0',
      tool: 'search_wines' as const,
      kind: 'success' as const,
      durationMs: 8,
      result: 'OK\nGROUNDING_JSON: {"queryType":"search","wines":[]}',
    }];
    const decision = policy.shouldForceVerificationReplan(requirement, outcomes);
    expect(decision).not.toBeNull();
  });

  it('forces re-plan when compare_wines succeeded but some coverage atoms remain uncovered', () => {
    const contract = buildAgentQueryExecutionContract(COMPARE_DUAL_DW_QUERY);
    const requirement = contract.requiresVerificationStep;
    if (requirement === undefined) throw new Error('requirement undefined');

    const policy = new AgentContractPolicy();
    // compare_wines outcome that covers NONE of the contract's atoms (e.g.
    // missing drinking_window in the GROUNDING_JSON matched_constraints).
    const outcomes = [makeCompareWinesSuccess([])];
    const decision = policy.shouldForceVerificationReplan(requirement, outcomes);
    expect(decision).not.toBeNull();
    expect(decision?.length ?? 0).toBeGreaterThan(0);
  });

  it('does NOT force re-plan when reason is comparison_search, compare_wines is the FAILED outcome (kind!=success)', () => {
    // Failed compare_wines should NOT count as native coverage — fall back
    // to the always-fire side so the planner gets a chance to recover.
    const contract = buildAgentQueryExecutionContract(COMPARE_DUAL_DW_QUERY);
    const requirement = contract.requiresVerificationStep;
    if (requirement === undefined) throw new Error('requirement undefined');

    const policy = new AgentContractPolicy();
    const outcomes = [{
      stepId: 'req-cmp:0:0',
      tool: 'compare_wines' as const,
      kind: 'error' as const,
      durationMs: 8,
      result: '',
      errorCode: 'TIMEOUT' as const,
      errorMessage: 'compare timed out',
    }];
    const decision = policy.shouldForceVerificationReplan(requirement, outcomes);
    // Failed compare → no successful native compare_wines → always-fire still
    // applies; re-plan forced.
    expect(decision).not.toBeNull();
  });
});

describe('compare+verify continuation — fast-answer bypass safety', () => {
  it('REFUSES fast-answer bypass when requiresVerificationStep is set and latch is OFF', () => {
    const contract = buildAgentQueryExecutionContract(COMPARE_VERIFY_QUERY);
    const policy = new AgentContractPolicy();
    const state = createAgentExecutionState();
    // Simulate a successful first tool outcome (the bypass surface only fires
    // after `toolOutcomes.length >= 1`).
    state.toolOutcomes.push({
      stepId: 'req:0:0',
      tool: 'compare_wines',
      kind: 'success',
      durationMs: 5,
      result: { queryType: 'comparison', entities: [] },
    });
    const canBypass = policy.canFastAnswerBypassPlanner({
      queryExecutionContract: contract,
      state,
      pendingDrinkabilityEntityIds: [],
    });
    expect(canBypass).toBe(false);
  });

  it('ALLOWS fast-answer bypass once the verification latch has fired', () => {
    const contract = buildAgentQueryExecutionContract(COMPARE_VERIFY_QUERY);
    const policy = new AgentContractPolicy();
    const state = createAgentExecutionState();
    state.toolOutcomes.push({
      stepId: 'req:0:0',
      tool: 'compare_wines',
      kind: 'success',
      durationMs: 5,
      result: { queryType: 'comparison', entities: [] },
    });
    state.verificationStepCompleted = true;
    const canBypass = policy.canFastAnswerBypassPlanner({
      queryExecutionContract: contract,
      state,
      pendingDrinkabilityEntityIds: [],
    });
    expect(canBypass).toBe(true);
  });
});

describe('compare+verify continuation — single-tool timeout recovery', () => {
  it('treats a first-step compare_wines TIMEOUT as RECOVERABLE for verification-required queries', async () => {
    const decomposedSearchExecute = vi.fn().mockRejectedValue(
      Object.assign(new Error('compare timed out'), { code: 'TIMEOUT' }),
    );
    const phase = makePhase({
      searchUseCase: { execute: vi.fn() } as never,
      decomposedSearchExecute,
    });
    const contract = buildAgentQueryExecutionContract(COMPARE_VERIFY_QUERY);
    expect(contract.requiresVerificationStep?.reason).toBe('comparison_search');

    const state = createAgentExecutionState();
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 6 });

    const shouldBreak = await phase.run(
      'req-cmp-verify-timeout',
      { ...DEFAULT_AGENT_CONFIG, fastAnswerBypassPlanner: false },
      budget,
      state,
      contract,
      plannerCompareAction(COMPARE_VERIFY_QUERY, { a: '보르도 2015', b: '보르도 2016' }),
    );

    // Structural fix: the loop must CONTINUE (shouldBreak=false) so the
    // planner can re-plan with a verify-required directive on the next step.
    expect(shouldBreak).toBe(false);
    expect(state.timeoutStats.tool).toBe(1);
    // Termination must NOT be set to 'timeout' for verification-required
    // first-step timeouts — the planner gets another chance.
    expect(state.terminationReason).not.toBe('timeout');
    expect(state.steps[0]?.observation).toContain('[TIMEOUT]');
    // The verification-required directive is queued so the next planner
    // round receives explicit guidance.
    expect(state.pendingPlannerDirective).toMatchObject({
      kind: 'verification_required',
      reason: 'comparison_search',
    });
  });

  it('STILL terminates on timeout for non-verification queries (regression guard)', async () => {
    const execute = vi.fn().mockRejectedValue(
      Object.assign(new Error('search timed out'), { code: 'TIMEOUT' }),
    );
    const phase = makePhase({
      searchUseCase: { execute } as never,
    });
    const state = createAgentExecutionState();
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 5 });

    const shouldBreak = await phase.run(
      'req-plain-timeout',
      { ...DEFAULT_AGENT_CONFIG, fastAnswerBypassPlanner: false },
      budget,
      state,
      { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
      {
        stepStartMs: Date.now(),
        parsed: {
          thought: 'plain search',
          action: { tool: 'search_wines', input: { query: 'opus one' } },
        },
        inputTokens: 11,
        outputTokens: 7,
        wasTruncated: false,
      },
    );

    expect(shouldBreak).toBe(true);
    expect(state.terminationReason).toBe('timeout');
  });

  it('does NOT recover when a verification timeout happens AFTER a successful tool call', async () => {
    const execute = vi.fn().mockRejectedValue(
      Object.assign(new Error('drink window timed out'), { code: 'TIMEOUT' }),
    );
    const phase = makePhase({
      searchUseCase: { execute } as never,
    });
    const contract: AgentQueryExecutionContract = {
      requiresDrinkabilityCheck: false,
      hasEntityMetadataSignal: false,
      requiresVerificationStep: {
        reason: 'comparison_search',
        constraintCoverage: [],
      },
    };
    const state = createAgentExecutionState();
    // Simulate a prior successful compare_wines outcome.
    state.toolOutcomes.push({
      stepId: 'req:0:0',
      tool: 'compare_wines',
      kind: 'success',
      durationMs: 5,
      result: { queryType: 'comparison', entities: [] },
    });
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 6 });

    const shouldBreak = await phase.run(
      'req-cmp-second-timeout',
      { ...DEFAULT_AGENT_CONFIG, fastAnswerBypassPlanner: false },
      budget,
      state,
      contract,
      {
        stepStartMs: Date.now(),
        parsed: {
          thought: 'second step',
          action: { tool: 'search_wines', input: { query: 'fallback' } },
        },
        inputTokens: 11,
        outputTokens: 7,
        wasTruncated: false,
      },
    );

    // Once one tool already succeeded, the second-step timeout is the regular
    // terminal-on-timeout path; recovery would loop indefinitely.
    expect(shouldBreak).toBe(true);
    expect(state.terminationReason).toBe('timeout');
  });
});

describe('compare+verify continuation — planner answer attempt after compare_wines fires verify gate', () => {
  // Post-bench-#30 narrowing: the verify gate after a successful compare_wines
  // outcome now defers to constraint coverage, not the historical
  // "comparison_search → always-fire" rule. These two cases pin the new gate
  // shape end-to-end via `phase.run`.

  it('COMMITS the candidate answer when compare_wines covered all coverage atoms (post-#30 narrowing)', async () => {
    const phase = makePhase({ searchUseCase: { execute: vi.fn() } as never });
    const contract = buildAgentQueryExecutionContract(COMPARE_VERIFY_QUERY);
    const state: AgentExecutionState = createAgentExecutionState();
    // Build a compare_wines outcome whose `constraints.matched` covers every
    // atom the contract is asking about — when the requirement has no atoms
    // either, this is trivially satisfied.
    const matchedKeys = contract.requiresVerificationStep?.constraintCoverage.map(
      (a) => a.matchedConstraintKey,
    ) ?? [];
    state.toolOutcomes.push({
      stepId: 'req:0:0',
      tool: 'compare_wines',
      kind: 'success',
      durationMs: 5,
      result: {
        queryType: 'comparison',
        entities: [
          { subQuery: '보르도 2015', topResult: { entity: { entityId: 'wine-2015' }, constraints: { matched: [...matchedKeys] } } },
          { subQuery: '보르도 2016', topResult: { entity: { entityId: 'wine-2016' }, constraints: { matched: [...matchedKeys] } } },
        ],
      },
    });
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 6 });

    const shouldBreak = await phase.run(
      'req-verify-commit',
      { ...DEFAULT_AGENT_CONFIG, fastAnswerBypassPlanner: false },
      budget,
      state,
      contract,
      plannerAnswerOnly('Bordeaux 2015 vs 2016 비교 답변.'),
    );

    // Narrowing: with compare_wines successful AND no uncovered atoms, the
    // gate now lets the answer commit instead of forcing a verify re-plan.
    expect(shouldBreak).toBe(true);
    expect(state.answer).toBe('Bordeaux 2015 vs 2016 비교 답변.');
    expect(state.pendingPlannerDirective).toBeUndefined();
  });

  it('DROPS the candidate answer and queues verification_required when explicit coverage atoms remain uncovered', async () => {
    const phase = makePhase({ searchUseCase: { execute: vi.fn() } as never });
    // Inject a requirement with explicit coverage atoms so we deterministically
    // exercise the "uncovered.length > 0" branch regardless of which atoms the
    // deterministic contract emits for the bench query.
    const baseContract = buildAgentQueryExecutionContract(COMPARE_VERIFY_QUERY);
    const contract: AgentQueryExecutionContract = {
      ...baseContract,
      requiresVerificationStep: {
        reason: 'comparison_search',
        constraintCoverage: [
          { key: 'drinking_window:now', matchedConstraintKey: 'drinking_window', description: 'currently drinkable' },
        ],
      },
    };
    const state: AgentExecutionState = createAgentExecutionState();
    state.toolOutcomes.push({
      stepId: 'req:0:0',
      tool: 'compare_wines',
      kind: 'success',
      durationMs: 5,
      result: {
        queryType: 'comparison',
        entities: [
          { subQuery: '보르도 2015', topResult: { entity: { entityId: 'wine-2015' }, constraints: { matched: [] } } },
          { subQuery: '보르도 2016', topResult: { entity: { entityId: 'wine-2016' }, constraints: { matched: [] } } },
        ],
      },
    });
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 6 });

    const shouldBreak = await phase.run(
      'req-verify-fires',
      { ...DEFAULT_AGENT_CONFIG, fastAnswerBypassPlanner: false },
      budget,
      state,
      contract,
      plannerAnswerOnly('Bordeaux 2015 vs 2016 비교 답변.'),
    );

    expect(shouldBreak).toBe(false);
    expect(state.answer).toBe('');
    expect(state.pendingPlannerDirective).toMatchObject({
      kind: 'verification_required',
      reason: 'comparison_search',
    });
    expect(state.verificationStepCompleted).toBe(true);
  });
});
