/**
 * Concrete metric collector for query-entry security events.
 *
 * Interface definitions live in domain/security/port/security-observer.port.ts
 * (hexagonal: domain port). This file provides the infrastructure implementation.
 *
 * Two layers are exposed:
 *   1. `QueryEntrySecurityMetricsCollector` — the long-standing request-scoped
 *      counter (preserves the existing API exactly).
 *   2. `createTimeBucketedSecurityMetrics` — maturity-4 time-series ring
 *      counter, reason-keyed, with an injectable clock and a structural
 *      threshold-alert hook. Mirrors `silent-skip-counters.ts` so a single
 *      mental model covers both observability surfaces.
 */

import type {
  QueryEntrySecurityMetrics,
  QueryEntrySecurityObserver,
} from '../../domain/security/port/security-observer.port.js';

class QueryEntrySecurityMetricsCollector implements QueryEntrySecurityObserver {
  private layer1Blocks = 0;
  private layer2Blocks = 0;
  private judgeErrors = 0;
  private failClosedBlocks = 0;
  private failOpenBypasses = 0;
  private lastJudgeError: { error: unknown; mode: 'fail_open' | 'fail_closed'; timestamp: number } | undefined;

  onLayer1Blocked(_reason: string): void {
    this.layer1Blocks++;
  }

  onLayer2Blocked(_reason: string): void {
    this.layer2Blocks++;
  }

  onJudgeError(error: unknown, mode: 'fail_open' | 'fail_closed'): void {
    this.judgeErrors++;
    // Store only the error message to prevent retaining large Error objects / closures.
    const message = error instanceof Error ? error.message : String(error);
    this.lastJudgeError = { error: message, mode, timestamp: Date.now() };
  }

  onFailClosedBlock(): void {
    this.failClosedBlocks++;
  }

  onFailOpenBypass(): void {
    this.failOpenBypasses++;
  }

  getMetrics(): QueryEntrySecurityMetrics {
    return {
      layer1Blocks: this.layer1Blocks,
      layer2Blocks: this.layer2Blocks,
      judgeErrors: this.judgeErrors,
      failClosedBlocks: this.failClosedBlocks,
      failOpenBypasses: this.failOpenBypasses,
      ...(this.lastJudgeError !== undefined
        ? { lastJudgeErrorTimestamp: this.lastJudgeError.timestamp, lastJudgeErrorMode: this.lastJudgeError.mode }
        : {}),
    };
  }

  reset(): void {
    this.layer1Blocks = 0;
    this.layer2Blocks = 0;
    this.judgeErrors = 0;
    this.failClosedBlocks = 0;
    this.failOpenBypasses = 0;
    this.lastJudgeError = undefined;
  }
}

let globalCollector: QueryEntrySecurityMetricsCollector | undefined;

export function getQueryEntrySecurityMetricsCollector(): QueryEntrySecurityMetricsCollector {
  globalCollector ??= new QueryEntrySecurityMetricsCollector();
  return globalCollector;
}

// ─────────────────────────────────────────────────────────────────────────────
// Time-bucketed (time-series) security metrics — maturity 4.
//
// Rationale: the cumulative collector above tells us "how many blocks ever",
// but operators need rate-windowed signals: "homoglyph spike in the last
// minute" or "alert when prompt-injection rate exceeds N over 5 minutes".
// This adds a per-reason ring of fixed-width time buckets plus a structural
// `checkThreshold` hook callers wire into alerting transports. The
// implementation mirrors `silent-skip-counters.ts` — same allocation-free
// `Uint32Array` ring, same injectable clock, same strict-`>` threshold.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical security-block reasons. Kept narrow on purpose; new reasons must
 * be added here so callers cannot silently drift the reason vocabulary.
 */
export type SecurityBlockReason =
  | 'homoglyph'
  | 'injection'
  | 'rate_limit'
  | 'oversized'
  | 'prompt_injection';

const SECURITY_BLOCK_REASONS: readonly SecurityBlockReason[] = [
  'homoglyph',
  'injection',
  'rate_limit',
  'oversized',
  'prompt_injection',
] as const;

const SECURITY_BLOCK_REASON_SET: ReadonlySet<string> = new Set(SECURITY_BLOCK_REASONS);

/** Verdict returned by `checkThreshold` — structural only; never dispatches. */
interface SecurityMetricsThresholdVerdict {
  readonly kind: SecurityBlockReason;
  readonly observed: number;
  readonly threshold: number;
  readonly tripped: boolean;
}

