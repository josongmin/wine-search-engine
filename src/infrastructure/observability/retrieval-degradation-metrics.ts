/**
 * Infrastructure collector for retrieval degradation signals.
 *
 * Follows the same singleton + collector pattern as AgentExecutionMetricsCollector.
 * Tracks per-component degradation counts and derives aggregate rates / alerts.
 *
 * Maturity 4 addition: a reason-keyed, time-bucketed ring buffer with a
 * structural threshold-check hook for alerting transports. The legacy
 * `RetrievalDegradationMetricsCollector` API is preserved verbatim; the new
 * time-series surface lives alongside it via
 * `createTimeBucketedRetrievalDegradationCounters` and
 * `getRetrievalDegradationTimeSeries`.
 *
 * Implementation mirrors `silent-skip-counters.ts` for consistency: a
 * `Uint32Array` ring per reason, an injectable clock, and a strict-`>`
 * threshold convention so alerts fire on "exceeds" rather than "reaches".
 */

import type {
  RetrievalDegradationMetrics,
  RetrievalDegradationObserver,
  RetrievalDegradationSignal,
} from '../../domain/retrieval/port/retrieval-degradation-observer.port.js';

/** Minimum retrievals before alerts are emitted (avoids noisy cold-start alerts). */
const MIN_RETRIEVALS_FOR_ALERT = 20;

/** Degradation rate threshold above which an alert is generated. */
const DEGRADATION_RATE_ALERT_THRESHOLD = 0.1;

export class RetrievalDegradationMetricsCollector implements RetrievalDegradationObserver {
  private totalRetrievals = 0;
  private totalDegradations = 0;
  private readonly byComponent = new Map<string, number>();

  onRetrievalStarted(): void {
    this.totalRetrievals++;
  }

  onDegradation(signal: RetrievalDegradationSignal): void {
    this.totalDegradations++;
    this.byComponent.set(
      signal.component,
      (this.byComponent.get(signal.component) ?? 0) + 1,
    );
  }

  getMetrics(): RetrievalDegradationMetrics {
    const degradations: Record<string, number> = {};
    for (const [component, count] of this.byComponent.entries()) {
      degradations[component] = count;
    }

    const degradationRate =
      this.totalRetrievals > 0
        ? this.totalDegradations / this.totalRetrievals
        : 0;

    const alerts: string[] = [];
    if (this.totalRetrievals >= MIN_RETRIEVALS_FOR_ALERT) {
      if (degradationRate >= DEGRADATION_RATE_ALERT_THRESHOLD) {
        alerts.push('retrieval_degradation_rate_high');
      }

      // Per-component alerts when any single component degrades > 10% of retrievals
      for (const [component, count] of this.byComponent.entries()) {
        const componentRate = count / this.totalRetrievals;
        if (componentRate >= DEGRADATION_RATE_ALERT_THRESHOLD) {
          alerts.push(`retrieval_${component}_degradation_high`);
        }
      }
    }

    return {
      totalRetrievals: this.totalRetrievals,
      degradations,
      degradationRate,
      alerts,
    };
  }

  reset(): void {
    this.totalRetrievals = 0;
    this.totalDegradations = 0;
    this.byComponent.clear();
  }
}

let globalCollector: RetrievalDegradationMetricsCollector | undefined;

export function getRetrievalDegradationCollector(): RetrievalDegradationMetricsCollector {
  globalCollector ??= new RetrievalDegradationMetricsCollector();
  return globalCollector;
}

// ─────────────────────────────────────────────────────────────────────────────
// Time-bucketed (time-series) retrieval-degradation counters — maturity 4.
//
// Rationale: the cumulative collector above is fine for "lifetime degradation
// rate", but cannot answer "is the pool_shrink rate spiking in the last 5
// minutes?" or "alert when zero_result skips exceed N/min". This adds a
// per-reason ring of fixed-width time buckets plus a structural
// `checkThreshold` hook callers wire into alerting transports (Slack, PD,
// metrics push, etc.). The implementation is deliberately allocation-free on
// the hot path: a `Uint32Array` per reason, sized to `capacity`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reason taxonomy for time-series buckets. Intentionally a small, fixed set so
 * Prometheus label cardinality stays bounded.
 */
