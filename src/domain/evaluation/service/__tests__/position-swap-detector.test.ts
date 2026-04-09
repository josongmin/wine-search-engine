import { describe, it, expect } from 'vitest';
import { detectPositionSwapPairs } from '../position-swap-detector.js';
import type { JudgeSample } from '../judge-bias-correction.js';

describe('detectPositionSwapPairs', () => {
  it('empty samples → no pairs', () => {
    expect(detectPositionSwapPairs([])).toEqual([]);
  });

  it('consistent judge → not inconsistent', () => {
    // Same item wins at both positions: meanA and meanB on the SAME side of 0.5.
    const samples: JudgeSample[] = [
      { judgeId: 'j1', score: 0.8, position: 'A', itemA: 'x', itemB: 'y' },
      { judgeId: 'j1', score: 0.8, position: 'B', itemA: 'y', itemB: 'x' },
    ];
    const pairs = detectPositionSwapPairs(samples);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.inconsistent).toBe(false);
  });

  it('position-biased judge → inconsistent flagged', () => {
    // Judge always gives high score to whichever item is at position A.
    // A position picks 0.9 (item x wins), B position gives 0.2 (item y wins).
    const samples: JudgeSample[] = [
      { judgeId: 'j1', score: 0.9, position: 'A', itemA: 'x', itemB: 'y' },
      { judgeId: 'j1', score: 0.2, position: 'B', itemA: 'x', itemB: 'y' },
    ];
    const pairs = detectPositionSwapPairs(samples);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.inconsistent).toBe(true);
  });

  it('single sample (no swap available) → no pair', () => {
    const samples: JudgeSample[] = [
      { judgeId: 'j1', score: 0.8, position: 'A', itemA: 'x', itemB: 'y' },
    ];
    expect(detectPositionSwapPairs(samples)).toEqual([]);
  });
});
