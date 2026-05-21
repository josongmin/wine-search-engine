/**
 * Query-entry security metrics — property-based regression suite (maturity 4 → 5).
 *
 * Deepens the Wave 5 time-series implementation
 * (`src/infrastructure/observability/query-entry-security-metrics.ts`) with
 * fast-check property exploration over the reason-keyed time-bucketed ring
 * buffer. The Wave 5 example-based suite
 * (`security-metrics-time-series.regression.test.ts`) locks specific scenarios;
 * this suite locks the *universal* invariants of the ring under random event
 * streams and an injectable clock (no real timers).
 *
 * Mirrors `retrieval-degradation-metrics-properties.regression.test.ts`
 * (already maturity 5) so a single mental model covers both observability
 * ring-buffer surfaces.
 *
 * Invariants explored (numRuns: 100 each):
 *   - ring count bounded: window total never exceeds events recorded in window
 *   - rollover correctness: events older than the window expire exactly (no off-by-one)
 *   - reason isolation: independent reasons never cross-contaminate counts
 *   - threshold strict-`>`: observed == threshold → NOT tripped; observed > threshold → tripped
 *   - snapshot non-negative: every count_60s / count_300s ≥ 0
 *   - monotone within bucket: recording N events in same bucket → count exactly N
 *   - clock determinism: same event+clock sequence → same snapshot
 *
 * Append-only regression file — never delete cases. See CLAUDE.md "Test discipline".
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  createTimeBucketedSecurityMetrics,
  type SecurityBlockReason,
  type SecurityMetricsSnapshotRow,
} from '../../src/infrastructure/observability/query-entry-security-metrics.js';

const FC_RUNS = 100;

const REASONS: readonly SecurityBlockReason[] = [
  'homoglyph',
  'injection',
  'rate_limit',
  'oversized',
  'prompt_injection',
];

const EPOCH = 1_700_000_000_000; // arbitrary fixed clock origin

/**
 * Controllable clock starting at `start` ms. `set(ms)` jumps the clock to an
 * exact value; `now()` returns the current value. No real time is consumed.
 */
function mutableClock(start: number): { now: () => number; set: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    set: (ms) => {
      t = ms;
    },
  };
}

/** Arbitrary for a single known reason. */
const reasonArb: fc.Arbitrary<SecurityBlockReason> = fc.constantFrom(...REASONS);

/**
 * An event stream: a list of {reason, timeOffsetMs} pairs. The clock is set to
 * `EPOCH + timeOffsetMs` before each increment, modelling arbitrary arrival
 * times. Offsets are monotone non-decreasing within a generated stream because
 * the ring's `advanceRing` only moves forward (a real clock never rewinds); we
 * enforce this by sorting the generated offsets.
 */
interface StreamEvent {
  readonly reason: SecurityBlockReason;
  readonly offsetMs: number;
}

const streamArb: fc.Arbitrary<readonly StreamEvent[]> = fc
  .array(
    fc.record({
      reason: reasonArb,
      // Offsets up to ~30 minutes so streams cross the 5-minute window many times.
      offsetMs: fc.integer({ min: 0, max: 30 * 60_000 }),
    }),
    { minLength: 0, maxLength: 200 },
  )
  .map((events) => [...events].sort((a, b) => a.offsetMs - b.offsetMs));