interface TimeBucketedSecurityMetricsOptions {
  /** Bucket width in milliseconds. Must be a positive integer. */
  readonly bucketWidthMs: number;
  /** Number of buckets retained in the ring. Window = `bucketWidthMs * capacity`. */
  readonly capacity: number;
  /** Injectable clock. Defaults to `() => Date.now()`. */
  readonly now?: () => number;
}

/** Prometheus-friendly row in the export snapshot. */
export interface SecurityMetricsSnapshotRow {
  readonly reason: SecurityBlockReason;
  /** Count in the bucket containing `now()`. */
  readonly count_60s: number;
  /** Sum of all buckets in the live window. */
  readonly count_300s: number;
}

interface TimeBucketedSecurityMetrics {
  /** Increment the current-time bucket for `reason`. Unknown reasons silently dropped. */
  increment(reason: SecurityBlockReason): void;
  /** Sum of events across the live window for `reason`. Unknown reasons return 0. */
  totalWithinWindow(reason: SecurityBlockReason): number;
  /** Count in the bucket containing `now()` for `reason`. Unknown reasons return 0. */
  currentBucketCount(reason: SecurityBlockReason): number;
  /**
   * Structural threshold check: `tripped` is true iff the total within the
   * live window is **strictly greater than** `threshold`. Equality is NOT
   * tripped — alerting transports fire on "exceeds" rather than "reaches".
   */
  checkThreshold(reason: SecurityBlockReason, threshold: number): SecurityMetricsThresholdVerdict;
  /**
   * Prometheus-friendly export. Emits one row per known reason (even at
   * zero) so dashboards see the full reason cardinality.
   */
  snapshot(): readonly SecurityMetricsSnapshotRow[];
  /** Clear all rings. */
  reset(): void;
}

interface ReasonRing {
  readonly counts: Uint32Array;
  /** Bucket index (`floor(now / bucketWidthMs)`) most recently written. */
  lastBucketIndex: number;
  /** Whether the ring has ever been written. */
  initialized: boolean;
}

export function createTimeBucketedSecurityMetrics(
  opts: TimeBucketedSecurityMetricsOptions,
): TimeBucketedSecurityMetrics {
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

  const rings = new Map<SecurityBlockReason, ReasonRing>();

  function getOrCreateRing(reason: SecurityBlockReason): ReasonRing {
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
    return (((bucketIndex % capacity) + capacity) % capacity);
  }

  function sumWindow(ring: ReasonRing): number {
    let sum = 0;
    for (let i = 0; i < capacity; i++) {
      sum += ring.counts[i] ?? 0;
    }
    return sum;
  }

  return {
    increment(reason) {
      if (!SECURITY_BLOCK_REASON_SET.has(reason)) return;
      const ring = getOrCreateRing(reason);
      const current = bucketIndexNow();
      advanceRing(ring, current);
      const slot = slotOf(current);
      ring.counts[slot] = (ring.counts[slot] ?? 0) + 1;
    },

    totalWithinWindow(reason) {
      if (!SECURITY_BLOCK_REASON_SET.has(reason)) return 0;
      const ring = rings.get(reason);
      if (ring === undefined || !ring.initialized) return 0;
      advanceRing(ring, bucketIndexNow());
      return sumWindow(ring);
    },

    currentBucketCount(reason) {
      if (!SECURITY_BLOCK_REASON_SET.has(reason)) return 0;
      const ring = rings.get(reason);
      if (ring === undefined || !ring.initialized) return 0;
      const current = bucketIndexNow();
      advanceRing(ring, current);
      return ring.counts[slotOf(current)] ?? 0;
    },

    checkThreshold(reason, threshold) {
      let observed = 0;
      if (SECURITY_BLOCK_REASON_SET.has(reason)) {
        const ring = rings.get(reason);
        if (ring !== undefined && ring.initialized) {
          advanceRing(ring, bucketIndexNow());
          observed = sumWindow(ring);
        }
      }
      return {
        kind: reason,
        observed,
        threshold,
        tripped: observed > threshold,
      };
    },

    snapshot() {
      const rows: SecurityMetricsSnapshotRow[] = [];
      const current = bucketIndexNow();
      for (const reason of SECURITY_BLOCK_REASONS) {
        const ring = rings.get(reason);
        if (ring === undefined || !ring.initialized) {
          rows.push({ reason, count_60s: 0, count_300s: 0 });
          continue;
        }
        advanceRing(ring, current);
        rows.push({
          reason,
          count_60s: ring.counts[slotOf(current)] ?? 0,
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
