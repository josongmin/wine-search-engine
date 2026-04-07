import { describe, expect, it } from 'vitest';
import { CircularLatencyBuffer } from '../circular-latency-buffer.js';

describe('CircularLatencyBuffer', () => {
  it('returns 0 average for empty buffer', () => {
    const buf = new CircularLatencyBuffer(5);
    expect(buf.average()).toBe(0);
    expect(buf.length).toBe(0);
  });

  it('computes average before reaching capacity', () => {
    const buf = new CircularLatencyBuffer(5);
    buf.push(10);
    buf.push(20);
    buf.push(30);
    expect(buf.length).toBe(3);
    expect(buf.average()).toBe(20); // (10+20+30)/3
  });

  it('computes correct average at exactly capacity', () => {
    const buf = new CircularLatencyBuffer(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.length).toBe(3);
    expect(buf.average()).toBe(2); // (1+2+3)/3
  });

  it('computes correct average after wraparound', () => {
    const buf = new CircularLatencyBuffer(3);
    buf.push(1); // [1, _, _]
    buf.push(2); // [1, 2, _]
    buf.push(3); // [1, 2, 3]
    buf.push(4); // [4, 2, 3] — overwrites slot 0
    buf.push(5); // [4, 5, 3] — overwrites slot 1
    // Buffer holds [4, 5, 3] → most recent 3 values are 3, 4, 5
    expect(buf.length).toBe(3);
    expect(buf.average()).toBe(4); // (4+5+3)/3 = 12/3 = 4
  });

  it('evicts oldest values on overflow', () => {
    const buf = new CircularLatencyBuffer(2);
    buf.push(100);
    buf.push(200);
    buf.push(300); // 100 evicted
    expect(buf.length).toBe(2);
    // Buffer holds [300, 200] → average = 250
    expect(buf.average()).toBe(250);
  });

  it('reset clears all data', () => {
    const buf = new CircularLatencyBuffer(5);
    buf.push(10);
    buf.push(20);
    buf.reset();
    expect(buf.length).toBe(0);
    expect(buf.average()).toBe(0);
  });

  it('works correctly after reset and repopulation', () => {
    const buf = new CircularLatencyBuffer(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.reset();
    buf.push(10);
    buf.push(20);
    expect(buf.length).toBe(2);
    expect(buf.average()).toBe(15);
  });
});
