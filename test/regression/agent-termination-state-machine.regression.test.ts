import { describe, expect, it } from 'vitest';
import {
  TERMINATION_REASON_PRIORITY,
  transitionTerminationReason,
} from '../../src/domain/agent/service/termination-state-machine.js';
import type { AgentTerminationReason } from '../../src/domain/agent/model/agent-step.js';

const ALL_REASONS: readonly AgentTerminationReason[] = [
  'answer',
  'max_steps',
  'timeout',
  'budget',
  'error',
  'loop_detected',
  'fallback',
  'blocked',
  'aborted',
];

describe('transitionTerminationReason', () => {
  it('returns the next reason when current is undefined', () => {
    for (const reason of ALL_REASONS) {
      expect(transitionTerminationReason(undefined, reason)).toBe(reason);
    }
  });

  it('preserves last-writer semantics for same-priority transitions', () => {
    for (const reason of ALL_REASONS) {
      expect(transitionTerminationReason(reason, reason)).toBe(reason);
    }
  });

  it('lets harder outcomes override softer ones; rejects softer overrides of harder', () => {
    // Table-driven: for every ordered pair (current, next), the function MUST
    // pick the higher-priority reason — independent of which order they arrived.
    for (const current of ALL_REASONS) {
      for (const next of ALL_REASONS) {
        const winner = transitionTerminationReason(current, next);
        const expectedWinner =
          TERMINATION_REASON_PRIORITY[next] >= TERMINATION_REASON_PRIORITY[current]
            ? next
            : current;
        expect(winner).toBe(expectedWinner);
      }
    }
  });

  it('aborted dominates answer regardless of write order', () => {
    expect(transitionTerminationReason('answer', 'aborted')).toBe('aborted');
    expect(transitionTerminationReason('aborted', 'answer')).toBe('aborted');
  });

  it('blocked dominates answer and max_steps regardless of order', () => {
    expect(transitionTerminationReason('answer', 'blocked')).toBe('blocked');
    expect(transitionTerminationReason('blocked', 'answer')).toBe('blocked');
    expect(transitionTerminationReason('max_steps', 'blocked')).toBe('blocked');
    expect(transitionTerminationReason('blocked', 'max_steps')).toBe('blocked');
  });

  it('error dominates fallback and answer; aborted dominates error', () => {
    expect(transitionTerminationReason('fallback', 'error')).toBe('error');
    expect(transitionTerminationReason('error', 'fallback')).toBe('error');
    expect(transitionTerminationReason('error', 'aborted')).toBe('aborted');
    expect(transitionTerminationReason('aborted', 'error')).toBe('aborted');
  });

  it('fallback overrides max_steps (later synthesis fallback wins over default)', () => {
    // CLAUDE.md rule 18: boundary semantics — fallback > max_steps because the
    // fallback path produced a usable substitute answer; the default
    // `'max_steps'` initializer must not erase it.
    expect(transitionTerminationReason('max_steps', 'fallback')).toBe('fallback');
    // But the reverse must not erase the fallback signal.
    expect(transitionTerminationReason('fallback', 'max_steps')).toBe('fallback');
  });

  // ── A3: completions dominate resource limits ──────────────────────────────
  it('A3: answer dominates ALL resource limits (budget/timeout/max_steps) regardless of order', () => {
    // The A3 decision: a run that produced a final grounded answer is a terminal
    // SUCCESS even if a resource limit was hit along the way. The answer came
    // through, so it is the dominant outcome.
    for (const limit of ['budget', 'timeout', 'max_steps'] as const) {
      expect(transitionTerminationReason(limit, 'answer')).toBe('answer');
      expect(transitionTerminationReason('answer', limit)).toBe('answer');
    }
  });

  it('A3: fallback dominates ALL resource limits but is dominated by answer', () => {
    // A degraded/substitute completion still means the user received output, so
    // it outranks resource limits — but a real grounded `answer` outranks it.
    for (const limit of ['budget', 'timeout', 'max_steps'] as const) {
      expect(transitionTerminationReason(limit, 'fallback')).toBe('fallback');
      expect(transitionTerminationReason('fallback', limit)).toBe('fallback');
    }
    expect(transitionTerminationReason('fallback', 'answer')).toBe('answer');
    expect(transitionTerminationReason('answer', 'fallback')).toBe('answer');
  });

  it('A3: hard failures dominate completions (answer/fallback) regardless of order', () => {
    // A structurally-terminated run that coincidentally set 'answer'/'fallback'
    // MUST report the failure — the failure is the dominant operator signal.
    for (const hard of ['aborted', 'blocked', 'error', 'loop_detected'] as const) {
      for (const completion of ['answer', 'fallback'] as const) {
        expect(transitionTerminationReason(completion, hard)).toBe(hard);
        expect(transitionTerminationReason(hard, completion)).toBe(hard);
      }
    }
  });

  it('budget dominates timeout and max_steps but is dominated by completions/hard failures', () => {
    expect(transitionTerminationReason('timeout', 'budget')).toBe('budget');
    expect(transitionTerminationReason('budget', 'timeout')).toBe('budget');
    expect(transitionTerminationReason('max_steps', 'budget')).toBe('budget');
    // A3: completions now dominate budget.
    expect(transitionTerminationReason('budget', 'answer')).toBe('answer');
    expect(transitionTerminationReason('budget', 'fallback')).toBe('fallback');
    expect(transitionTerminationReason('budget', 'error')).toBe('error');
    expect(transitionTerminationReason('budget', 'blocked')).toBe('blocked');
    expect(transitionTerminationReason('budget', 'aborted')).toBe('aborted');
  });

  it('loop_detected dominates resource limits AND completions; is dominated by aborted/blocked/error', () => {
    expect(transitionTerminationReason('max_steps', 'loop_detected')).toBe('loop_detected');
    expect(transitionTerminationReason('loop_detected', 'max_steps')).toBe('loop_detected');
    // loop_detected is a HARD failure — it dominates completions.
    expect(transitionTerminationReason('loop_detected', 'answer')).toBe('loop_detected');
    expect(transitionTerminationReason('loop_detected', 'fallback')).toBe('loop_detected');
    expect(transitionTerminationReason('loop_detected', 'budget')).toBe('loop_detected');
    expect(transitionTerminationReason('loop_detected', 'error')).toBe('error');
    expect(transitionTerminationReason('loop_detected', 'aborted')).toBe('aborted');
  });

  it('domain test: sequence answer → aborted → error ends as aborted', () => {
    // Real-world ordering: synthesis says "answer", then abort signal lands,
    // then a downstream cleanup tries to set error. Highest priority
    // encountered (aborted) must remain final.
    let reason: AgentTerminationReason = 'answer';
    reason = transitionTerminationReason(reason, 'aborted');
    reason = transitionTerminationReason(reason, 'error');
    expect(reason).toBe('aborted');
  });

  it('A3 domain test: budget → answer (answered despite budget) ends as answer', () => {
    // The run loop wrote 'budget' (token budget exhausted), then a later
    // synthesis / Layer-3 recovery produced a grounded answer. The user got the
    // answer, so the dominant outcome is 'answer' — NOT 'budget'. The budget
    // exhaustion remains visible via fallbackApplied / fallbackTrace.
    let reason: AgentTerminationReason = 'budget';
    reason = transitionTerminationReason(reason, 'answer');
    expect(reason).toBe('answer');
  });

  it('A3 domain test: timeout → fallback (fallback after timeout) ends as fallback', () => {
    // The LLM step / tool timed out ('timeout'), then a Layer-2 fallback search
    // produced a substitute answer ('fallback'). The completion dominates the
    // resource limit.
    let reason: AgentTerminationReason = 'timeout';
    reason = transitionTerminationReason(reason, 'fallback');
    expect(reason).toBe('fallback');
  });

  it('domain test: error after answer ends as error (hard failure dominates completion)', () => {
    // Synthesis claimed 'answer', then an unexpected downstream error fired.
    // The error MUST be reported — a coincidental answer must not mask it.
    let reason: AgentTerminationReason = 'answer';
    reason = transitionTerminationReason(reason, 'error');
    expect(reason).toBe('error');
  });

  it('domain test: aborted after everything stays aborted', () => {
    // Walk the full lattice bottom→top then land an abort: aborted is the apex
    // and must survive any subsequent same-or-lower write.
    let reason: AgentTerminationReason = 'max_steps';
    for (const next of ['timeout', 'budget', 'fallback', 'answer', 'loop_detected', 'error', 'blocked', 'aborted'] as const) {
      reason = transitionTerminationReason(reason, next);
    }
    expect(reason).toBe('aborted');
    // Any further softer write is rejected.
    for (const softer of ['error', 'blocked', 'answer', 'fallback', 'budget', 'timeout', 'max_steps'] as const) {
      expect(transitionTerminationReason('aborted', softer)).toBe('aborted');
    }
  });

  it('domain test: max_steps → fallback → answer ends as answer (A3: real answer wins)', () => {
    // The run loop seeds 'max_steps'; synthesis emits a fallback substitute;
    // later, answer-recovery produces a real grounded 'answer'. Under A3 the
    // real answer dominates the substitute (answer > fallback). Provenance of
    // the substitute is preserved in fallbackTrace, not in terminationReason.
    let reason: AgentTerminationReason = 'max_steps';
    reason = transitionTerminationReason(reason, 'fallback');
    reason = transitionTerminationReason(reason, 'answer');
    expect(reason).toBe('answer');
  });

  it('3-class band invariant: hard failures > completions > resource-limits > sentinel', () => {
    // Encodes the disjoint-band design: every hard failure outranks every
    // completion, every completion outranks every resource limit, and every
    // resource limit outranks the max_steps sentinel.
    const hard: readonly AgentTerminationReason[] = ['aborted', 'blocked', 'error', 'loop_detected'];
    const completions: readonly AgentTerminationReason[] = ['answer', 'fallback'];
    const resourceLimits: readonly AgentTerminationReason[] = ['budget', 'timeout'];
    const minOf = (group: readonly AgentTerminationReason[]): number =>
      group.reduce((m, r) => Math.min(m, TERMINATION_REASON_PRIORITY[r]), Number.POSITIVE_INFINITY);
    const maxOf = (group: readonly AgentTerminationReason[]): number =>
      group.reduce((m, r) => Math.max(m, TERMINATION_REASON_PRIORITY[r]), Number.NEGATIVE_INFINITY);
    expect(minOf(hard)).toBeGreaterThan(maxOf(completions));
    expect(minOf(completions)).toBeGreaterThan(maxOf(resourceLimits));
    expect(minOf(resourceLimits)).toBeGreaterThan(TERMINATION_REASON_PRIORITY['max_steps']);
  });

  it('priority table covers every AgentTerminationReason exactly once', () => {
    // Guards against forgotten additions to the union — every reason MUST have
    // a priority entry, otherwise priorityOf would return undefined.
    for (const reason of ALL_REASONS) {
      expect(TERMINATION_REASON_PRIORITY[reason]).toBeTypeOf('number');
      expect(Number.isFinite(TERMINATION_REASON_PRIORITY[reason])).toBe(true);
    }
  });
});
