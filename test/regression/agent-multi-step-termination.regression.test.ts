/**
 * Regression: S2 constraint-coverage verification gating.
 *
 * The verification-step guard must fire ONLY when a hard constraint is
 * UNCOVERED by the returned grounding (`GROUNDING_JSON.wines[].matched_constraints`),
 * and must NOT add a verify step (latency tax) when every constraint is
 * covered. Comparison intent is the documented always-trigger special case
 * (a single observation cannot cover a two-sided compare).
 *
 * These tests drive `AgentToolExecutionPhase.run` directly: step 1 executes a
 * grounding tool, step 2 attempts a direct answer. We assert whether the
 * candidate answer is dropped (verify fires) or committed (no verify step).
 */

import { describe, expect, it, vi } from 'vitest';
import { AgentToolExecutionPhase } from '../../src/application/agent/agent-tool-execution-phase.js';
import { createAgentExecutionState } from '../../src/application/agent/agent-execution-state.js';
import type { AgentExecutionState } from '../../src/application/agent/agent-execution-state.js';
import { buildAgentQueryExecutionContract } from '../../src/application/agent/agent-query-execution-contract.js';
import type { AgentQueryExecutionContract } from '../../src/application/agent/agent-query-execution-contract.js';
import type { PlannerPhaseResult } from '../../src/application/agent/agent-planner-phase-runner.js';
import type { AgentToolDeps } from '../../src/application/agent/agent-tools.js';
import { DEFAULT_AGENT_CONFIG } from '../../src/domain/agent/model/agent-config.js';
import { StepBudget } from '../../src/domain/agent/service/step-budget.js';

function plannerAnswer(answer: string): PlannerPhaseResult {
  return {
    stepStartMs: Date.now(),
    parsed: { thought: 'commit answer', answer },
    inputTokens: 10,
    outputTokens: 5,
    wasTruncated: false,
  };
}

function makePhase(toolDeps: AgentToolDeps) {
  return new AgentToolExecutionPhase({
    toolDeps,
    contractExecutionPhase: { runDrinkabilityChecks: vi.fn().mockResolvedValue(true) },
  });
}

/**
 * Seed state with ONE search outcome whose top result lists the given
 * `matched_constraints`. Covers every atom keyed by an entry in
 * `matchedKeys`; an empty list covers nothing.
 */
function seedSearchOutcome(state: AgentExecutionState, matchedKeys: readonly string[]): void {
  state.toolOutcomes.push({
    stepId: 'req:0:0',
    tool: 'search_wines',
    kind: 'success',
    durationMs: 5,
    result: {
      queryType: 'search',
      results: [
        {
          entity: { entityId: 'wine-1', canonicalLabel: 'Test Wine 2018', region: 'Bordeaux' },
          constraints: { matched: [...matchedKeys], unmet: [], inferred: [] },
        },
      ],
    },
  });
}

async function runDirectAnswer(
  contract: AgentQueryExecutionContract,
  matchedKeys: readonly string[],
): Promise<{ broke: boolean; state: AgentExecutionState }> {
  const phase = makePhase({ searchUseCase: { execute: vi.fn() } as never });
  const state = createAgentExecutionState();
  seedSearchOutcome(state, matchedKeys);
  const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 6 });
  const broke = await phase.run(
    'req-verify',
    DEFAULT_AGENT_CONFIG,
    budget,
    state,
    contract,
    plannerAnswer('추천 답변입니다.'),
  );
  return { broke, state };
}

interface VerificationScenario {
  readonly label: string;
  readonly query: string;
  /** matched_constraints keys that, when present on the returned wine, cover
   *  EVERY required atom (so verify must NOT fire). */
  readonly coveringKeys: readonly string[];
}

