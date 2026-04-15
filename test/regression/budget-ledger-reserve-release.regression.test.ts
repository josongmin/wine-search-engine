/**
 * ADR-013 Phase 1c.x: InMemoryBudgetLedger core contract.
 *
 * Locks the public API of the per-request ledger that replaces PR4's
 * `onReserveAssignment` callback stub. These cases are unit-level
 * exercises of the ledger in isolation — the executor integration
 * contract lives in `graph-executor-budget-ledger-integration.regression.test.ts`.
 *
 * Never delete this file.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BudgetViolationError,
  InMemoryBudgetLedger,
} from '../../src/domain/retrieval/service/budget-ledger.js';
import {
  createBudgetLedgerCounter,
  globalBudgetLedgerCounter,
} from '../../src/observability/budget-ledger-counters.js';
import { KRW_PER_USD_APPROXIMATE } from '../../src/domain/shared/constants.js';
import type { HybridCandidate } from '../../src/domain/retrieval/model/hybrid-candidate.js';

function mkCandidate(id: string, priceUsd?: number): HybridCandidate {
  // Cast via `unknown` because HybridCandidate has many required
  // annotator-only fields that the ledger neither reads nor mutates.
  // The ledger only touches `entityId` and `priceUsd`, so a narrow
  // partial is safe here and keeps test fixtures minimal.
  const base = {
    entityId: id,
    retrievalTrace: {},
    matchedConstraints: [],
  } as unknown as HybridCandidate;
  if (priceUsd === undefined) return base;
  return { ...base, priceUsd } as HybridCandidate;
}

describe('InMemoryBudgetLedger (ADR-013 Phase 1c.x)', () => {
  beforeEach(() => {
    globalBudgetLedgerCounter.reset();
  });

  it('reserve records a slot with canonical KRW price', () => {
    const ledger = new InMemoryBudgetLedger();
    ledger.reserve('sq_0', mkCandidate('w1', 100));
    const snap = ledger.snapshot();
    expect(snap.candidateCount).toBe(1);
    expect(snap.priceTotalKrw).toBe(100 * KRW_PER_USD_APPROXIMATE);
    const record = snap.reservations.get('sq_0');
    expect(record).toBeDefined();
    expect(record?.entityId).toBe('w1');
    expect(record?.priceKrw).toBe(100 * KRW_PER_USD_APPROXIMATE);
    // ISO-8601 timestamp — basic shape check. Domain policy does not
    // over-specify, but a valid Date.parse is table-stakes.
    expect(Number.isFinite(Date.parse(record?.reservedAt ?? ''))).toBe(true);
  });

  it('reserve is idempotent on the same (subqueryId, entityId) pair', () => {
    const ledger = new InMemoryBudgetLedger();
    ledger.reserve('sq_0', mkCandidate('w1', 100));
    ledger.reserve('sq_0', mkCandidate('w1', 100));
    ledger.reserve('sq_0', mkCandidate('w1', 100));
    const snap = ledger.snapshot();
    expect(snap.candidateCount).toBe(1);
    expect(snap.priceTotalKrw).toBe(100 * KRW_PER_USD_APPROXIMATE);
    // Counter reflects a single successful unique reservation — duplicate
    // calls must NOT re-increment the success counter.
    expect(
      globalBudgetLedgerCounter.snapshot().BUDGET_LEDGER_RESERVE_SUCCESS,
    ).toBe(1);
  });

  it('reserve replaces a slot when a different entity is supplied', () => {
    const ledger = new InMemoryBudgetLedger();
    ledger.reserve('sq_0', mkCandidate('w1', 100));
    ledger.reserve('sq_0', mkCandidate('w2', 50));
    const snap = ledger.snapshot();
    expect(snap.candidateCount).toBe(1);
    expect(snap.reservations.get('sq_0')?.entityId).toBe('w2');
    expect(snap.priceTotalKrw).toBe(50 * KRW_PER_USD_APPROXIMATE);
  });

  it('release clears state for a given subquery, no-op when empty', () => {
    const ledger = new InMemoryBudgetLedger();
    ledger.reserve('sq_0', mkCandidate('w1', 100));
    ledger.reserve('sq_1', mkCandidate('w2', 200));
    ledger.release('sq_0');
    const snap = ledger.snapshot();
    expect(snap.candidateCount).toBe(1);
    expect(snap.reservations.has('sq_0')).toBe(false);
    expect(snap.reservations.has('sq_1')).toBe(true);
    expect(snap.priceTotalKrw).toBe(200 * KRW_PER_USD_APPROXIMATE);
    // Releasing a non-existent slot is a no-op — no counter tick, no
    // state change.
    const beforeNoop = ledger.snapshot().priceTotalKrw;
    ledger.release('sq_nonexistent');
    expect(ledger.snapshot().priceTotalKrw).toBe(beforeNoop);
  });

  it('snapshot is a frozen copy — mutating the caller view does not affect ledger', () => {
    const ledger = new InMemoryBudgetLedger();
    ledger.reserve('sq_0', mkCandidate('w1', 100));
    const snap = ledger.snapshot();
    // The returned Map is a clone; attempting to mutate it should not
    // corrupt the ledger's internal state.
    (snap.reservations as Map<string, never>).clear?.();
    const snap2 = ledger.snapshot();
    expect(snap2.candidateCount).toBe(1);
  });

  it('priceTotalKrw violation throws BudgetViolationError and leaves state unchanged', () => {
    const ledger = new InMemoryBudgetLedger({ priceTotalKrw: 100_000 });
    ledger.reserve('sq_0', mkCandidate('w1', 50)); // 50 USD → 67 500 KRW
    expect(() =>
      // 50 USD more would push us to 135 000 KRW > 100 000.
      ledger.reserve('sq_1', mkCandidate('w2', 50)),
    ).toThrowError(BudgetViolationError);
    // On throw the ledger state is unchanged.
    const snap = ledger.snapshot();
    expect(snap.candidateCount).toBe(1);
    expect(snap.reservations.has('sq_1')).toBe(false);
    expect(
      globalBudgetLedgerCounter.snapshot().BUDGET_LEDGER_RESERVE_VIOLATION,
    ).toBe(1);
  });

  it('remainingPriceKrw reports ceiling headroom, or undefined without ceiling', () => {
    const unlimited = new InMemoryBudgetLedger();
    expect(unlimited.remainingPriceKrw()).toBeUndefined();
    unlimited.reserve('sq_0', mkCandidate('w1', 100));
    expect(unlimited.remainingPriceKrw()).toBeUndefined();

    const bounded = new InMemoryBudgetLedger({ priceTotalKrw: 200_000 });
    expect(bounded.remainingPriceKrw()).toBe(200_000);
    bounded.reserve('sq_0', mkCandidate('w1', 50)); // 67 500 KRW
    expect(bounded.remainingPriceKrw()).toBe(
      200_000 - 50 * KRW_PER_USD_APPROXIMATE,
    );
    // Release returns the headroom.
    bounded.release('sq_0');
    expect(bounded.remainingPriceKrw()).toBe(200_000);
  });

  it('candidates without priceUsd reserve at 0 KRW but still count', () => {
    const ledger = new InMemoryBudgetLedger({ priceTotalKrw: 0 });
    // priceUsd=undefined → 0 KRW; reservation still counts.
    ledger.reserve('sq_0', mkCandidate('w1'));
    const snap = ledger.snapshot();
    expect(snap.candidateCount).toBe(1);
    expect(snap.priceTotalKrw).toBe(0);
  });

  it('negative / NaN priceUsd is clamped to 0 KRW (rule 32 adjacent — no trusting external data)', () => {
    const ledger = new InMemoryBudgetLedger();
    ledger.reserve('sq_0', mkCandidate('w1', -10));
    ledger.reserve('sq_1', mkCandidate('w2', Number.NaN));
    ledger.reserve('sq_2', mkCandidate('w3', Number.POSITIVE_INFINITY));
    expect(ledger.snapshot().priceTotalKrw).toBe(0);
  });

  it('constructor rejects a NaN / negative priceTotalKrw ceiling', () => {
    expect(
      () => new InMemoryBudgetLedger({ priceTotalKrw: Number.NaN }),
    ).toThrowError(RangeError);
    expect(
      () => new InMemoryBudgetLedger({ priceTotalKrw: -1 }),
    ).toThrowError(RangeError);
  });

  it('ceiling=0 blocks any priced reservation but permits zero-priced ones', () => {
    const ledger = new InMemoryBudgetLedger({ priceTotalKrw: 0 });
    // Zero-priced candidate is allowed under a zero ceiling — reserve
    // count still ticks, but the price axis never rises above 0.
    expect(() => ledger.reserve('sq_0', mkCandidate('w_free'))).not.toThrow();
    expect(() =>
      ledger.reserve('sq_1', mkCandidate('w_paid', 1)),
    ).toThrowError(BudgetViolationError);
  });

  it('counter injection isolates tests from the global counter', () => {
    const local = createBudgetLedgerCounter();
    const ledger = new InMemoryBudgetLedger({}, local);
    ledger.reserve('sq_0', mkCandidate('w1', 10));
    ledger.release('sq_0');
    expect(local.snapshot()).toEqual({
      BUDGET_LEDGER_RESERVE_SUCCESS: 1,
      BUDGET_LEDGER_RESERVE_VIOLATION: 0,
      BUDGET_LEDGER_RELEASE_COUNT: 1,
    });
    // The global counter was untouched in this test.
    expect(
      globalBudgetLedgerCounter.snapshot().BUDGET_LEDGER_RESERVE_SUCCESS,
    ).toBe(0);
  });

  it('reserve replacement correctly updates running total without drift', () => {
    // Rule 18-adjacent boundary: an overwrite sequence across many
    // slots must never leave the running total negative or drifting.
    const ledger = new InMemoryBudgetLedger();
    ledger.reserve('sq_0', mkCandidate('w1', 10));
    ledger.reserve('sq_0', mkCandidate('w2', 20));
    ledger.reserve('sq_0', mkCandidate('w3', 5));
    ledger.release('sq_0');
    ledger.reserve('sq_0', mkCandidate('w4', 7));
    expect(ledger.snapshot().priceTotalKrw).toBe(7 * KRW_PER_USD_APPROXIMATE);
  });
});