export type RetrievalDegradationReason =
  | 'pool_shrink'
  | 'channel_omit'
  | 'zero_result'
  | 'silent_skip';

const RETRIEVAL_DEGRADATION_REASONS: readonly RetrievalDegradationReason[] = [
  'pool_shrink',
  'channel_omit',
  'zero_result',
  'silent_skip',
] as const;

const RETRIEVAL_DEGRADATION_REASON_SET: ReadonlySet<string> = new Set(
  RETRIEVAL_DEGRADATION_REASONS,
);

/**
 * Verdict returned by `checkThreshold` — structural only; this module never
 * dispatches alerts itself.
 */
interface RetrievalDegradationThresholdVerdict {
  readonly reason: RetrievalDegradationReason;
  readonly observed: number;
  readonly threshold: number;
  readonly tripped: boolean;
}

/**
 * Single row in a Prometheus-friendly snapshot export. `count_60s` is the
 * count in the most recent bucket; `count_300s` is the live-window total.
 * (60s / 300s naming assumes the typical 1-minute bucket × 5-bucket ring; the
 * field names are stable regardless of `bucketWidthMs` / `capacity` so
 * downstream scrapers don't need re-keying.)
 */
export interface RetrievalDegradationSnapshotRow {
  readonly reason: RetrievalDegradationReason;
  readonly count_60s: number;
  readonly count_300s: number;
}

interface TimeBucketedRetrievalDegradationCountersOptions {
  /** Bucket width in milliseconds. Must be a positive integer. */
  readonly bucketWidthMs: number;
  /** Number of buckets retained in the ring. Window = `bucketWidthMs * capacity`. */
  readonly capacity: number;
  /** Injectable clock. Defaults to `() => Date.now()`. */
  readonly now?: () => number;
}

interface TimeBucketedRetrievalDegradationCounters {
  /** Increment the current-time bucket for `reason`. Unknown reasons are silently dropped. */
  increment(reason: RetrievalDegradationReason): void;
  /** Sum of events across the live window for `reason`. Unknown reasons return 0. */
  totalWithinWindow(reason: RetrievalDegradationReason): number;
  /** Count in the bucket that contains `now()` for `reason`. Unknown reasons return 0. */
  currentBucketCount(reason: RetrievalDegradationReason): number;
  /**
   * Structural threshold check: `tripped` is true iff the total within the
   * live window is **strictly greater than** `threshold`. Equality is NOT
   * tripped — this matches the convention used by alerting transports that
   * fire on "exceeds" rather than "reaches".
   */
  checkThreshold(
    reason: RetrievalDegradationReason,
    threshold: number,
  ): RetrievalDegradationThresholdVerdict;
  /**
   * Prometheus-friendly snapshot — one row per known reason with the current
   * bucket count (`count_60s`) and live-window total (`count_300s`).
   */
  exportSnapshot(): readonly RetrievalDegradationSnapshotRow[];
  /** Clear all rings (all reasons). */
  reset(): void;
}

interface ReasonRing {
  readonly counts: Uint32Array;
  /** Bucket index (`floor(now / bucketWidthMs)`) most recently written. */
  lastBucketIndex: number;
  /** Whether the ring has ever been written. */
  initialized: boolean;
}

