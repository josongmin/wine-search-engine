/**
 * Time-series bucket aggregation + threshold alert hook for the retrieval
 * degradation metrics collector (maturity bump 3 → 4).
 *
 * Invariants:
 *   - Reason-keyed bucketing: each `RetrievalDegradationReason` accumulates in
 *     its own ring of fixed-width time buckets.
 *   - Roll-over: events older than (bucketWidthMs * capacity) drop out.
 *   - Deterministic via injectable `now()` — no real timers, no setTimeout.
 *   - Threshold alert hook returns a structural verdict, not a side effect.
 *   - Snapshot export emits Prometheus-friendly `{reason, count_60s, count_300s}`
 *     rows per reason.
 *   - Backward compatibility: legacy `RetrievalDegradationMetricsCollector`
 *     API (`onRetrievalStarted`, `onDegradation`, `getMetrics`) is preserved.
 *
 * Append-only regression file: never delete cases.
 */
import { describe, expect, it } from 'vitest';
import {
  createTimeBucketedRetrievalDegradationCounters,
  RetrievalDegradationMetricsCollector,
  type RetrievalDegradationReason,
} from '../../src/infrastructure/observability/retrieval-degradation-metrics.js';

/**
 * Build a controllable clock starting at `start` ms.
 * `advance(ms)` shifts the clock by an exact amount; `now()` returns the
 * current value. No real time is consumed.
 */
function mutableClock(start: number): {
  now: () => number;
  advance: (ms: number) => void;
  set: (ms: number) => void;
} {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (ms) => {
      t = ms;
    },
  };
}

const BUCKET_MS = 60_000; // 1 minute buckets
const RING_CAPACITY = 5; // 5 buckets ⇒ 5-minute window
const EPOCH = 1_700_000_000_000; // arbitrary fixed start

