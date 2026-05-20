/**
 * Time-series bucket aggregation + reason-keyed counter + alerting threshold
 * hook for query-entry security metrics (maturity bump 3 → 4).
 *
 * Mirror of `silent-skip-counters-time-series.regression.test.ts` but scoped
 * to security reasons (homoglyph / injection / rate-limit / oversized /
 * prompt_injection).
 *
 * Invariants:
 *   - Reason-keyed bucketing: each `SecurityBlockReason` accumulates in its
 *     own ring of fixed-width time buckets — reasons NEVER mix.
 *   - Roll-over: events older than (bucketWidthMs * capacity) drop out.
 *   - Deterministic via injectable `now()` — no real timers, no setTimeout.
 *   - Threshold alert hook returns a structural `{kind, observed, threshold,
 *     tripped}` verdict; strict-`>` semantics so equality is NOT tripped.
 *   - Snapshot export is Prometheus-friendly:
 *       Array<{ reason, count_60s, count_300s }>.
 *
 * Append-only regression file: never delete cases.
 */
import { describe, expect, it } from 'vitest';
import {
  createTimeBucketedSecurityMetrics,
  type SecurityBlockReason,
} from '../../src/infrastructure/observability/query-entry-security-metrics.js';

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

const BUCKET_MS = 60_000; // 1-minute buckets
const RING_CAPACITY = 5; // 5 buckets ⇒ 5-minute window
const EPOCH = 1_700_000_000_000;

