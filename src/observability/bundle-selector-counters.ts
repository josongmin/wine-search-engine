/**
 * ADR-013 Phase 1c: bundle-selector telemetry counters.
 *
 * Kept separate from `silent-skip-counters.ts` because bundle-selector
 * signals are authored intent — they are fail-closed markers rather
 * than silent skips. The shape mirrors `silent-skip-counters.ts` for
 * operator familiarity.
 *
 * Named counters (exported for tests / audit grep):
 *   - BUNDLE_SELECTOR_BUDGET_UNSELECTED_RESERVED_COUNT
 *     The executor invoked `onReserveAssignment` for a candidate that
 *     is not in the final solver-returned assignment. Under the PR4
 *     call-site this must stay at 0; a non-zero value signals that the
 *     P1-C pre-rank→post-assignment relocation has regressed.
 *   - BUNDLE_SELECTOR_K_EXCEEDS_EXACT_LIMIT_COUNT
 *     The graph carried more than K_EXACT_LIMIT subquery nodes and the
 *     solver returned fail-closed per CLAUDE.md heuristic policy.
 *   - BUNDLE_SELECTOR_BUDGET_INFEASIBLE_COUNT
 *     No feasible assignment existed under the shared-budget ceiling.
 *   - BUNDLE_SELECTOR_EMPTY_SLOT_POOL_COUNT
 *     At least one subquery produced zero candidates.
 *   - BUNDLE_SELECTOR_GROUP_OBLIGATION_UNSATISFIED_COUNT
 *     No active row selection satisfied the graph's OR/XOR group obligation.
 */

import type { AssignmentSolverFailReason } from '../domain/retrieval/service/assignment-solver.js';

type BundleSelectorCounterKind =
  | 'BUNDLE_SELECTOR_BUDGET_UNSELECTED_RESERVED_COUNT'
  | 'BUNDLE_SELECTOR_K_EXCEEDS_EXACT_LIMIT_COUNT'
  | 'BUNDLE_SELECTOR_BUDGET_INFEASIBLE_COUNT'
  | 'BUNDLE_SELECTOR_EMPTY_SLOT_POOL_COUNT'
  | 'BUNDLE_SELECTOR_GROUP_OBLIGATION_UNSATISFIED_COUNT';

const COUNTER_KINDS: readonly BundleSelectorCounterKind[] = [
  'BUNDLE_SELECTOR_BUDGET_UNSELECTED_RESERVED_COUNT',
  'BUNDLE_SELECTOR_K_EXCEEDS_EXACT_LIMIT_COUNT',
  'BUNDLE_SELECTOR_BUDGET_INFEASIBLE_COUNT',
  'BUNDLE_SELECTOR_EMPTY_SLOT_POOL_COUNT',
  'BUNDLE_SELECTOR_GROUP_OBLIGATION_UNSATISFIED_COUNT',
] as const;

const REASON_TO_COUNTER: Readonly<Record<AssignmentSolverFailReason, BundleSelectorCounterKind>> = {
  'bundle_selector_fail_closed:k_exceeds_exact_limit':
    'BUNDLE_SELECTOR_K_EXCEEDS_EXACT_LIMIT_COUNT',
  'bundle_selector_fail_closed:budget_infeasible':
    'BUNDLE_SELECTOR_BUDGET_INFEASIBLE_COUNT',
  'bundle_selector_fail_closed:empty_slot_pool':
    'BUNDLE_SELECTOR_EMPTY_SLOT_POOL_COUNT',
  'bundle_selector_fail_closed:group_obligation_unsatisfied':
    'BUNDLE_SELECTOR_GROUP_OBLIGATION_UNSATISFIED_COUNT',
};

interface BundleSelectorCounter {
  increment(kind: BundleSelectorCounterKind): void;
  incrementReason(reason: AssignmentSolverFailReason): void;
  incrementUnselectedReserved(): void;
  snapshot(): Readonly<Record<BundleSelectorCounterKind, number>>;
  reset(): void;
}

function createZeroedCounts(): Record<BundleSelectorCounterKind, number> {
  const out = {} as Record<BundleSelectorCounterKind, number>;
  for (const k of COUNTER_KINDS) out[k] = 0;
  return out;
}

function createBundleSelectorCounter(): BundleSelectorCounter {
  const counts = new Map<BundleSelectorCounterKind, number>(
    COUNTER_KINDS.map((k) => [k, 0] as const),
  );
  return {
    increment(kind) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    },
    incrementReason(reason) {
      const kind = REASON_TO_COUNTER[reason];
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    },
    incrementUnselectedReserved() {
      counts.set(
        'BUNDLE_SELECTOR_BUDGET_UNSELECTED_RESERVED_COUNT',
        (counts.get('BUNDLE_SELECTOR_BUDGET_UNSELECTED_RESERVED_COUNT') ?? 0) + 1,
      );
    },
    snapshot() {
      const out = createZeroedCounts();
      for (const k of COUNTER_KINDS) out[k] = counts.get(k) ?? 0;
      return Object.freeze(out);
    },
    reset() {
      for (const k of COUNTER_KINDS) counts.set(k, 0);
    },
  };
}

/**
 * Process-wide shared instance. Tests may call `reset()` in `beforeEach`.
 */
export const globalBundleSelectorCounter: BundleSelectorCounter =
  createBundleSelectorCounter();
