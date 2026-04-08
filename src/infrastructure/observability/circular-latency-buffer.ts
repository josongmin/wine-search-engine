/**
 * Fixed-size circular buffer for latency samples.
 *
 * O(1) push, O(n) average (only computed on snapshot).
 * Replaces the `number[] + shift()` pattern which is O(n) per push.
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

  get length(): number {
    return this.count;
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
    this.buffer.fill(0);
  }
}
