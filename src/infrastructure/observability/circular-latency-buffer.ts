/** Median latency percentile (typical case). */
export const LATENCY_PERCENTILE_P50 = 0.5;
/** Tail latency percentile (SLO-style). */
export const LATENCY_PERCENTILE_P95 = 0.95;
/** Extreme tail latency percentile (worst-case monitoring). */
export const LATENCY_PERCENTILE_P99 = 0.99;

/** Documented default returned by percentile() / pXX() when no samples exist. */
const EMPTY_PERCENTILE_DEFAULT = 0;

/**
 * Fixed-size circular buffer for latency samples.
 *
 * O(1) push, O(n log n) percentile / O(n) average (only computed on snapshot).
 * Replaces the `number[] + shift()` pattern which is O(n) per push.
 *
 * Percentiles use the nearest-rank order-statistic convention
 * (index = ceil(n * p) - 1, clamped to [0, n-1]), matching the eval-layer
 * `slice-evaluator` percentile so offline and runtime tail metrics agree.
 */
export class CircularLatencyBuffer {
  private readonly buffer: Float64Array;
  private head = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`CircularLatencyBuffer capacity must be a positive integer, got ${String(capacity)}`);
    }
    this.buffer = new Float64Array(capacity);
  }

  push(value: number): void {
    this.buffer[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /**
   * Average of all stored samples.
   * After wraparound every slot in 0..capacity-1 holds a valid sample
   * (the N most recent values in arbitrary ring order), so summing
   * 0..count-1 is correct regardless of head position.
   */
  average(): number {
    if (this.count === 0) return 0;
    let sum = 0;
    for (let i = 0; i < this.count; i++) {
      sum += this.buffer[i]!;
    }
    return sum / this.count;
  }

  /**
   * Nearest-rank percentile of the retained window.
   *
   * `p` is a fraction in [0, 1]. Returns {@link EMPTY_PERCENTILE_DEFAULT} when
   * empty. Copies and sorts the live samples (the buffer holds the N most
   * recent values in arbitrary ring order), then takes order statistic
   * `ceil(n * p) - 1` clamped into range.
   */
  percentile(p: number): number {
    if (!Number.isFinite(p) || p < 0 || p > 1) {
      throw new Error(`CircularLatencyBuffer percentile p must be in [0, 1], got ${String(p)}`);
    }
    if (this.count === 0) return EMPTY_PERCENTILE_DEFAULT;
    const sorted = this.buffer.slice(0, this.count);
    sorted.sort();
    const index = Math.ceil(this.count * p) - 1;
    const clamped = Math.max(0, Math.min(index, this.count - 1));
    return sorted[clamped]!;
  }

  /** p50 (median) latency of the retained window. */
  p50(): number {
    return this.percentile(LATENCY_PERCENTILE_P50);
  }

  /** p95 (tail) latency of the retained window. */
  p95(): number {
    return this.percentile(LATENCY_PERCENTILE_P95);
  }

  /** p99 (extreme tail) latency of the retained window. */
  p99(): number {
    return this.percentile(LATENCY_PERCENTILE_P99);
  }

  get length(): number {
    return this.count;
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
    this.buffer.fill(0);
  }
}
