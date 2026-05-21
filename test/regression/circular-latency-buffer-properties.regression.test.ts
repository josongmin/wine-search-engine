import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CircularLatencyBuffer } from '../../src/infrastructure/observability/circular-latency-buffer.js';

/**
 * Property-based invariants for the circular latency buffer's percentile
 * computation (p50/p95/p99). Percentiles use the nearest-rank order-statistic
 * convention: index = ceil(n * p) - 1, clamped to [0, n-1].
 *
 * These properties lock the ring-buffer capacity bound and percentile
 * correctness so regressions (off-by-one, NaN, eviction bugs) are caught.
 */

const FC_RUNS = { numRuns: 100 } as const;

/** Finite, non-NaN latency samples (allow zero and negatives to probe guards). */
const latencyArb = fc.double({ min: -1_000, max: 1_000_000, noNaN: true, noDefaultInfinity: true });
const capacityArb = fc.integer({ min: 1, max: 512 });

function fill(buf: CircularLatencyBuffer, samples: readonly number[]): void {
  for (const s of samples) buf.push(s);
}

describe('CircularLatencyBuffer percentile properties', () => {
  it('capacity bound: length never exceeds capacity for any N pushes', () => {
    fc.assert(
      fc.property(capacityArb, fc.array(latencyArb, { maxLength: 2000 }), (capacity, samples) => {
        const buf = new CircularLatencyBuffer(capacity);
        fill(buf, samples);
        expect(buf.length).toBeLessThanOrEqual(capacity);
        expect(buf.length).toBe(Math.min(samples.length, capacity));
      }),
      FC_RUNS,
    );
  });

  it('percentile ordering: p50 <= p95 <= p99 (monotone) for any sample', () => {
    fc.assert(
      fc.property(capacityArb, fc.array(latencyArb, { minLength: 1, maxLength: 1000 }), (capacity, samples) => {
        const buf = new CircularLatencyBuffer(capacity);
        fill(buf, samples);
        const p50 = buf.percentile(0.5);
        const p95 = buf.percentile(0.95);
        const p99 = buf.percentile(0.99);
        expect(Number.isFinite(p50)).toBe(true);
        expect(Number.isFinite(p95)).toBe(true);
        expect(Number.isFinite(p99)).toBe(true);
        expect(p50).toBeLessThanOrEqual(p95);
        expect(p95).toBeLessThanOrEqual(p99);
      }),
      FC_RUNS,
    );
  });

  it('percentile bounds: every percentile is within [min, max] of retained samples', () => {
    fc.assert(
      fc.property(
        capacityArb,
        fc.array(latencyArb, { minLength: 1, maxLength: 1000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (capacity, samples, p) => {
          const buf = new CircularLatencyBuffer(capacity);
          fill(buf, samples);
          // Retained window = the last `capacity` pushed samples.
          const retained = samples.slice(Math.max(0, samples.length - capacity));
          let min = retained[0]!;
          let max = retained[0]!;
          for (const v of retained) {
            if (v < min) min = v;
            if (v > max) max = v;
          }
          const value = buf.percentile(p);
          expect(value).toBeGreaterThanOrEqual(min);
          expect(value).toBeLessThanOrEqual(max);
        },
      ),
      FC_RUNS,
    );
  });

  it('single sample: buffer with one value returns that value for all percentiles', () => {
    fc.assert(
      fc.property(capacityArb, latencyArb, (capacity, sample) => {
        const buf = new CircularLatencyBuffer(capacity);
        buf.push(sample);
        expect(buf.percentile(0.5)).toBe(sample);
        expect(buf.percentile(0.95)).toBe(sample);
        expect(buf.percentile(0.99)).toBe(sample);
        expect(buf.percentile(0)).toBe(sample);
        expect(buf.percentile(1)).toBe(sample);
      }),
      FC_RUNS,
    );
  });

  it('ring overwrite: pushing > capacity evicts oldest; percentile reflects recent window', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 64 }),
        fc.array(latencyArb, { minLength: 1, maxLength: 500 }),
        (capacity, samples) => {
          const buf = new CircularLatencyBuffer(capacity);
          fill(buf, samples);
          const retained = samples.slice(Math.max(0, samples.length - capacity)).slice().sort((a, b) => a - b);
          // Nearest-rank reference percentile over the retained window.
          const ref = (p: number): number => {
            const idx = Math.ceil(retained.length * p) - 1;
            return retained[Math.max(0, Math.min(idx, retained.length - 1))]!;
          };
          expect(buf.percentile(0.5)).toBe(ref(0.5));
          expect(buf.percentile(0.95)).toBe(ref(0.95));
          expect(buf.percentile(0.99)).toBe(ref(0.99));
        },
      ),
      FC_RUNS,
    );
  });

  it('empty buffer: percentiles return 0 default with no throw / NaN', () => {
    fc.assert(
      fc.property(capacityArb, fc.double({ min: 0, max: 1, noNaN: true }), (capacity, p) => {
        const buf = new CircularLatencyBuffer(capacity);
        const value = buf.percentile(p);
        expect(value).toBe(0);
        expect(Number.isNaN(value)).toBe(false);
      }),
      FC_RUNS,
    );
  });

  it('determinism: same sample sequence yields identical percentiles', () => {
    fc.assert(
      fc.property(capacityArb, fc.array(latencyArb, { minLength: 1, maxLength: 1000 }), (capacity, samples) => {
        const a = new CircularLatencyBuffer(capacity);
        const b = new CircularLatencyBuffer(capacity);
        fill(a, samples);
        fill(b, samples);
        for (const p of [0, 0.5, 0.95, 0.99, 1]) {
          expect(a.percentile(p)).toBe(b.percentile(p));
        }
      }),
      FC_RUNS,
    );
  });

  it('rejects out-of-range percentile p', () => {
    const buf = new CircularLatencyBuffer(4);
    buf.push(10);
    expect(() => buf.percentile(-0.01)).toThrow();
    expect(() => buf.percentile(1.01)).toThrow();
    expect(() => buf.percentile(Number.NaN)).toThrow();
  });
});

describe('CircularLatencyBuffer percentile known-distribution correctness', () => {
  it('[1..100] nearest-rank: p50=50, p95=95, p99=99, p100=100, p0=1', () => {
    const buf = new CircularLatencyBuffer(100);
    for (let i = 1; i <= 100; i++) buf.push(i);
    expect(buf.percentile(0.5)).toBe(50);
    expect(buf.percentile(0.95)).toBe(95);
    expect(buf.percentile(0.99)).toBe(99);
    expect(buf.percentile(1)).toBe(100);
    expect(buf.percentile(0)).toBe(1);
  });

  it('handles negative and zero latencies without NaN', () => {
    const buf = new CircularLatencyBuffer(5);
    buf.push(-10);
    buf.push(0);
    buf.push(5);
    expect(buf.percentile(0.5)).toBe(0);
    expect(buf.percentile(0.99)).toBe(5);
    expect(Number.isNaN(buf.percentile(0))).toBe(false);
    expect(buf.percentile(0)).toBe(-10);
  });

  it('exposes p50/p95/p99 convenience accessors consistent with percentile()', () => {
    const buf = new CircularLatencyBuffer(100);
    for (let i = 1; i <= 100; i++) buf.push(i);
    expect(buf.p50()).toBe(buf.percentile(0.5));
    expect(buf.p95()).toBe(buf.percentile(0.95));
    expect(buf.p99()).toBe(buf.percentile(0.99));
    expect(buf.p50()).toBe(50);
    expect(buf.p95()).toBe(95);
    expect(buf.p99()).toBe(99);
  });
});