describe('TimeBucketedSecurityMetrics', () => {
  it('counts 3 homoglyph events in the current bucket as 3', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedSecurityMetrics({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    counters.increment('homoglyph');
    counters.increment('homoglyph');
    counters.increment('homoglyph');

    expect(counters.totalWithinWindow('homoglyph')).toBe(3);
    expect(counters.currentBucketCount('homoglyph')).toBe(3);
  });

  it('expires events older than the ring window on roll-over', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedSecurityMetrics({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    counters.increment('injection');
    counters.increment('injection');

    // Past the full ring window: capacity * bucketWidthMs.
    clock.advance(RING_CAPACITY * BUCKET_MS);
    counters.increment('injection');

    // The two original events have fully aged out.
    expect(counters.totalWithinWindow('injection')).toBe(1);
  });

  it('aggregates per-reason — homoglyph vs injection vs rate_limit do not mix', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedSecurityMetrics({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    counters.increment('homoglyph');
    counters.increment('homoglyph');
    counters.increment('injection');
    counters.increment('rate_limit');
    counters.increment('rate_limit');
    counters.increment('rate_limit');
    counters.increment('oversized');
    counters.increment('prompt_injection');
    counters.increment('prompt_injection');

    expect(counters.totalWithinWindow('homoglyph')).toBe(2);
    expect(counters.totalWithinWindow('injection')).toBe(1);
    expect(counters.totalWithinWindow('rate_limit')).toBe(3);
    expect(counters.totalWithinWindow('oversized')).toBe(1);
    expect(counters.totalWithinWindow('prompt_injection')).toBe(2);
  });

  it('threshold alert hook trips when count strictly exceeds threshold', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedSecurityMetrics({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    counters.increment('injection');
    counters.increment('injection');
    counters.increment('injection');

    const under = counters.checkThreshold('injection', 5);
    expect(under.tripped).toBe(false);
    expect(under.kind).toBe('injection');
    expect(under.observed).toBe(3);
    expect(under.threshold).toBe(5);

    counters.increment('injection');
    counters.increment('injection');
    counters.increment('injection');

    const over = counters.checkThreshold('injection', 5);
    expect(over.tripped).toBe(true);
    expect(over.kind).toBe('injection');
    expect(over.observed).toBe(6);
    expect(over.threshold).toBe(5);
  });

  it('threshold check at the exact boundary is NOT tripped (strict >)', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedSecurityMetrics({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    counters.increment('homoglyph');
    counters.increment('homoglyph');
    counters.increment('homoglyph');

    // observed === threshold → not tripped; strictly greater required.
    const verdict = counters.checkThreshold('homoglyph', 3);
    expect(verdict.tripped).toBe(false);
    expect(verdict.observed).toBe(3);
  });

  // ─── Adjacent invariants ──────────────────────────────────────────────

  it('empty ring (no events) returns zero counts and a non-tripped verdict', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedSecurityMetrics({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    expect(counters.totalWithinWindow('homoglyph')).toBe(0);
    expect(counters.totalWithinWindow('injection')).toBe(0);
    expect(counters.totalWithinWindow('rate_limit')).toBe(0);
    expect(counters.totalWithinWindow('oversized')).toBe(0);
    expect(counters.totalWithinWindow('prompt_injection')).toBe(0);
    expect(counters.currentBucketCount('homoglyph')).toBe(0);

    const verdict = counters.checkThreshold('injection', 1);
    expect(verdict.tripped).toBe(false);
    expect(verdict.observed).toBe(0);
  });

  it('events at the exact bucket boundary fall in the NEW bucket', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedSecurityMetrics({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    counters.increment('homoglyph');
    expect(counters.currentBucketCount('homoglyph')).toBe(1);

    // Advance EXACTLY one bucket width — boundary belongs to the NEXT bucket.
    clock.advance(BUCKET_MS);
    counters.increment('homoglyph');

    expect(counters.totalWithinWindow('homoglyph')).toBe(2);
    expect(counters.currentBucketCount('homoglyph')).toBe(1);
  });

  it('gracefully ignores unknown reasons (no throw on query or increment)', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedSecurityMetrics({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    const bogus = 'not_a_real_reason' as unknown as SecurityBlockReason;

    expect(() => counters.totalWithinWindow(bogus)).not.toThrow();
    expect(counters.totalWithinWindow(bogus)).toBe(0);

    expect(() => counters.increment(bogus)).not.toThrow();
    expect(counters.totalWithinWindow(bogus)).toBe(0);

    const verdict = counters.checkThreshold(bogus, 1);
    expect(verdict.tripped).toBe(false);
    expect(verdict.observed).toBe(0);
  });

  it('partial roll-over keeps events still inside the window', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedSecurityMetrics({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    counters.increment('rate_limit'); // bucket t=0
    clock.advance(BUCKET_MS);
    counters.increment('rate_limit'); // bucket t=1
    clock.advance(BUCKET_MS);
    counters.increment('rate_limit'); // bucket t=2

    expect(counters.totalWithinWindow('rate_limit')).toBe(3);

    // Advance 3 more bucket widths. Now at t=5; oldest bucket (t=0) rolled out.
    clock.advance(3 * BUCKET_MS);
    expect(counters.totalWithinWindow('rate_limit')).toBe(2);
  });

  it('reset clears all reason rings', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedSecurityMetrics({
      bucketWidthMs: BUCKET_MS,
      capacity: RING_CAPACITY,
      now: clock.now,
    });

    counters.increment('homoglyph');
    counters.increment('injection');
    counters.increment('rate_limit');
    counters.reset();

    expect(counters.totalWithinWindow('homoglyph')).toBe(0);
    expect(counters.totalWithinWindow('injection')).toBe(0);
    expect(counters.totalWithinWindow('rate_limit')).toBe(0);
  });

  // ─── Snapshot export (Prometheus-friendly) ────────────────────────────

  it('snapshot export emits {reason, count_60s, count_300s} for every known reason', () => {
    // The snapshot uses a fixed bucket width of 60_000ms internally so that
    // count_60s == current bucket and count_300s == sum over 5 buckets.
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedSecurityMetrics({
      bucketWidthMs: 60_000,
      capacity: 5,
      now: clock.now,
    });

    counters.increment('homoglyph');
    counters.increment('homoglyph');
    counters.increment('injection');

    // Advance one bucket so the next event lands in a different bucket but
    // still inside the 300s window.
    clock.advance(60_000);
    counters.increment('homoglyph');

    const snapshot = counters.snapshot();

    // Snapshot covers every known reason — emitted even at zero so dashboards
    // see the full reason cardinality.
    const reasons = snapshot.map((row) => row.reason).sort();
    expect(reasons).toEqual(
      ['homoglyph', 'injection', 'oversized', 'prompt_injection', 'rate_limit'].sort(),
    );

    const homoglyphRow = snapshot.find((r) => r.reason === 'homoglyph');
    expect(homoglyphRow).toBeDefined();
    // Current bucket (t=1) has only the post-advance event.
    expect(homoglyphRow!.count_60s).toBe(1);
    // 300s window holds all 3 homoglyph events.
    expect(homoglyphRow!.count_300s).toBe(3);

    const injectionRow = snapshot.find((r) => r.reason === 'injection');
    expect(injectionRow).toBeDefined();
    expect(injectionRow!.count_60s).toBe(0);
    expect(injectionRow!.count_300s).toBe(1);

    const oversizedRow = snapshot.find((r) => r.reason === 'oversized');
    expect(oversizedRow).toBeDefined();
    expect(oversizedRow!.count_60s).toBe(0);
    expect(oversizedRow!.count_300s).toBe(0);
  });

  it('preserves the existing collector API (existing surface untouched)', async () => {
    const mod = await import(
      '../../src/infrastructure/observability/query-entry-security-metrics.js'
    );
    const collector = mod.getQueryEntrySecurityMetricsCollector();
    collector.reset();
    collector.onLayer1Blocked('homoglyph');
    collector.onLayer2Blocked('injection');
    const m = collector.getMetrics();
    expect(m.layer1Blocks).toBe(1);
    expect(m.layer2Blocks).toBe(1);
  });
});
