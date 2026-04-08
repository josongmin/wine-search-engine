import { describe, it, expect } from 'vitest';
import { formatBenchmarkDurationMs } from '../../../../test/benchmark/agent/benchmark-duration-format.js';

describe('formatBenchmarkDurationMs', () => {
  it('returns 0ms for non-finite or negative input', () => {
    expect(formatBenchmarkDurationMs(Number.NaN)).toBe('0ms');
    expect(formatBenchmarkDurationMs(Number.POSITIVE_INFINITY)).toBe('0ms');
    expect(formatBenchmarkDurationMs(-1)).toBe('0ms');
  });

  it('uses integer ms below 1s', () => {
    expect(formatBenchmarkDurationMs(0)).toBe('0ms');
    expect(formatBenchmarkDurationMs(500)).toBe('500ms');
    expect(formatBenchmarkDurationMs(999)).toBe('999ms');
  });

  it('uses seconds with one decimal from 1s to just under 60s', () => {
    expect(formatBenchmarkDurationMs(1_000)).toBe('1.0s');
    expect(formatBenchmarkDurationMs(1_500)).toBe('1.5s');
    expect(formatBenchmarkDurationMs(59_999)).toBe('60.0s');
  });

  it('uses minutes + whole seconds at 60s and above', () => {
    expect(formatBenchmarkDurationMs(60_000)).toBe('1m 0s');
    expect(formatBenchmarkDurationMs(90_000)).toBe('1m 30s');
    expect(formatBenchmarkDurationMs(125_000)).toBe('2m 5s');
  });
});
