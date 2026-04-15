/**
 * ADR-013 Phase 1c.x: BudgetLedger — per-request reservation ledger for
 * post-assignment budget accounting on the bundle-selector path.
 *
 * This module replaces the `onReserveAssignment` callback stub that
 * PR4 shipped as a pre-emptive fix for the P1-C bug ("unselected
 * candidates must not burn budget"). The callback contract stays alive
 * as a deprecated test-seam fallback, but production wiring now
 * instantiates this concrete ledger per request and threads it through
 * {@link GraphExecutorDeps}.
 *
 * Design invariants:
 *   1. **Pure in-process.** No I/O, no Redis, no database. A request-
 *      scoped instance is created inside the hybrid-candidates flow and
 *      dies with the request. There is NO module-level singleton.
 *   2. **Canonical KRW.** Price book-keeping is in KRW. USD prices on
 *      `HybridCandidate.priceUsd` are converted using
 *      `KRW_PER_USD_APPROXIMATE` from `src/domain/shared/constants.ts`
 *      (SSoT; rule 30). Candidates with no price count as zero.
 *   3. **Idempotent reserve.** Re-reserving the same
 *      `(subqueryId, entityId)` is a no-op — this tolerates callers
 *      that retry on transient errors.
 *   4. **Fail-closed overflow.** When a global `priceTotalKrw` budget
 *      was supplied, a reservation that would push the running total
 *      past the ceiling throws {@link BudgetViolationError} instead of
 *      silently over-committing. The ledger's internal state is NOT
 *      mutated on the rejected reservation.
 *   5. **Release is surgical.** `release(subqueryId)` clears only that
 *      slot so the executor's critic-retry path (ADR-015 Axis 2) can
 *      safely re-run retrieval without double-counting.
 */

import type { HybridCandidate } from '../model/hybrid-candidate.js';
import { KRW_PER_USD_APPROXIMATE } from '../../shared/constants.js';
import {
  globalBudgetLedgerCounter,
  type BudgetLedgerCounter,
} from '../../../observability/budget-ledger-counters.js';

/**
 * Snapshot of a single reservation. Readonly by construction — callers
 * receive a frozen copy via {@link BudgetLedger.snapshot}.
 */
export interface ReservedCandidate {
  readonly subqueryId: string;
  readonly entityId: string;
  /** Price contribution against the ledger in KRW. 0 when the candidate
   *  carries no price — reservations are still counted. */
  readonly priceKrw: number;
  /** ISO-8601 wall-clock timestamp at the moment of reservation. */
  readonly reservedAt: string;
}

/**
 * Telemetry-friendly snapshot of the ledger. Safe to log.
 */
export interface BudgetLedgerSnapshot {
  /** Running KRW total across all current reservations. 0 when empty. */
  readonly priceTotalKrw: number;
  /** Number of active reservations. */
  readonly candidateCount: number;
  /** Per-subquery reservations keyed by `subqueryId`. Frozen. */
  readonly reservations: ReadonlyMap<string, ReservedCandidate>;
}

export interface BudgetLedger {
  /**
   * Reserve `candidate` against the `subqueryId` slot. Idempotent on
   * the same `(subqueryId, entityId)` pair. Throws
   * {@link BudgetViolationError} when the reservation would exceed the
   * configured KRW budget ceiling (if any). On throw, the ledger's
   * internal state is unchanged.
   */
  reserve(subqueryId: string, candidate: HybridCandidate): void;
  /**
   * Release the reservation for the given `subqueryId`, if any. No-op
   * when the slot is empty. Used by the critic-retry path so retried
   * retrieval does not reserve against stale slots.
   */
  release(subqueryId: string): void;
  /**
   * Telemetry / debugging snapshot of the current state. The returned
   * map is frozen; callers must not attempt to mutate it.
   */
  snapshot(): BudgetLedgerSnapshot;
  /**
   * Remaining KRW budget headroom. Returns `undefined` when the ledger
   * was constructed without a global `priceTotalKrw` ceiling (unlimited
   * mode). Otherwise returns `max(0, ceiling - running total)`.
   */
  remainingPriceKrw(): number | undefined;
}

export interface BudgetLedgerOptions {
  /**
   * Optional KRW ceiling on the sum of reserved candidate prices. When
   * omitted, the ledger still records reservations but never throws on
   * price — useful for telemetry-only runs.
   */
  readonly priceTotalKrw?: number | undefined;
}

/**
 * Thrown when {@link BudgetLedger.reserve} would push the running KRW
 * total past the configured ceiling. Carries the arithmetic so callers
 * can surface a structured degradation reason.
 */
export class BudgetViolationError extends Error {
  public readonly subqueryId: string;
  public readonly entityId: string;
  public readonly reservedKrw: number;
  public readonly wouldBecomeKrw: number;
  public readonly ceilingKrw: number;

  public constructor(params: {
    readonly subqueryId: string;
    readonly entityId: string;
    readonly reservedKrw: number;
    readonly wouldBecomeKrw: number;
    readonly ceilingKrw: number;
  }) {
    super(
      `BudgetViolationError: reserving subquery=${params.subqueryId} entity=${params.entityId} `
        + `would raise total to ${params.wouldBecomeKrw} KRW > ceiling ${params.ceilingKrw} KRW`,
    );
    this.name = 'BudgetViolationError';
    this.subqueryId = params.subqueryId;
    this.entityId = params.entityId;
    this.reservedKrw = params.reservedKrw;
    this.wouldBecomeKrw = params.wouldBecomeKrw;
    this.ceilingKrw = params.ceilingKrw;
  }
}