export function createTimeBucketedRetrievalDegradationCounters(
  opts: TimeBucketedRetrievalDegradationCountersOptions,
): TimeBucketedRetrievalDegradationCounters {
  const { bucketWidthMs, capacity } = opts;
  const now = opts.now ?? ((): number => Date.now());

  if (!Number.isInteger(bucketWidthMs) || bucketWidthMs < 1) {
    throw new Error(
      `bucketWidthMs must be a positive integer, got ${String(bucketWidthMs)}`,
    );
  }
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error(`capacity must be a positive integer, got ${String(capacity)}`);
  }

  const rings = new Map<RetrievalDegradationReason, ReasonRing>();

  function getOrCreateRing(reason: RetrievalDegradationReason): ReasonRing {
    let ring = rings.get(reason);
    if (ring === undefined) {
      ring = {
        counts: new Uint32Array(capacity),
        lastBucketIndex: 0,
        initialized: false,
      };
      rings.set(reason, ring);
    }
    return ring;
  }

  /**
   * Expire buckets that have fallen outside the live window relative to
   * `currentBucketIndex`. After this call the ring is consistent at
   * `currentBucketIndex`.
   */
  function advanceRing(ring: ReasonRing, currentBucketIndex: number): void {
    if (!ring.initialized) {
      ring.lastBucketIndex = currentBucketIndex;
      ring.initialized = true;
      return;
    }
    const delta = currentBucketIndex - ring.lastBucketIndex;
    if (delta <= 0) return;
    if (delta >= capacity) {
      ring.counts.fill(0);
    } else {
      // Zero each newly entered bucket slot.
      for (let i = 1; i <= delta; i++) {
        const slot = (((ring.lastBucketIndex + i) % capacity) + capacity) % capacity;
        ring.counts[slot] = 0;
      }
    }
    ring.lastBucketIndex = currentBucketIndex;
  }

  function bucketIndexNow(): number {
    return Math.floor(now() / bucketWidthMs);
  }

  function slotOf(bucketIndex: number): number {
    // Two-step modulo handles negative bucket indices safely (now() < 0).
    return ((bucketIndex % capacity) + capacity) % capacity;
  }

  function sumWindow(ring: ReasonRing): number {
    let sum = 0;
    for (let i = 0; i < capacity; i++) {
      sum += ring.counts[i]!;
    }
    return sum;
  }

  return {
    increment(reason) {
      if (!RETRIEVAL_DEGRADATION_REASON_SET.has(reason)) return; // silently drop unknown
      const ring = getOrCreateRing(reason);
      const current = bucketIndexNow();
      advanceRing(ring, current);
      ring.counts[slotOf(current)] = (ring.counts[slotOf(current)] ?? 0) + 1;
    },

    totalWithinWindow(reason) {
      if (!RETRIEVAL_DEGRADATION_REASON_SET.has(reason)) return 0;
      const ring = rings.get(reason);
      if (ring === undefined || !ring.initialized) return 0;
      advanceRing(ring, bucketIndexNow());
      return sumWindow(ring);
    },

    currentBucketCount(reason) {
      if (!RETRIEVAL_DEGRADATION_REASON_SET.has(reason)) return 0;
      const ring = rings.get(reason);
      if (ring === undefined || !ring.initialized) return 0;
      const current = bucketIndexNow();
      advanceRing(ring, current);
      return ring.counts[slotOf(current)] ?? 0;
    },

    checkThreshold(reason, threshold) {
      // Reuse totalWithinWindow semantics for the observed value.
      let observed = 0;
      if (RETRIEVAL_DEGRADATION_REASON_SET.has(reason)) {
        const ring = rings.get(reason);
        if (ring !== undefined && ring.initialized) {
          advanceRing(ring, bucketIndexNow());
          observed = sumWindow(ring);
        }
      }
      return {
        reason,
        observed,
        threshold,
        tripped: observed > threshold,
      };
    },

    exportSnapshot() {
      const currentBucket = bucketIndexNow();
      const rows: RetrievalDegradationSnapshotRow[] = [];
      for (const reason of RETRIEVAL_DEGRADATION_REASONS) {
        const ring = rings.get(reason);
        if (ring === undefined || !ring.initialized) {
          rows.push({ reason, count_60s: 0, count_300s: 0 });
          continue;
        }
        advanceRing(ring, currentBucket);
        rows.push({
          reason,
          count_60s: ring.counts[slotOf(currentBucket)] ?? 0,
          count_300s: sumWindow(ring),
        });
      }
      return rows;
    },

    reset() {
      rings.clear();
    },
  };
}



/**
 * Process-wide shared instance. Production code paths that already increment
 * the legacy collector should mirror those increments into this counter when
 * the signal maps to a known `RetrievalDegradationReason`.
 */
