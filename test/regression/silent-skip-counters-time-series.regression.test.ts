/**
 * Time-series bucket aggregation + percentile/threshold alert hook for the
 * silent-skip counters (maturity bump 3 → 4).
 *
 * Invariants:
 *   - Reason-keyed bucketing: each `SilentSkipKind` accumulates in its own
 *     ring of fixed-width time buckets.
 *   - Roll-over: events older than (bucketWidthMs * capacity) drop out.
 *   - Deterministic via injectable `now()` — no real timers, no setTimeout.
 *   - Threshold alert hook returns a structural verdict, not a side effect.
 *
 * Append-only regression file: never delete cases.
 */
import { describe, expect, it } from 'vitest';
import {
  createTimeBucketedSilentSkipCounters,
  type SilentSkipKind,
} from '../../src/domain/observability/silent-skip-counters.js';

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

describe('TimeBucketedSilentSkipCounters', () => {
  it('counts 3 events in the current minute bucket as 3', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedSilentSkipCounters({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    counters.increment('cache_read_failure');
    counters.increment('cache_read_failure');
    counters.increment('cache_read_failure');

    expect(counters.totalWithinWindow('cache_read_failure')).toBe(3);
    expect(counters.currentBucketCount('cache_read_failure')).toBe(3);
  });

  it('expires events older than the ring window on roll-over', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedSilentSkipCounters({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    counters.increment('cache_read_failure');
    counters.increment('cache_read_failure');

    // Advance EXACTLY past the ring window: capacity * bucketWidthMs.
    clock.advance(RING_CAPACITY * BUCKET_MS);
    counters.increment('cache_read_failure');

    // The two original events have fully aged out of the window.
    expect(counters.totalWithinWindow('cache_read_failure')).toBe(1);
  });

  it('aggregates per-reason — schema_fail vs low_confidence do not mix', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedSilentSkipCounters({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    counters.increment('json_parse_failure');
    counters.increment('json_parse_failure');
    counters.increment('embedding_empty_vector');

    expect(counters.totalWithinWindow('json_parse_failure')).toBe(2);
    expect(counters.totalWithinWindow('embedding_empty_vector')).toBe(1);
    // A third unrelated reason stays at zero.
    expect(counters.totalWithinWindow('cache_write_failure')).toBe(0);
  });

  it('threshold alert hook trips when bucket count exceeds threshold', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedSilentSkipCounters({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    counters.increment('cache_read_failure');
    counters.increment('cache_read_failure');
    counters.increment('cache_read_failure');

    // Under threshold (count=3, threshold=5) → not tripped.
    const verdictUnder = counters.checkThreshold('cache_read_failure', 5);
    expect(verdictUnder.tripped).toBe(false);
    expect(verdictUnder.kind).toBe('cache_read_failure');
    expect(verdictUnder.observed).toBe(3);
    expect(verdictUnder.threshold).toBe(5);

    // Push over threshold.
    counters.increment('cache_read_failure');
    counters.increment('cache_read_failure');
    counters.increment('cache_read_failure');

    const verdictOver = counters.checkThreshold('cache_read_failure', 5);
    expect(verdictOver.tripped).toBe(true);
    expect(verdictOver.kind).toBe('cache_read_failure');
    expect(verdictOver.observed).toBe(6);
    expect(verdictOver.threshold).toBe(5);
  });

  it('threshold check at the exact boundary is NOT tripped (strict >)', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedSilentSkipCounters({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    counters.increment('json_parse_failure');
    counters.increment('json_parse_failure');
    counters.increment('json_parse_failure');

    // observed === threshold → not tripped; strictly greater required.
    const verdict = counters.checkThreshold('json_parse_failure', 3);
    expect(verdict.tripped).toBe(false);
    expect(verdict.observed).toBe(3);
  });

  // ─── Adjacent invariants ──────────────────────────────────────────────

  it('empty ring (no events) returns zero counts and a non-tripped verdict', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedSilentSkipCounters({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    expect(counters.totalWithinWindow('cache_read_failure')).toBe(0);
    expect(counters.currentBucketCount('cache_read_failure')).toBe(0);

    const verdict = counters.checkThreshold('cache_read_failure', 1);
    expect(verdict.tripped).toBe(false);
    expect(verdict.observed).toBe(0);
  });

  it('events at the exact bucket boundary fall in the NEW bucket', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedSilentSkipCounters({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    // Bucket-1 starts at EPOCH; one event lands in bucket-1.
    counters.increment('cache_read_failure');
    expect(counters.currentBucketCount('cache_read_failure')).toBe(1);

    // Advance EXACTLY one bucket width — boundary belongs to the next bucket.
    clock.advance(BUCKET_MS);
    counters.increment('cache_read_failure');

    // Total still 2 (both inside the 5-bucket window),
    // but the *current* bucket holds only the new event.
    expect(counters.totalWithinWindow('cache_read_failure')).toBe(2);
    expect(counters.currentBucketCount('cache_read_failure')).toBe(1);
  });

  it('gracefully ignores unknown reasons (no throw on query, no throw on increment)', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedSilentSkipCounters({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    const bogus = 'not_a_real_kind' as unknown as SilentSkipKind;

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
    const counters = createTimeBucketedSilentSkipCounters({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    counters.increment('cache_read_failure'); // bucket t=0
    clock.advance(BUCKET_MS);
    counters.increment('cache_read_failure'); // bucket t=1
    clock.advance(BUCKET_MS);
    counters.increment('cache_read_failure'); // bucket t=2

    // 3 buckets used, ring of 5 — nothing expired yet.
    expect(counters.totalWithinWindow('cache_read_failure')).toBe(3);

    // Advance 3 more bucket widths. Now we're at t=5; oldest bucket
    // (t=0) has rolled out (window covers t=1..t=5).
    clock.advance(3 * BUCKET_MS);
    expect(counters.totalWithinWindow('cache_read_failure')).toBe(2);
  });

  it('reset clears all reason rings', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedSilentSkipCounters({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    counters.increment('cache_read_failure');
    counters.increment('json_parse_failure');
    counters.reset();

    expect(counters.totalWithinWindow('cache_read_failure')).toBe(0);
    expect(counters.totalWithinWindow('json_parse_failure')).toBe(0);
  });
});
