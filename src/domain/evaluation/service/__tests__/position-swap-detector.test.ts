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

  it('tiny preference flip (0.501 vs 0.499) → NOT inconsistent (under noise floor)', () => {
    // Mean gap = 0.002, well below POSITION_BIAS_NOISE_FLOOR (0.05).
    // Even though the two scores straddle PREFERENCE_BOUNDARY (0.5), the
    // flip is numerical drift and must not be flagged.
    const samples: JudgeSample[] = [
      { judgeId: 'j1', score: 0.501, position: 'A', itemA: 'x', itemB: 'y' },
      { judgeId: 'j1', score: 0.499, position: 'B', itemA: 'x', itemB: 'y' },
    ];
    const pairs = detectPositionSwapPairs(samples);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.inconsistent).toBe(false);
  });

  it('significant preference flip (0.7 vs 0.3) → inconsistent', () => {
    // Straddles 0.5 AND gap (0.4) exceeds POSITION_BIAS_NOISE_FLOOR.
    const samples: JudgeSample[] = [
      { judgeId: 'j1', score: 0.7, position: 'A', itemA: 'x', itemB: 'y' },
      { judgeId: 'j1', score: 0.3, position: 'B', itemA: 'x', itemB: 'y' },
    ];
    const pairs = detectPositionSwapPairs(samples);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.inconsistent).toBe(true);
  });

  it('same-side scores even when far apart (0.9 vs 0.7) → NOT inconsistent', () => {
    // Both > PREFERENCE_BOUNDARY → judge agrees on the winner at both
    // positions. Large numerical gap is irrelevant; "inconsistent" requires
    // a preference flip, not merely a magnitude difference.
    const samples: JudgeSample[] = [
      { judgeId: 'j1', score: 0.9, position: 'A', itemA: 'x', itemB: 'y' },
      { judgeId: 'j1', score: 0.7, position: 'B', itemA: 'x', itemB: 'y' },
    ];
    const pairs = detectPositionSwapPairs(samples);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.inconsistent).toBe(false);
  });
});
