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
  it('drops the candidate answer and queues verification_required for the bench #15 query', async () => {
    const phase = makePhase({ searchUseCase: { execute: vi.fn() } as never });
    const contract = buildAgentQueryExecutionContract(COMPARE_VERIFY_QUERY);
    const state: AgentExecutionState = createAgentExecutionState();
    // Seed a comparison-shaped tool outcome with no covering constraints.
    state.toolOutcomes.push({
      stepId: 'req:0:0',
      tool: 'compare_wines',
      kind: 'success',
      durationMs: 5,
      result: {
        queryType: 'comparison',
        entities: [
          {
            subQuery: '보르도 2015',
            topResult: {
              entity: { entityId: 'wine-2015' },
              constraints: { matched: [], unmet: [], inferred: [] },
            },
          },
          {
            subQuery: '보르도 2016',
            topResult: {
              entity: { entityId: 'wine-2016' },
              constraints: { matched: [], unmet: [], inferred: [] },
            },
          },
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
