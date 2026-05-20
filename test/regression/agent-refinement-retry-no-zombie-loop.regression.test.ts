/**
 * Regression: pendingRefinementRetry must be cleared the moment the
 * relax_constraints_retry directive is enqueued.
 *
 * Bug (audit ref agent-tool-execution-phase.ts:488-493):
 *   When the planner emits an answer with state.pendingRefinementRetry=true,
 *   the code injected a `relax_constraints_retry` planner directive and
 *   returned `false` (continue loop) but NEVER reset pendingRefinementRetry.
 *   If the next planner turn also produced an answer (e.g. another "no
 *   results" wording), the same branch fired again — the loop spun forever
 *   without ever calling `budget.recordStep`, so `maxSteps` was bypassed and
 *   the only exits were maxTotalTokens / agentTimeoutMs.
 *
 * Invariant under test:
 *   After the planner-answer branch enqueues the relax directive,
 *   - state.pendingRefinementRetry === false
 *   - state.pendingPlannerDirective.kind === 'relax_constraints_retry'
 *   - returned shouldBreak === false
 *
 * Adjacent boundary: two consecutive answer iterations. The second iteration
 * must NOT re-enqueue the same directive (pendingRefinementRetry is already
 * false), proving the zombie loop is gone. The second iteration's planner
 * answer should fall through to whatever the next branch would do; for a
 * non-empty answer with no other contract obligations, the agent should
 * commit the answer and terminate with shouldBreak=true.
 */
import { describe, expect, it, vi } from 'vitest';
import { AgentToolExecutionPhase } from '../../src/application/agent/agent-tool-execution-phase.js';
import { createAgentExecutionState } from '../../src/application/agent/agent-execution-state.js';
import type { PlannerPhaseResult } from '../../src/application/agent/agent-planner-phase-runner.js';
import { DEFAULT_AGENT_CONFIG } from '../../src/domain/agent/model/agent-config.js';
import { StepBudget } from '../../src/domain/agent/service/step-budget.js';

function makePlannerPhase(answer: string): PlannerPhaseResult {
  return {
    stepStartMs: Date.now(),
    parsed: {
      thought: 'no match — model wants to give up',
      answer,
    },
    inputTokens: 11,
    outputTokens: 7,
    wasTruncated: false,
  };
}

function makePhase() {
  const runDrinkabilityChecks = vi.fn().mockResolvedValue(true);
  const execute = vi.fn();
  const phase = new AgentToolExecutionPhase({
    toolDeps: { searchUseCase: { execute } as never },
    contractExecutionPhase: { runDrinkabilityChecks },
  });
  return { phase, execute, runDrinkabilityChecks };
}

describe('AgentToolExecutionPhase pendingRefinementRetry zombie-loop guard', () => {
  it('clears pendingRefinementRetry when enqueueing the relax_constraints_retry directive', async () => {
    const { phase } = makePhase();
    const state = createAgentExecutionState();
    state.pendingRefinementRetry = true; // simulate refinement-hint injection on a prior step
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 5 });

    const shouldBreak = await phase.run(
      'req-zombie-1',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
      makePlannerPhase('결과를 찾지 못했습니다.'),
    );

    expect(shouldBreak).toBe(false);
    expect(state.pendingRefinementRetry).toBe(false);
    expect(state.pendingPlannerDirective).toEqual({ kind: 'relax_constraints_retry' });
  });

  it('does NOT re-enter the refinement-retry branch on the next answer iteration', async () => {
    // Boundary: two consecutive answer iterations. The first arms the directive
    // and resets pendingRefinementRetry; the second arrives with the flag
    // already false, so it must fall through to the regular answer-commit
    // path and terminate the loop (shouldBreak=true).
    const { phase } = makePhase();
    const state = createAgentExecutionState();
    state.pendingRefinementRetry = true;
    const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: 5 });

    const firstShouldBreak = await phase.run(
      'req-zombie-2a',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
      makePlannerPhase('결과 없음'),
    );
    expect(firstShouldBreak).toBe(false);
    expect(state.pendingRefinementRetry).toBe(false);
    expect(state.pendingPlannerDirective).toEqual({ kind: 'relax_constraints_retry' });

    // Simulate the next planner iteration consuming the pending directive
    // before re-entering this phase (mirrors AgentPlannerPhaseRunner behavior:
    // see agent-planner-phase-runner.ts where it clears
    // state.pendingPlannerDirective right after composing messages).
    state.pendingPlannerDirective = undefined;

    const secondShouldBreak = await phase.run(
      'req-zombie-2b',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
      makePlannerPhase('결과 없음'),
    );

    // Zombie-loop check: the second iteration must NOT re-arm the retry
    // directive (flag was cleared) and must commit an answer instead.
    expect(state.pendingRefinementRetry).toBe(false);
    expect(state.pendingPlannerDirective).toBeUndefined();
    expect(state.answer).toBe('결과 없음');
    expect(state.terminationReason).toBe('answer');
    expect(secondShouldBreak).toBe(true);
  });
});