const SCENARIOS: readonly VerificationScenario[] = [
  {
    label: 'negation',
    query: '카베르네 말고 부르고뉴 와인 추천해줘',
    coveringKeys: ['exclude_grapes'],
  },
  {
    label: 'comparison_nested',
    query: '바롤로 vs 브루넬로 비교해줘',
    coveringKeys: [], // comparison is always-trigger; no key covers it
  },
  {
    label: 'complex_reasoning',
    query: '부모님 선물용이고 5만원 이하인 입문자 와인 추천해줘',
    coveringKeys: ['recipient_profile', 'max_price_krw', 'sweetness', 'acidity', 'tannin'],
  },
  {
    label: 'situation_based',
    query: '5만원 이하 선물용 부모님 입문 와인 추천',
    coveringKeys: ['max_price_krw'],
  },
  {
    label: 'nested_condition',
    query: '레드 와인인데 카베르네랑 메를로는 빼고 5만원 이하로',
    coveringKeys: ['exclude_grapes', 'max_price_krw'],
  },
];

describe('agent verification gating — constraint-coverage trigger (S2)', () => {
  for (const scenario of SCENARIOS) {
    it(`[${scenario.label}] builds a verification requirement`, () => {
      const contract = buildAgentQueryExecutionContract(scenario.query);
      expect(contract.requiresVerificationStep).toBeDefined();
    });

    it(`[${scenario.label}] FIRES verify when constraints are uncovered`, async () => {
      const contract = buildAgentQueryExecutionContract(scenario.query);
      // Uncovered: the returned wine lists NO matched_constraints.
      const { broke, state } = await runDirectAnswer(contract, []);
      expect(broke).toBe(false);
      // Candidate answer was dropped; planner pushed into a verify re-plan.
      expect(state.answer).toBe('');
      expect(state.pendingPlannerDirective).toMatchObject({ kind: 'verification_required' });
      expect(state.verificationStepCompleted).toBe(true);
    });
  }

  // Latency guard: a fully-covered NON-comparison query must NOT add a verify
  // step — the candidate answer commits immediately.
  for (const scenario of SCENARIOS.filter((s) => s.label !== 'comparison_nested')) {
    it(`[${scenario.label}] does NOT add a verify step when fully covered (latency guard)`, async () => {
      const contract = buildAgentQueryExecutionContract(scenario.query);
      const { broke, state } = await runDirectAnswer(contract, scenario.coveringKeys);
      expect(broke).toBe(true);
      expect(state.terminationReason).toBe('answer');
      expect(state.answer).toBe('추천 답변입니다.');
      expect(state.pendingPlannerDirective).toBeUndefined();
    });
  }

  it('[comparison_nested] always fires verify even when matched_constraints are present', async () => {
    const contract = buildAgentQueryExecutionContract('바롤로 vs 브루넬로 비교해줘');
    // Even with a covering key present, comparison is always-trigger.
    const { broke, state } = await runDirectAnswer(contract, ['max_price_krw']);
    expect(broke).toBe(false);
    expect(state.answer).toBe('');
    expect(state.pendingPlannerDirective).toMatchObject({
      kind: 'verification_required',
      reason: 'comparison_search',
    });
  });

  it('latch prevents a second verify loop: a re-plan answer commits even if still uncovered', async () => {
    const contract = buildAgentQueryExecutionContract('카베르네 말고 부르고뉴 와인 추천해줘');
    const phase = makePhase({ searchUseCase: { execute: vi.fn() } as never });
    const state = createAgentExecutionState();
    seedSearchOutcome(state, []); // uncovered
    state.verificationStepCompleted = true; // latch already fired once
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 6 });
    const broke = await phase.run('req-latch', DEFAULT_AGENT_CONFIG, budget, state, contract, plannerAnswer('두번째 답변.'));
    expect(broke).toBe(true);
    expect(state.terminationReason).toBe('answer');
    expect(state.answer).toBe('두번째 답변.');
  });

  it('requireVerificationStep=false disables the guard entirely', async () => {
    const contract = buildAgentQueryExecutionContract('카베르네 말고 부르고뉴 와인 추천해줘');
    const phase = makePhase({ searchUseCase: { execute: vi.fn() } as never });
    const state = createAgentExecutionState();
    seedSearchOutcome(state, []); // uncovered — would normally fire
    const config = { ...DEFAULT_AGENT_CONFIG, requireVerificationStep: false };
    const budget = new StepBudget({ ...config, maxSteps: 6 });
    const broke = await phase.run('req-disabled', config, budget, state, contract, plannerAnswer('답변.'));
    expect(broke).toBe(true);
    expect(state.terminationReason).toBe('answer');
  });
});