describe('TimeBucketedRetrievalDegradationCounters', () => {
  it('counts 3 events in the current minute bucket as 3', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedRetrievalDegradationCounters({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    counters.increment('pool_shrink');
    counters.increment('pool_shrink');
    counters.increment('pool_shrink');

    expect(counters.totalWithinWindow('pool_shrink')).toBe(3);
    expect(counters.currentBucketCount('pool_shrink')).toBe(3);
  });

  it('expires events older than the ring window on roll-over', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedRetrievalDegradationCounters({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    counters.increment('channel_omit');
    counters.increment('channel_omit');

    // Advance EXACTLY past the ring window: capacity * bucketWidthMs.
    clock.advance(RING_CAPACITY * BUCKET_MS);
    counters.increment('channel_omit');

    // The two original events have fully aged out of the window.
    expect(counters.totalWithinWindow('channel_omit')).toBe(1);
  });

  it('aggregates per-reason — pool_shrink vs zero_result do not mix', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedRetrievalDegradationCounters({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    counters.increment('pool_shrink');
    counters.increment('pool_shrink');
    counters.increment('zero_result');

    expect(counters.totalWithinWindow('pool_shrink')).toBe(2);
    expect(counters.totalWithinWindow('zero_result')).toBe(1);
    // A third unrelated reason stays at zero.
    expect(counters.totalWithinWindow('silent_skip')).toBe(0);
    expect(counters.totalWithinWindow('channel_omit')).toBe(0);
  });

  it('threshold alert hook trips when bucket count exceeds threshold', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedRetrievalDegradationCounters({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    counters.increment('zero_result');
    counters.increment('zero_result');
    counters.increment('zero_result');

    // Under threshold (count=3, threshold=5) → not tripped.
    const verdictUnder = counters.checkThreshold('zero_result', 5);
    expect(verdictUnder.tripped).toBe(false);
    expect(verdictUnder.reason).toBe('zero_result');
    expect(verdictUnder.observed).toBe(3);
    expect(verdictUnder.threshold).toBe(5);

    // Push over threshold.
    counters.increment('zero_result');
    counters.increment('zero_result');
    counters.increment('zero_result');

    const verdictOver = counters.checkThreshold('zero_result', 5);
    expect(verdictOver.tripped).toBe(true);
    expect(verdictOver.reason).toBe('zero_result');
    expect(verdictOver.observed).toBe(6);
    expect(verdictOver.threshold).toBe(5);
  });

  it('threshold check at the exact boundary is NOT tripped (strict >)', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedRetrievalDegradationCounters({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    counters.increment('silent_skip');
    counters.increment('silent_skip');
    counters.increment('silent_skip');

    // observed === threshold → not tripped; strictly greater required.
    const verdict = counters.checkThreshold('silent_skip', 3);
    expect(verdict.tripped).toBe(false);
    expect(verdict.observed).toBe(3);
  });

  // ─── Adjacent invariants ──────────────────────────────────────────────

  it('empty ring (no events) returns zero counts and a non-tripped verdict', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedRetrievalDegradationCounters({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    expect(counters.totalWithinWindow('pool_shrink')).toBe(0);
    expect(counters.currentBucketCount('pool_shrink')).toBe(0);

    const verdict = counters.checkThreshold('pool_shrink', 1);
    expect(verdict.tripped).toBe(false);
    expect(verdict.observed).toBe(0);
  });

  it('events at the exact bucket boundary fall in the NEW bucket', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedRetrievalDegradationCounters({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    // Bucket-1 starts at EPOCH; one event lands in bucket-1.
    counters.increment('pool_shrink');
    expect(counters.currentBucketCount('pool_shrink')).toBe(1);

    // Advance EXACTLY one bucket width — boundary belongs to the next bucket.
    clock.advance(BUCKET_MS);
    counters.increment('pool_shrink');

    // Total still 2 (both inside the 5-bucket window),
    // but the *current* bucket holds only the new event.
    expect(counters.totalWithinWindow('pool_shrink')).toBe(2);
    expect(counters.currentBucketCount('pool_shrink')).toBe(1);
  });

  it('gracefully ignores unknown reasons (no throw on query, no throw on increment)', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedRetrievalDegradationCounters({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    const bogus = 'not_a_real_reason' as unknown as RetrievalDegradationReason;

    // Query side: unknown reason returns 0, never throws.
    expect(() => counters.totalWithinWindow(bogus)).not.toThrow();
    expect(counters.totalWithinWindow(bogus)).toBe(0);

    // Increment side: unknown reason is silently dropped (no throw — this
    // path is invoked from background telemetry where throwing breaks callers).
    expect(() => counters.increment(bogus)).not.toThrow();
    expect(counters.totalWithinWindow(bogus)).toBe(0);

    // Threshold check on unknown reason: zero, not tripped.
    const verdict = counters.checkThreshold(bogus, 1);
    expect(verdict.tripped).toBe(false);
    expect(verdict.observed).toBe(0);
  });

  it('partial roll-over keeps events still inside the window', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedRetrievalDegradationCounters({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    counters.increment('pool_shrink'); // bucket t=0
    clock.advance(BUCKET_MS);
    counters.increment('pool_shrink'); // bucket t=1
    clock.advance(BUCKET_MS);
    counters.increment('pool_shrink'); // bucket t=2

    // 3 buckets used, ring of 5 — nothing expired yet.
    expect(counters.totalWithinWindow('pool_shrink')).toBe(3);

    // Advance 3 more bucket widths. Now we're at t=5; oldest bucket
    // (t=0) has rolled out (window covers t=1..t=5).
    clock.advance(3 * BUCKET_MS);
    expect(counters.totalWithinWindow('pool_shrink')).toBe(2);
  });

  it('boundary case: 0 events vs 1 event in current bucket', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedRetrievalDegradationCounters({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    // 0 events → current bucket count is 0.
    expect(counters.currentBucketCount('channel_omit')).toBe(0);
    // checkThreshold(_, 0) on observed=0: observed > threshold is false (strict >).
    expect(counters.checkThreshold('channel_omit', 0).tripped).toBe(false);

    counters.increment('channel_omit');
    // 1 event → currentBucketCount is exactly 1.
    expect(counters.currentBucketCount('channel_omit')).toBe(1);
    // observed=1 > threshold=0 → tripped.
    expect(counters.checkThreshold('channel_omit', 0).tripped).toBe(true);
  });

  it('multiple reasons in the same bucket each track independently', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedRetrievalDegradationCounters({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    // Same bucket — 1 event for each of 4 reasons.
    counters.increment('pool_shrink');
    counters.increment('channel_omit');
    counters.increment('zero_result');
    counters.increment('silent_skip');

    expect(counters.currentBucketCount('pool_shrink')).toBe(1);
    expect(counters.currentBucketCount('channel_omit')).toBe(1);
    expect(counters.currentBucketCount('zero_result')).toBe(1);
    expect(counters.currentBucketCount('silent_skip')).toBe(1);

    expect(counters.totalWithinWindow('pool_shrink')).toBe(1);
    expect(counters.totalWithinWindow('channel_omit')).toBe(1);
    expect(counters.totalWithinWindow('zero_result')).toBe(1);
    expect(counters.totalWithinWindow('silent_skip')).toBe(1);
  });

  it('snapshot exports Prometheus-friendly rows per reason with count_60s and count_300s', () => {
    const clock = mutableClock(EPOCH);
    // Ring capacity 5 with 60s buckets → 300s window. 60s window is the first
    // bucket only.
    const counters = createTimeBucketedRetrievalDegradationCounters({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    counters.increment('pool_shrink'); // t=0 bucket
    clock.advance(2 * BUCKET_MS); // jump to t=2 bucket
    counters.increment('pool_shrink'); // t=2 bucket
    counters.increment('zero_result'); // t=2 bucket

    const rows = counters.exportSnapshot();
    const byReason = new Map(rows.map((r) => [r.reason, r] as const));

    // pool_shrink: total in 300s window = 2, current 60s bucket = 1.
    expect(byReason.get('pool_shrink')?.count_300s).toBe(2);
    expect(byReason.get('pool_shrink')?.count_60s).toBe(1);
    // zero_result: total = 1, current 60s bucket = 1.
    expect(byReason.get('zero_result')?.count_300s).toBe(1);
    expect(byReason.get('zero_result')?.count_60s).toBe(1);
    // channel_omit / silent_skip never incremented → zero rows.
    expect(byReason.get('channel_omit')?.count_300s).toBe(0);
    expect(byReason.get('channel_omit')?.count_60s).toBe(0);
    expect(byReason.get('silent_skip')?.count_300s).toBe(0);
    expect(byReason.get('silent_skip')?.count_60s).toBe(0);
  });

  it('reset clears all reason rings', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedRetrievalDegradationCounters({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    counters.increment('pool_shrink');
    counters.increment('zero_result');
    counters.reset();

    expect(counters.totalWithinWindow('pool_shrink')).toBe(0);
    expect(counters.totalWithinWindow('zero_result')).toBe(0);
  });
});

describe('RetrievalDegradationMetricsCollector — backward compatibility', () => {
  it('legacy API still produces totalRetrievals / degradations / alerts', () => {
    const collector = new RetrievalDegradationMetricsCollector();

    for (let i = 0; i < 25; i++) collector.onRetrievalStarted();
    for (let i = 0; i < 5; i++) {
      collector.onDegradation({
        component: 'sparse_bm25',
        severity: 'warning',
        reason: 'pool_shrink',
        fallbackApplied: 'expanded_pool',
      });
    }

    const metrics = collector.getMetrics();
    expect(metrics.totalRetrievals).toBe(25);
    expect(metrics.degradations['sparse_bm25']).toBe(5);
    // 5/25 = 0.2 ≥ 0.1 threshold and totalRetrievals ≥ 20 → alerts fire.
    expect(metrics.alerts).toContain('retrieval_degradation_rate_high');
    expect(metrics.alerts).toContain('retrieval_sparse_bm25_degradation_high');
  });
});
