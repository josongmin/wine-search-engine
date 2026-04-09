import { describe, it, expect } from 'vitest';
import { computeJudgeBias, correctJudgeBias, type JudgeSample } from '../judge-bias-correction.js';

describe('computeJudgeBias', () => {
  it('empty samples → empty report', () => {
    const r = computeJudgeBias([]);
    expect(r.sampleCount).toBe(0);
    expect(r.meanScore).toBe(0);
  });

  it('single judge → bias = 0', () => {
    const samples: JudgeSample[] = [
      { judgeId: 'j1', score: 0.7, itemA: 'a' },
      { judgeId: 'j1', score: 0.8, itemA: 'b' },
    ];
    const r = computeJudgeBias(samples);
    expect(r.perJudgeBias.get('j1')).toBe(0);
  });

  it('lenient judge has positive bias relative to global mean', () => {
    const samples: JudgeSample[] = [
      { judgeId: 'lenient', score: 0.9, itemA: 'a' },
      { judgeId: 'lenient', score: 0.9, itemA: 'b' },
      { judgeId: 'strict', score: 0.5, itemA: 'a' },
      { judgeId: 'strict', score: 0.5, itemA: 'b' },
    ];
    const r = computeJudgeBias(samples);
    expect(r.meanScore).toBeCloseTo(0.7, 4);
    expect(r.perJudgeBias.get('lenient')).toBeCloseTo(0.2, 4);
    expect(r.perJudgeBias.get('strict')).toBeCloseTo(-0.2, 4);
  });

  it('correctJudgeBias subtracts the bias', () => {
    const samples: JudgeSample[] = [
      { judgeId: 'lenient', score: 0.9, itemA: 'a' },
      { judgeId: 'strict', score: 0.5, itemA: 'a' },
    ];
    const report = computeJudgeBias(samples);
    const corrected = correctJudgeBias(samples, report);
    // After correction both judges should converge near the global mean.
    expect(corrected[0]!.correctedScore).toBeCloseTo(0.7, 4);
    expect(corrected[1]!.correctedScore).toBeCloseTo(0.7, 4);
  });

  it('positionBias = 0 when no positional samples', () => {
    const samples: JudgeSample[] = [
      { judgeId: 'j1', score: 0.5, itemA: 'a' },
    ];
    expect(computeJudgeBias(samples).positionBias).toBe(0);
  });

  it('non-finite scores are filtered', () => {
    const samples: JudgeSample[] = [
      { judgeId: 'j1', score: NaN, itemA: 'a' },
      { judgeId: 'j1', score: 0.5, itemA: 'a' },
    ];
    expect(computeJudgeBias(samples).sampleCount).toBe(1);
  });
});