/**
 * Convert a `HybridCandidate`'s optional `priceUsd` to an integer KRW
 * value for ledger book-keeping. Returns 0 when the price is absent,
 * non-finite, or negative — the candidate is still reserveable but
 * does not count against the ceiling. Uses
 * `KRW_PER_USD_APPROXIMATE` (the SSoT constant from
 * `src/domain/shared/constants.ts`). Not exported: the ledger is the
 * only legitimate caller of this helper, and inlining the conversion
 * would duplicate the clamp / NaN guard across read-sites.
 */
function candidatePriceToKrw(candidate: HybridCandidate): number {
  const usd = candidate.priceUsd;
  if (usd === undefined || !Number.isFinite(usd) || usd < 0) return 0;
  // Round to the nearest integer KRW to keep ledger arithmetic stable
  // across repeated reservations. The FX constant is approximate; sub-
  // integer drift would accumulate across many reservations otherwise.
  return Math.round(usd * KRW_PER_USD_APPROXIMATE);
}

/**
 * Default concrete {@link BudgetLedger}. Construct one per request. The
 * constructor accepts an optional counter so tests can inject a local
 * counter without touching the process-global one.
 */
export class InMemoryBudgetLedger implements BudgetLedger {
  private readonly ceilingKrw: number | undefined;
  private readonly counter: BudgetLedgerCounter;
  private readonly reservations: Map<string, ReservedCandidate> = new Map();
  private runningPriceKrw = 0;

  public constructor(
    options: BudgetLedgerOptions = {},
    counter: BudgetLedgerCounter = globalBudgetLedgerCounter,
  ) {
    const ceiling = options.priceTotalKrw;
    // Ceiling is optional; when present it MUST be a finite, non-negative
    // number. A NaN / negative ceiling would render every reservation
    // violating — fail early rather than silently reject every call.
    if (
      ceiling !== undefined
      && (!Number.isFinite(ceiling) || ceiling < 0)
    ) {
      throw new RangeError(
        `InMemoryBudgetLedger: priceTotalKrw must be a finite non-negative number when supplied (got ${String(ceiling)})`,
      );
    }
    this.ceilingKrw = ceiling;
    this.counter = counter;
  }

  public reserve(subqueryId: string, candidate: HybridCandidate): void {
    const entityId = String(candidate.entityId);
    const existing = this.reservations.get(subqueryId);
    // Idempotent on the same (subqueryId, entityId). Rule 17 (for-of +
    // early-exit semantics) — returning here is correct because we
    // want to short-circuit the duplicate; counters do NOT increment so
    // the success counter measures unique reservations.
    if (existing !== undefined && existing.entityId === entityId) return;

    const priceKrw = candidatePriceToKrw(candidate);
    // Displacement: if a different entity already holds this slot we
    // subtract its price before computing the new running total. This
    // keeps reserve() usable as an overwrite for callers that want to
    // swap a candidate in a slot without an explicit release().
    const displacedKrw = existing?.priceKrw ?? 0;
    const wouldBecome = this.runningPriceKrw - displacedKrw + priceKrw;

    if (
      this.ceilingKrw !== undefined
      && wouldBecome > this.ceilingKrw
    ) {
      this.counter.increment('BUDGET_LEDGER_RESERVE_VIOLATION');
      throw new BudgetViolationError({
        subqueryId,
        entityId,
        reservedKrw: priceKrw,
        wouldBecomeKrw: wouldBecome,
        ceilingKrw: this.ceilingKrw,
      });
    }

    // Commit: apply displacement first (release the old slot entry) so
    // the map/accumulator never transiently double-counts.
    if (existing !== undefined) {
      this.runningPriceKrw -= existing.priceKrw;
      this.reservations.delete(subqueryId);
    }
    const record: ReservedCandidate = {
      subqueryId,
      entityId,
      priceKrw,
      reservedAt: new Date().toISOString(),
    };
    this.reservations.set(subqueryId, record);
    this.runningPriceKrw += priceKrw;
    this.counter.increment('BUDGET_LEDGER_RESERVE_SUCCESS');
  }

  public release(subqueryId: string): void {
    const existing = this.reservations.get(subqueryId);
    if (existing === undefined) return;
    this.reservations.delete(subqueryId);
    this.runningPriceKrw -= existing.priceKrw;
    // Defensive: floating / displacement arithmetic should never drive
    // the running total negative, but clamp to 0 if a future refactor
    // introduces a drift. The clamp is a safety net — tests assert the
    // expected value directly.
    if (this.runningPriceKrw < 0) this.runningPriceKrw = 0;
    this.counter.increment('BUDGET_LEDGER_RELEASE_COUNT');
  }

  public snapshot(): BudgetLedgerSnapshot {
    // Freeze a shallow copy so downstream telemetry cannot mutate the
    // live map. The ReservedCandidate entries are already readonly by
    // interface, so a shallow clone is sufficient.
    const frozen = new Map<string, ReservedCandidate>();
    for (const [k, v] of this.reservations) frozen.set(k, v);
    return {
      priceTotalKrw: this.runningPriceKrw,
      candidateCount: frozen.size,
      reservations: frozen,
    };
  }

  public remainingPriceKrw(): number | undefined {
    if (this.ceilingKrw === undefined) return undefined;
    const remaining = this.ceilingKrw - this.runningPriceKrw;
    return remaining > 0 ? remaining : 0;
  }
}
