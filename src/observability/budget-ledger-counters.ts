/**
 * ADR-013 Phase 1c.x: BudgetLedger telemetry counters.
 *
 * Mirrors the shape of `bundle-selector-counters.ts` for operator
 * familiarity. These counters measure concrete ledger operations — NOT
 * silent skips — because every call-site is an authored execution step
 * inside the graph-aware executor:
 *
 *   - BUDGET_LEDGER_RESERVE_SUCCESS
 *     A unique `(subqueryId, entityId)` reservation committed. Repeats
 *     on the same pair do not increment the counter (reserve is
 *     idempotent).
 *   - BUDGET_LEDGER_RESERVE_VIOLATION
 *     A reservation was rejected because it would have pushed the
 *     running KRW total past the configured ceiling. The ledger throws
 *     `BudgetViolationError`; this counter is incremented BEFORE the
 *     throw so fail-closed paths still produce the signal even when
 *     the caller crashes out of the retrieval.
 *   - BUDGET_LEDGER_RELEASE_COUNT
 *     A slot was cleared via `release()`. Used to cross-check critic
 *     retry churn — each retry should release exactly the subqueries
 *     it intends to re-reserve.
 */

export type BudgetLedgerCounterKind =
  | 'BUDGET_LEDGER_RESERVE_SUCCESS'
  | 'BUDGET_LEDGER_RESERVE_VIOLATION'
  | 'BUDGET_LEDGER_RELEASE_COUNT';

const COUNTER_KINDS: readonly BudgetLedgerCounterKind[] = [
  'BUDGET_LEDGER_RESERVE_SUCCESS',
  'BUDGET_LEDGER_RESERVE_VIOLATION',
  'BUDGET_LEDGER_RELEASE_COUNT',
] as const;

export interface BudgetLedgerCounter {
  increment(kind: BudgetLedgerCounterKind): void;
  snapshot(): Readonly<Record<BudgetLedgerCounterKind, number>>;
  reset(): void;
}

function createZeroedCounts(): Record<BudgetLedgerCounterKind, number> {
  const out = {} as Record<BudgetLedgerCounterKind, number>;
  for (const k of COUNTER_KINDS) out[k] = 0;
  return out;
}

export function createBudgetLedgerCounter(): BudgetLedgerCounter {
  const counts = new Map<BudgetLedgerCounterKind, number>(
    COUNTER_KINDS.map((k) => [k, 0] as const),
  );
  return {
    increment(kind) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
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
 * Process-wide shared instance. Tests may call `reset()` in
 * `beforeEach` to isolate counter assertions across suites.
 */
export const globalBudgetLedgerCounter: BudgetLedgerCounter =
  createBudgetLedgerCounter();
