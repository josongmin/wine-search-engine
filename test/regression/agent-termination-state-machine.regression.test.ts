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

  it('budget dominates timeout and max_steps but is dominated by error/blocked/aborted', () => {
    expect(transitionTerminationReason('timeout', 'budget')).toBe('budget');
    expect(transitionTerminationReason('budget', 'timeout')).toBe('budget');
    expect(transitionTerminationReason('max_steps', 'budget')).toBe('budget');
    expect(transitionTerminationReason('budget', 'error')).toBe('error');
    expect(transitionTerminationReason('budget', 'blocked')).toBe('blocked');
    expect(transitionTerminationReason('budget', 'aborted')).toBe('aborted');
  });

  it('loop_detected dominates max_steps/timeout/fallback/answer; is dominated by hard failures', () => {
    expect(transitionTerminationReason('max_steps', 'loop_detected')).toBe('loop_detected');
    expect(transitionTerminationReason('loop_detected', 'max_steps')).toBe('loop_detected');
    expect(transitionTerminationReason('loop_detected', 'answer')).toBe('loop_detected');
    expect(transitionTerminationReason('loop_detected', 'fallback')).toBe('loop_detected');
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

  it('domain test: sequence max_steps → fallback → answer ends as fallback', () => {
    // The run loop seeds 'max_steps'; synthesis emits a fallback substitute;
    // later, answer-recovery tries to claim 'answer'. Fallback must remain so
    // operators can distinguish substitute answers from real grounded answers.
    let reason: AgentTerminationReason = 'max_steps';
    reason = transitionTerminationReason(reason, 'fallback');
    reason = transitionTerminationReason(reason, 'answer');
    expect(reason).toBe('fallback');
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
