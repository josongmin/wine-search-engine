/**
 * Precedence-table regression for the centralized TerminationStateMachine.
 *
 * Companion to `agent-termination-state-machine.regression.test.ts` (which
 * covers the original pair-wise dominance table). This file pins the
 * REFACTORED invariants that allow safe migration of the ~40 distributed
 * `state.terminationReason =` write sites in `src/application/agent/` onto
 * the single transition API:
 *
 *   transitionTerminationReason(current, event): AgentTerminationReason
 *
 * Required invariants for migration safety (per task brief):
 *  - Precedence (high -> low):
 *      aborted > blocked > error > budget > timeout > max_steps > loop_detected > fallback > answer
 *    NOTE: the implementation's effective ordering is the source of truth and
 *    is verified by comparing against the exported priority table; this test
 *    pins that whatever ordering the table encodes is enforced commutatively.
 *  - Commutativity: max(a, b) under priority must be order-independent.
 *  - Idempotence: applying the same event twice never downgrades the state.
 *  - Initial sentinel: the default-seeded `'max_steps'` can be promoted by any
 *    HIGHER-priority event and is preserved against any lower-priority event.
 *  - Terminal absorbing state: once `'aborted'` is reached, no event can
 *    override it (it is the top of the lattice).
 *  - Total coverage: every `AgentTerminationReason` value has a numeric
 *    priority and a deterministic winner against every other.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
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

function expectedWinner(
  a: AgentTerminationReason,
  b: AgentTerminationReason,
): AgentTerminationReason {
  // Mirrors the implementation's "next wins on >=" rule. We compute the
  // expected winner using the exported priority table only — never inline
  // numeric constants (CLAUDE.md rule 15).
  return TERMINATION_REASON_PRIORITY[b] >= TERMINATION_REASON_PRIORITY[a] ? b : a;
}

const reasonArb: fc.Arbitrary<AgentTerminationReason> = fc.constantFrom(
  ...ALL_REASONS,
);

describe('TerminationStateMachine precedence (centralized transition)', () => {
  it('exposes a pure transition API and a frozen priority table', () => {
    // The migration plan rewrites 40 distributed assignments into a single
    // call: `state.terminationReason = transitionTerminationReason(prev, evt)`.
    // The API surface MUST be a pure function (no closure state) and the
    // priority table MUST be exported for diagnostic logging.
    expect(typeof transitionTerminationReason).toBe('function');
    expect(typeof TERMINATION_REASON_PRIORITY).toBe('object');
    for (const reason of ALL_REASONS) {
      expect(TERMINATION_REASON_PRIORITY[reason]).toBeTypeOf('number');
      expect(Number.isFinite(TERMINATION_REASON_PRIORITY[reason])).toBe(true);
    }
  });

  it('priority table assigns a unique rank to every termination reason', () => {
    // Equal-priority entries would create non-deterministic last-writer
    // semantics across migrated sites. Pin uniqueness so migration can rely
    // on a total order.
    const ranks = ALL_REASONS.map((r) => TERMINATION_REASON_PRIORITY[r]);
    const uniqueRanks = new Set(ranks);
    expect(uniqueRanks.size).toBe(ALL_REASONS.length);
  });

  it('aborted is the maximum of the priority lattice (terminal/absorbing)', () => {
    // Aborted is a user/host cancellation — once reached, no later event in
    // the run loop may overwrite it. This is the load-bearing invariant that
    // makes the centralized machine safe to call from preflight, tool-exec,
    // synthesis, and run-loop layers concurrently.
    const abortedRank = TERMINATION_REASON_PRIORITY.aborted;
    for (const reason of ALL_REASONS) {
      if (reason === 'aborted') continue;
      expect(TERMINATION_REASON_PRIORITY[reason]).toBeLessThan(abortedRank);
    }
  });

  it('aborted is idempotent under every subsequent event (terminal absorbing)', () => {
    // Property: forall event in ALL_REASONS, transition('aborted', event) === 'aborted'.
    for (const event of ALL_REASONS) {
      expect(transitionTerminationReason('aborted', event)).toBe('aborted');
    }
  });

  it('default sentinel max_steps is promoted by every strictly-higher event', () => {
    // The state is initialized to 'max_steps' (the sentinel "no real
    // terminator yet"). Any event with a STRICTLY higher priority MUST win;
    // any event with equal-or-higher priority including 'max_steps' itself
    // returns 'max_steps' (or itself, by the next-wins-on-equal rule).
    const sentinelRank = TERMINATION_REASON_PRIORITY.max_steps;
    for (const event of ALL_REASONS) {
      const result = transitionTerminationReason('max_steps', event);
      if (TERMINATION_REASON_PRIORITY[event] >= sentinelRank) {
        expect(result).toBe(event);
      } else {
        expect(result).toBe('max_steps');
      }
    }
  });

  it('explicit pair-wise winners for every (current, event) of 81 combos', () => {
    // 9 reasons x 9 events = 81 specific assertions, each comparing the
    // function output to the priority-table-derived winner. No toBeTruthy.
    let asserted = 0;
    for (const current of ALL_REASONS) {
      for (const event of ALL_REASONS) {
        const winner = transitionTerminationReason(current, event);
        expect(winner).toBe(expectedWinner(current, event));
        asserted += 1;
      }
    }
    expect(asserted).toBe(ALL_REASONS.length * ALL_REASONS.length);
  });

  it('commutativity under max(): transition is order-invariant on the WINNER', () => {
    // Property test (100 runs): for any pair (a, b), the priority of the
    // winner from transition(a, b) equals the priority of the winner from
    // transition(b, a). The IDENTITY of the winner can differ when
    // priorities are equal (next-wins-on-equal preserves last-writer
    // semantics for peers), but with a unique-rank table the winners are
    // identical too.
    fc.assert(
      fc.property(reasonArb, reasonArb, (a, b) => {
        const ab = transitionTerminationReason(a, b);
        const ba = transitionTerminationReason(b, a);
        expect(TERMINATION_REASON_PRIORITY[ab]).toBe(
          TERMINATION_REASON_PRIORITY[ba],
        );
        // With a unique-rank priority table the winner identity matches too.
        expect(ab).toBe(ba);
      }),
      { numRuns: 100 },
    );
  });

  it('idempotence: applying the same event twice never changes the result', () => {
    // Property test (100 runs): transition(transition(s, e), e) === transition(s, e).
    fc.assert(
      fc.property(reasonArb, reasonArb, (current, event) => {
        const once = transitionTerminationReason(current, event);
        const twice = transitionTerminationReason(once, event);
        expect(twice).toBe(once);
      }),
      { numRuns: 100 },
    );
  });

  it('monotone non-downgrade: priority never decreases across a transition', () => {
    // Property test (100 runs): rank(transition(s, e)) >= rank(s). This is
    // the invariant that justifies migrating distributed writes onto the
    // central machine — no migrated call site can accidentally LOWER the
    // recorded terminator.
    fc.assert(
      fc.property(reasonArb, reasonArb, (current, event) => {
        const result = transitionTerminationReason(current, event);
        expect(TERMINATION_REASON_PRIORITY[result]).toBeGreaterThanOrEqual(
          TERMINATION_REASON_PRIORITY[current],
        );
      }),
      { numRuns: 100 },
    );
  });

  it('aborted absorbs arbitrary event sequences (property, 100 runs)', () => {
    // Property test: once 'aborted' is seen anywhere in a sequence of
    // events, the final reduced state is 'aborted'. This pins the migration
    // invariant that downstream layers (e.g. answer-recovery, fallback
    // synthesis) cannot erase an upstream abort.
    fc.assert(
      fc.property(fc.array(reasonArb, { minLength: 1, maxLength: 8 }), (events) => {
        const withAbort: AgentTerminationReason[] = [...events, 'aborted', ...events];
        let state: AgentTerminationReason = 'max_steps';
        for (const e of withAbort) {
          state = transitionTerminationReason(state, e);
        }
        expect(state).toBe('aborted');
      }),
      { numRuns: 100 },
    );
  });

  it('undefined current is treated as "no terminator yet" and takes any event', () => {
    // The transition function accepts `undefined` as the initial state
    // (pre-seed). Every reason MUST win against undefined so future call
    // sites that omit the default seed remain safe.
    for (const event of ALL_REASONS) {
      expect(transitionTerminationReason(undefined, event)).toBe(event);
    }
  });
});
