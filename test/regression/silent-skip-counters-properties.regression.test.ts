/**
 * Silent-skip counters — property-based regression suite (maturity 4 → 5).
 *
 * Deepens the Wave 1 time-series implementation
 * (`createTimeBucketedSilentSkipCounters` in
 * `src/domain/observability/silent-skip-counters.ts`) with fast-check property
 * exploration over the reason-keyed time-bucketed ring buffer. The Wave 1
 * example-based suite (`silent-skip-counters-time-series.regression.test.ts`)
 * locks specific scenarios; this suite locks the *universal* invariants of the
 * ring under random event streams and an injectable clock (no real timers).
 *
 * Mirrors the Cycle-6 pattern used to push retrieval-degradation-metrics to 5
 * (`retrieval-degradation-metrics-properties.regression.test.ts`). The
 * silent-skip API exposes `totalWithinWindow` / `currentBucketCount` /
 * `checkThreshold` rather than an `exportSnapshot()` row builder, so the
 * snapshot-shape properties are expressed over those query methods directly.
 *
 * Invariants explored (numRuns: 100 each):
 *   - ring count bounded: window total never exceeds events recorded in window
 *   - rollover correctness: events older than the window expire exactly (no off-by-one)
 *   - reason isolation: independent reasons never cross-contaminate counts
 *   - threshold strict-`>`: observed == threshold → NOT tripped; observed > threshold → tripped
 *   - snapshot non-negative: every count ≥ 0 and currentBucket ≤ window total
 *   - monotone within bucket: recording N events in same bucket → count exactly N
 *   - clock determinism: same event+clock sequence → same snapshot
 *
 * Append-only regression file — never delete cases. See CLAUDE.md "Test discipline".
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  createTimeBucketedSilentSkipCounters,
  type SilentSkipKind,
} from '../../src/domain/observability/silent-skip-counters.js';

const FC_RUNS = 100;

/** A representative slice of the known kinds — enough to exercise isolation. */
const KINDS: readonly SilentSkipKind[] = [
  'cache_read_failure',
  'cache_write_failure',
  'json_parse_failure',
  'embedding_empty_vector',
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

/** Arbitrary for a single known kind. */
const kindArb: fc.Arbitrary<SilentSkipKind> = fc.constantFrom(...KINDS);

/**
 * An event stream: a list of {kind, offsetMs} pairs. The clock is set to
 * `EPOCH + offsetMs` before each increment, modelling arbitrary arrival times.
 * Offsets are sorted non-decreasing within a generated stream because the
 * ring's `advanceRing` only moves forward (a real clock never rewinds).
 */
interface StreamEvent {
  readonly kind: SilentSkipKind;
  readonly offsetMs: number;
}

const streamArb: fc.Arbitrary<readonly StreamEvent[]> = fc
  .array(
    fc.record({
      kind: kindArb,
      // Offsets up to ~30 minutes so streams cross the 5-minute window many times.
      offsetMs: fc.integer({ min: 0, max: 30 * 60_000 }),
    }),
    { minLength: 0, maxLength: 200 },
  )
  .map((events) => [...events].sort((a, b) => a.offsetMs - b.offsetMs));

/** Bucket index a given offset lands in for a given bucket width. */
function bucketIndexOf(offsetMs: number, bucketWidthMs: number): number {
  return Math.floor((EPOCH + offsetMs) / bucketWidthMs);
}

describe('silent-skip time-bucketed ring — property-based', () => {
  it('property: window total is bounded by events recorded in the live window', () => {
    fc.assert(
      fc.property(
        streamArb,
        fc.integer({ min: 1, max: 10 }), // bucket minutes
        fc.integer({ min: 1, max: 8 }), // capacity
        (stream, bucketMin, capacity) => {
          const bucketWidthMs = bucketMin * 60_000;
          const windowMs = bucketWidthMs * capacity;
          const clock = mutableClock(EPOCH);
          const counters = createTimeBucketedSilentSkipCounters({
            bucketWidthMs,
            capacity,
            now: clock.now,
          });

          for (const ev of stream) {
            clock.set(EPOCH + ev.offsetMs);
            counters.increment(ev.kind);
          }

          // Evaluate the window relative to the final clock position.
          const lastOffset =
            stream.length > 0 ? stream[stream.length - 1]!.offsetMs : 0;
          clock.set(EPOCH + lastOffset);
          const finalBucket = bucketIndexOf(lastOffset, bucketWidthMs);

          for (const kind of KINDS) {
            const total = counters.totalWithinWindow(kind);

            // Bound 1: total never exceeds the number of events ever recorded
            // for that kind.
            const everRecorded = stream.filter((e) => e.kind === kind).length;
            expect(total).toBeLessThanOrEqual(everRecorded);

            // Bound 2 (tight): total equals exactly the events for that kind
            // whose bucket index is within the live window
            // [finalBucket - capacity + 1, finalBucket].
            const inWindow = stream.filter((e) => {
              if (e.kind !== kind) return false;
              const b = bucketIndexOf(e.offsetMs, bucketWidthMs);
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
          const counters = createTimeBucketedSilentSkipCounters({
            bucketWidthMs,
            capacity,
            now: clock.now,
          });

          // Record eventCount events all in the very first bucket.
          for (let i = 0; i < eventCount; i++) counters.increment('cache_read_failure');
          expect(counters.totalWithinWindow('cache_read_failure')).toBe(eventCount);

          // Advance exactly `advanceBuckets` bucket widths.
          clock.set(EPOCH + advanceBuckets * bucketWidthMs);

          // Events are still in-window iff the first bucket is within the last
          // `capacity` buckets, i.e. advanceBuckets < capacity.
          const expected = advanceBuckets < capacity ? eventCount : 0;
          expect(counters.totalWithinWindow('cache_read_failure')).toBe(expected);

          // Boundary tightness: at advanceBuckets === capacity - 1 the events
          // must still be present; at capacity they must be gone.
          if (advanceBuckets === capacity - 1) {
            expect(counters.totalWithinWindow('cache_read_failure')).toBe(eventCount);
          }
          if (advanceBuckets === capacity) {
            expect(counters.totalWithinWindow('cache_read_failure')).toBe(0);
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
        const counters = createTimeBucketedSilentSkipCounters({
          bucketWidthMs,
          capacity,
          now: clock.now,
        });

        for (const ev of stream) {
          clock.set(EPOCH + ev.offsetMs);
          counters.increment(ev.kind);
        }
        const lastOffset =
          stream.length > 0 ? stream[stream.length - 1]!.offsetMs : 0;
        clock.set(EPOCH + lastOffset);
        const finalBucket = bucketIndexOf(lastOffset, bucketWidthMs);

        // Each kind's window total is independent: it equals only its own
        // in-window events. Summing per-kind totals must equal the sum of all
        // in-window events for KINDS — no leakage across rings.
        let perKindSum = 0;
        for (const kind of KINDS) {
          perKindSum += counters.totalWithinWindow(kind);
        }
        const allInWindow = stream.filter((e) => {
          const b = bucketIndexOf(e.offsetMs, bucketWidthMs);
          return finalBucket - b < capacity && finalBucket - b >= 0;
        }).length;
        expect(perKindSum).toBe(allInWindow);
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('property: threshold uses strict > (observed == threshold not tripped, observed-1 tripped)', () => {
    fc.assert(
      fc.property(
        kindArb,
        fc.integer({ min: 0, max: 50 }), // number of events recorded
        (kind, eventCount) => {
          const clock = mutableClock(EPOCH);
          const counters = createTimeBucketedSilentSkipCounters({
            bucketWidthMs: 60_000,
            capacity: 5,
            now: clock.now,
          });
          for (let i = 0; i < eventCount; i++) counters.increment(kind);

          const observed = counters.totalWithinWindow(kind);
          expect(observed).toBe(eventCount);

          // At threshold == observed → strictly greater is false → not tripped.
          const atBoundary = counters.checkThreshold(kind, observed);
          expect(atBoundary.tripped).toBe(false);
          expect(atBoundary.observed).toBe(observed);
          expect(atBoundary.threshold).toBe(observed);

          // One below observed → tripped (observed > threshold).
          const below = counters.checkThreshold(kind, observed - 1);
          expect(below.tripped).toBe(true);

          // One above observed → never tripped.
          const above = counters.checkThreshold(kind, observed + 1);
          expect(above.tripped).toBe(false);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  it('property: window/current counts are always non-negative integers, current ≤ window', () => {
    fc.assert(
      fc.property(streamArb, (stream) => {
        const clock = mutableClock(EPOCH);
        const counters = createTimeBucketedSilentSkipCounters({
          bucketWidthMs: 60_000,
          capacity: 5,
          now: clock.now,
        });
        for (const ev of stream) {
          clock.set(EPOCH + ev.offsetMs);
          counters.increment(ev.kind);
        }

        for (const kind of KINDS) {
          const total = counters.totalWithinWindow(kind);
          const current = counters.currentBucketCount(kind);
          expect(total).toBeGreaterThanOrEqual(0);
          expect(current).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(total)).toBe(true);
          expect(Number.isInteger(current)).toBe(true);
          // The current bucket count can never exceed the window total.
          expect(current).toBeLessThanOrEqual(total);
        }
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('property: N events in the same bucket yield a count of exactly N', () => {
    fc.assert(
      fc.property(kindArb, fc.integer({ min: 0, max: 100 }), (kind, n) => {
        const clock = mutableClock(EPOCH);
        const counters = createTimeBucketedSilentSkipCounters({
          bucketWidthMs: 60_000,
          capacity: 5,
          now: clock.now,
        });
        // All N increments happen at the same clock value → same bucket.
        for (let i = 0; i < n; i++) counters.increment(kind);

        expect(counters.currentBucketCount(kind)).toBe(n);
        expect(counters.totalWithinWindow(kind)).toBe(n);
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

          const run = (): ReadonlyArray<readonly [SilentSkipKind, number, number]> => {
            const clock = mutableClock(EPOCH);
            const counters = createTimeBucketedSilentSkipCounters({
              bucketWidthMs,
              capacity,
              now: clock.now,
            });
            for (const ev of stream) {
              clock.set(EPOCH + ev.offsetMs);
              counters.increment(ev.kind);
            }
            const lastOffset =
              stream.length > 0 ? stream[stream.length - 1]!.offsetMs : 0;
            clock.set(EPOCH + lastOffset);
            // Snapshot = (kind, windowTotal, currentBucket) per known kind.
            return KINDS.map(
              (kind) =>
                [
                  kind,
                  counters.totalWithinWindow(kind),
                  counters.currentBucketCount(kind),
                ] as const,
            );
          };

          // Two independent runs over identical inputs must agree exactly.
          expect(run()).toEqual(run());
        },
      ),
      { numRuns: FC_RUNS },
    );
  });
});

describe('silent-skip time-bucketed ring — specific edge cases', () => {
  it('empty ring → all counts zero, verdict not tripped', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedSilentSkipCounters({
      bucketWidthMs: 60_000,
      capacity: 5,
      now: clock.now,
    });
    for (const kind of KINDS) {
      expect(counters.totalWithinWindow(kind)).toBe(0);
      expect(counters.currentBucketCount(kind)).toBe(0);
      const verdict = counters.checkThreshold(kind, 0);
      expect(verdict.tripped).toBe(false);
      expect(verdict.observed).toBe(0);
    }
  });

  it('event exactly at a bucket boundary lands in the new bucket', () => {
    const bucketWidthMs = 60_000;
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedSilentSkipCounters({
      bucketWidthMs,
      capacity: 5,
      now: clock.now,
    });

    counters.increment('cache_read_failure'); // bucket k
    expect(counters.currentBucketCount('cache_read_failure')).toBe(1);

    // Advance to the exact boundary of the next bucket.
    clock.set(EPOCH + bucketWidthMs);
    counters.increment('cache_read_failure'); // bucket k+1

    // Current bucket holds only the new event; window still holds both.
    expect(counters.currentBucketCount('cache_read_failure')).toBe(1);
    expect(counters.totalWithinWindow('cache_read_failure')).toBe(2);
  });

  it('unknown reason → graceful no-throw, zero counts, non-tripped verdict', () => {
    const clock = mutableClock(EPOCH);
    const counters = createTimeBucketedSilentSkipCounters({
      bucketWidthMs: 60_000,
      capacity: 5,
      now: clock.now,
    });
    const bogus = 'totally_unknown' as unknown as SilentSkipKind;

    expect(() => counters.increment(bogus)).not.toThrow();
    expect(() => counters.totalWithinWindow(bogus)).not.toThrow();
    expect(counters.totalWithinWindow(bogus)).toBe(0);
    expect(counters.currentBucketCount(bogus)).toBe(0);

    const verdict = counters.checkThreshold(bogus, 0);
    expect(verdict.tripped).toBe(false);
    expect(verdict.observed).toBe(0);
  });
});