describe('query-entry security time-bucketed ring — property-based', () => {
  it('property: window total is bounded by events recorded in the live window', () => {
    fc.assert(
      fc.property(
        streamArb,
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 8 }),
        (stream, bucketMin, capacity) => {
          const bucketWidthMs = bucketMin * 60_000;
          const windowMs = bucketWidthMs * capacity;
          const clock = mutableClock(EPOCH);
          const counters = createTimeBucketedSecurityMetrics({
            bucketWidthMs,
            capacity,
            now: clock.now,
          });

          for (const ev of stream) {
            clock.set(EPOCH + ev.offsetMs);
            counters.increment(ev.reason);
          }

          // Evaluate the window relative to the final clock position.
          const lastOffset = stream.length > 0 ? stream[stream.length - 1]!.offsetMs : 0;
          clock.set(EPOCH + lastOffset);
          const finalBucket = Math.floor((EPOCH + lastOffset) / bucketWidthMs);

          for (const reason of REASONS) {
            const total = counters.totalWithinWindow(reason);
            // Bound 1: total never exceeds the number of events ever recorded
            // for that reason.
            const everRecorded = stream.filter((e) => e.reason === reason).length;
            expect(total).toBeLessThanOrEqual(everRecorded);

            // Bound 2 (tight): total equals exactly the events for that reason
            // whose bucket index is within the live window
            // [finalBucket - capacity + 1, finalBucket].
            const inWindow = stream.filter((e) => {
              if (e.reason !== reason) return false;
              const b = Math.floor((EPOCH + e.offsetMs) / bucketWidthMs);
              return finalBucket - b < capacity && finalBucket - b >= 0;
            }).length;
            expect(total).toBe(inWindow);
            expect(windowMs).toBeGreaterThan(0); // sanity on derived window
          }
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  it('property: rollover expires events older than the window exactly (no off-by-one)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }), // bucket minutes
        fc.integer({ min: 1, max: 6 }), // capacity
        fc.integer({ min: 1, max: 20 }), // events in the first bucket
        fc.integer({ min: 0, max: 12 }), // buckets to advance afterwards
        (bucketMin, capacity, eventCount, advanceBuckets) => {
          const bucketWidthMs = bucketMin * 60_000;
          const clock = mutableClock(EPOCH);
          const counters = createTimeBucketedSecurityMetrics({
            bucketWidthMs,
            capacity,
            now: clock.now,
          });

          // Record eventCount events all in the very first bucket.
          for (let i = 0; i < eventCount; i++) counters.increment('homoglyph');
          expect(counters.totalWithinWindow('homoglyph')).toBe(eventCount);

          // Advance exactly `advanceBuckets` bucket widths.
          clock.set(EPOCH + advanceBuckets * bucketWidthMs);

          // Events are still in-window iff the first bucket is within the last
          // `capacity` buckets, i.e. advanceBuckets < capacity.
          const expected = advanceBuckets < capacity ? eventCount : 0;
          expect(counters.totalWithinWindow('homoglyph')).toBe(expected);

          // Boundary tightness: at advanceBuckets === capacity - 1 the events
          // must still be present; at capacity they must be gone.
          if (advanceBuckets === capacity - 1) {
            expect(counters.totalWithinWindow('homoglyph')).toBe(eventCount);
          }
          if (advanceBuckets === capacity) {
            expect(counters.totalWithinWindow('homoglyph')).toBe(0);
          }
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  it('property: independent reasons never cross-contaminate counts', () => {
    fc.assert(
      fc.property(streamArb, (stream) => {
        const bucketWidthMs = 60_000;
        const capacity = 5;
        const clock = mutableClock(EPOCH);
        const counters = createTimeBucketedSecurityMetrics({
          bucketWidthMs,
          capacity,
          now: clock.now,
        });

        for (const ev of stream) {
          clock.set(EPOCH + ev.offsetMs);
          counters.increment(ev.reason);
        }
        const lastOffset = stream.length > 0 ? stream[stream.length - 1]!.offsetMs : 0;
        clock.set(EPOCH + lastOffset);
        const finalBucket = Math.floor((EPOCH + lastOffset) / bucketWidthMs);

        // Each reason's window total is independent: it equals only its own
        // in-window events. Summing per-reason totals must equal the sum of all
        // in-window events — no leakage across rings.
        let perReasonSum = 0;
        for (const reason of REASONS) {
          perReasonSum += counters.totalWithinWindow(reason);
        }
        const allInWindow = stream.filter((e) => {
          const b = Math.floor((EPOCH + e.offsetMs) / bucketWidthMs);
          return finalBucket - b < capacity && finalBucket - b >= 0;
        }).length;
        expect(perReasonSum).toBe(allInWindow);
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('property: threshold uses strict > (observed == threshold not tripped, observed-1 tripped)', () => {
    fc.assert(
      fc.property(
        reasonArb,
        fc.integer({ min: 0, max: 50 }), // number of events recorded
        (reason, eventCount) => {
          const clock = mutableClock(EPOCH);
          const counters = createTimeBucketedSecurityMetrics({
            bucketWidthMs: 60_000,
            capacity: 5,
            now: clock.now,
          });
          for (let i = 0; i < eventCount; i++) counters.increment(reason);

          const observed = counters.totalWithinWindow(reason);
          expect(observed).toBe(eventCount);

          // At threshold == observed → strictly greater is false → not tripped.
          const atBoundary = counters.checkThreshold(reason, observed);
          expect(atBoundary.tripped).toBe(false);
          expect(atBoundary.observed).toBe(observed);
          expect(atBoundary.threshold).toBe(observed);
          expect(atBoundary.kind).toBe(reason);

          // One below observed → tripped (observed > threshold).
          const below = counters.checkThreshold(reason, observed - 1);
          expect(below.tripped).toBe(true);

          // One above observed → never tripped.
          const above = counters.checkThreshold(reason, observed + 1);
          expect(above.tripped).toBe(false);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  it('property: snapshot rows are always non-negative and well-formed', () => {
    fc.assert(
      fc.property(streamArb, (stream) => {
        const clock = mutableClock(EPOCH);
        const counters = createTimeBucketedSecurityMetrics({
          bucketWidthMs: 60_000,
          capacity: 5,
          now: clock.now,
        });
        for (const ev of stream) {
          clock.set(EPOCH + ev.offsetMs);
          counters.increment(ev.reason);
        }
        const rows: readonly SecurityMetricsSnapshotRow[] = counters.snapshot();

        // Exactly one row per known reason.
        expect(rows.map((r) => r.reason).sort()).toEqual([...REASONS].sort());

        for (const row of rows) {
          expect(row.count_60s).toBeGreaterThanOrEqual(0);
          expect(row.count_300s).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(row.count_60s)).toBe(true);
          expect(Number.isInteger(row.count_300s)).toBe(true);
          // The current bucket count can never exceed the window total.
          expect(row.count_60s).toBeLessThanOrEqual(row.count_300s);
        }
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('property: N events in the same bucket yield a count of exactly N', () => {
    fc.assert(
      fc.property(reasonArb, fc.integer({ min: 0, max: 100 }), (reason, n) => {
        const clock = mutableClock(EPOCH);
        const counters = createTimeBucketedSecurityMetrics({
          bucketWidthMs: 60_000,
          capacity: 5,
          now: clock.now,
        });
        // All N increments happen at the same clock value → same bucket.
        for (let i = 0; i < n; i++) counters.increment(reason);

        expect(counters.currentBucketCount(reason)).toBe(n);
        expect(counters.totalWithinWindow(reason)).toBe(n);
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('property: same event+clock sequence yields an identical snapshot (determinism)', () => {
    fc.assert(
      fc.property(
        streamArb,
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 6 }),
        (stream, bucketMin, capacity) => {
          const bucketWidthMs = bucketMin * 60_000;

          const run = (): readonly SecurityMetricsSnapshotRow[] => {
            const clock = mutableClock(EPOCH);
            const counters = createTimeBucketedSecurityMetrics({
              bucketWidthMs,
              capacity,
              now: clock.now,
            });
            for (const ev of stream) {
              clock.set(EPOCH + ev.offsetMs);
              counters.increment(ev.reason);
            }
            const lastOffset = stream.length > 0 ? stream[stream.length - 1]!.offsetMs : 0;
            clock.set(EPOCH + lastOffset);
            return counters.snapshot();
          };

          // Two independent runs over identical inputs must agree exactly.
          expect(run()).toEqual(run());
        },
      ),
      { numRuns: FC_RUNS },
    );
  });
});

describe('query-entry security time-bucketed ring — specific edge cases', () => {
  it('empty ring → all snapshot counts zero', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedSecurityMetrics({
      bucketWidthMs: 60_000,
      capacity: 5,
      now: clock.now,
    });
    for (const row of counters.snapshot()) {
      expect(row.count_60s).toBe(0);
      expect(row.count_300s).toBe(0);
    }
    for (const reason of REASONS) {
      expect(counters.totalWithinWindow(reason)).toBe(0);
      expect(counters.currentBucketCount(reason)).toBe(0);
    }
  });

  it('event exactly at a bucket boundary lands in the new bucket', () => {
    const bucketWidthMs = 60_000;
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedSecurityMetrics({
      bucketWidthMs,
      capacity: 5,
      now: clock.now,
    });

    counters.increment('injection'); // bucket k
    expect(counters.currentBucketCount('injection')).toBe(1);

    // Advance to the exact boundary of the next bucket.
    clock.set(EPOCH + bucketWidthMs);
    counters.increment('injection'); // bucket k+1

    // Current bucket holds only the new event; window still holds both.
    expect(counters.currentBucketCount('injection')).toBe(1);
    expect(counters.totalWithinWindow('injection')).toBe(2);
  });

  it('unknown reason → graceful no-throw, zero counts, non-tripped verdict', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedSecurityMetrics({
      bucketWidthMs: 60_000,
      capacity: 5,
      now: clock.now,
    });
    const bogus = 'totally_unknown' as unknown as SecurityBlockReason;

    expect(() => counters.increment(bogus)).not.toThrow();
    expect(() => counters.totalWithinWindow(bogus)).not.toThrow();
    expect(counters.totalWithinWindow(bogus)).toBe(0);
    expect(counters.currentBucketCount(bogus)).toBe(0);

    const verdict = counters.checkThreshold(bogus, 0);
    expect(verdict.tripped).toBe(false);
    expect(verdict.observed).toBe(0);

    // Unknown reason does not appear in the snapshot (only known reasons emit rows).
    expect(counters.snapshot().some((r) => r.reason === bogus)).toBe(false);
  });
});
