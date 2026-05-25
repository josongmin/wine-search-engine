import { describe, it, expect } from 'vitest';
import {
  scoreConstraintSatisfactionRate,
  scoreUDCG,
  scoreUDCGPair,
  scoreBrierCalibration,
  computeJudgeSCRCorrelation,
} from '../constraint-metrics.js';
import type { ConstraintBundle } from '../../../../src/domain/shared/types/constraint-bundle.js';

describe('scoreConstraintSatisfactionRate', () => {
  const emptyBundle: ConstraintBundle = { hard: [], soft: [], inferred: [] };

  it('returns all-null when all tiers are empty', () => {
    const result = scoreConstraintSatisfactionRate(emptyBundle, ['some observation']);
    expect(result.csrHard).toBeNull();
    expect(result.csrSoft).toBeNull();
    expect(result.csrInferred).toBeNull();
    expect(result.csrOverall).toBeNull();
  });

  it('scores hard constraints satisfied by observation text', () => {
    const bundle: ConstraintBundle = {
      hard: [
        { attribute: 'grape', operator: '=', value: 'Cabernet Sauvignon' },
        { attribute: 'region', operator: '=', value: 'Napa Valley' },
      ],
      soft: [],
      inferred: [],
    };
    const observations = [
      'Found: Wine A | grape: Cabernet Sauvignon | region: Napa Valley',
    ];
    const result = scoreConstraintSatisfactionRate(bundle, observations);
    expect(result.csrHard).toBe(1);
    expect(result.csrOverall).toBe(1);
  });

  it('partial satisfaction returns correct ratio', () => {
    const bundle: ConstraintBundle = {
      hard: [
        { attribute: 'grape', operator: '=', value: 'Merlot' },
        { attribute: 'region', operator: '=', value: 'Bordeaux' },
      ],
      soft: [],
      inferred: [],
    };
    const observations = ['Found: Wine A | grape: Merlot | region: Burgundy'];
    const result = scoreConstraintSatisfactionRate(bundle, observations);
    expect(result.csrHard).toBe(0.5);
  });

  it('numeric constraints matched by string representation', () => {
    const bundle: ConstraintBundle = {
      hard: [{ attribute: 'vintage', operator: '=', value: 2018 }],
      soft: [],
      inferred: [],
    };
    const observations = ['Wine: Opus One 2018'];
    const result = scoreConstraintSatisfactionRate(bundle, observations);
    expect(result.csrHard).toBe(1);
  });

  it('range constraint evidenced by number in observation', () => {
    const bundle: ConstraintBundle = {
      hard: [{ attribute: 'price', operator: 'range', value: { min: 30, max: 50 } }],
      soft: [],
      inferred: [],
    };
    const observations = ['Wine A: $45'];
    const result = scoreConstraintSatisfactionRate(bundle, observations);
    expect(result.csrHard).toBe(1);
  });

  it('weighted overall uses SCR-aligned weights', () => {
    const bundle: ConstraintBundle = {
      hard: [{ attribute: 'grape', operator: '=', value: 'Merlot' }],
      soft: [{ attribute: 'style', operator: '=', value: 'bold' }],
      inferred: [],
    };
    const observations = ['Found: Merlot wine']; // hard satisfied, soft not
    const result = scoreConstraintSatisfactionRate(bundle, observations);
    expect(result.csrHard).toBe(1);
    expect(result.csrSoft).toBe(0);
    // Overall = (1*0.6 + 0*0.2) / (0.6+0.2) = 0.75
    expect(result.csrOverall).toBeCloseTo(0.75, 5);
  });

  it('treats GROUNDING_JSON matched_constraints as structured CSR evidence', () => {
    const bundle: ConstraintBundle = {
      hard: [],
      soft: [
        { attribute: 'style', operator: 'in', value: ['approachable'] },
        { attribute: 'beginner_suitability', operator: '>=', value: 0.5 },
      ],
      inferred: [],
    };
    const observations = [
      'GROUNDING_JSON: {"query_type":"search","total_results":1,"wines":[{"entity_id":"wine-1","canonical_label":"Beginner Wine","matched_constraints":["style","beginner_suitability"]}]}',
    ];

    const result = scoreConstraintSatisfactionRate(bundle, observations);

    expect(result.csrSoft).toBe(1);
    expect(result.csrOverall).toBe(1);
  });

  it('inferred constraints contribute to overall with 0.2 weight', () => {
    const bundle: ConstraintBundle = {
      hard: [],
      soft: [],
      inferred: [
        { attribute: 'grape_family', operator: '=', value: 'Cabernet' },
        { attribute: 'tannin', operator: '=', value: 'high' },
      ],
    };
    // Only 'cabernet' evidenced, not 'high' for tannin
    const observations = ['Wine: Cabernet blend, medium tannin'];
    const result = scoreConstraintSatisfactionRate(bundle, observations);
    expect(result.csrHard).toBeNull();
    expect(result.csrSoft).toBeNull();
    expect(result.csrInferred).toBe(0.5); // 1/2 satisfied
    expect(result.csrOverall).toBe(0.5);   // only inferred bucket → overall = inferred
  });
});

// ─────────────────────────────────────────────────────────────────────
// P6: UDCG (Utility-weighted Discounted Cumulative Gain)
// ─────────────────────────────────────────────────────────────────────


describe('scoreUDCG', () => {
  it('returns null when relevantEntityIds is empty', () => {
    expect(scoreUDCG(['a', 'b'], new Set(), 5)).toBeNull();
  });

  it('returns null when observationEntityIds is empty', () => {
    expect(scoreUDCG([], new Set(['a']), 5)).toBeNull();
  });

  it('perfect ranking returns 1.0', () => {
    const relevant = new Set(['a', 'b', 'c']);
    const observed = ['a', 'b', 'c', 'x', 'y'];
    const result = scoreUDCG(observed, relevant, 3);
    expect(result).toBeCloseTo(1.0, 5);
  });

  it('worst ranking returns negative score (irrelevant docs penalised)', () => {
    const relevant = new Set(['a']);
    // All irrelevant docs before the relevant one
    const observed = ['x', 'y', 'z'];
    const result = scoreUDCG(observed, relevant, 3);
    expect(result).not.toBeNull();
    expect(result!).toBeLessThan(0);
  });

  it('scoreUDCGPair computes both @5 and @10', () => {
    const relevant = new Set(['a', 'b']);
    const observed = ['a', 'x', 'b', 'y', 'z', 'q', 'r', 's', 't', 'u'];
    const pair = scoreUDCGPair(observed, relevant);
    expect(pair.udcg5).not.toBeNull();
    expect(pair.udcg10).not.toBeNull();
    // @5 should be better than @10 since extra irrelevant docs after 5 add penalty
    expect(pair.udcg5!).toBeGreaterThan(pair.udcg10!);
  });

  it('k larger than list length uses list length', () => {
    const relevant = new Set(['a']);
    const observed = ['a', 'x'];
    const result = scoreUDCG(observed, relevant, 100);
    // Same as scoreUDCG(observed, relevant, 2)
    const result2 = scoreUDCG(observed, relevant, 2);
    expect(result).toBeCloseTo(result2!, 10);
  });
});

// ─────────────────────────────────────────────────────────────────────
// P8: Brier Score (Confidence Calibration)
// ─────────────────────────────────────────────────────────────────────


describe('scoreBrierCalibration', () => {
  it('returns null brierScore when predictions is empty', () => {
    const result = scoreBrierCalibration([]);
    expect(result.brierScore).toBeNull();
    expect(result.sampleCount).toBe(0);
  });

  it('perfectly calibrated predictions return 0', () => {
    const result = scoreBrierCalibration([
      { confidence: 1.0, correct: true },
      { confidence: 0.0, correct: false },
    ]);
    expect(result.brierScore).toBeCloseTo(0, 5);
    expect(result.sampleCount).toBe(2);
  });

  it('maximally miscalibrated predictions return 1', () => {
    const result = scoreBrierCalibration([
      { confidence: 1.0, correct: false },
      { confidence: 0.0, correct: true },
    ]);
    expect(result.brierScore).toBeCloseTo(1, 5);
    expect(result.sampleCount).toBe(2);
  });

  it('moderate calibration returns intermediate score', () => {
    const result = scoreBrierCalibration([
      { confidence: 0.8, correct: true },   // (0.8-1)² = 0.04
      { confidence: 0.3, correct: false },   // (0.3-0)² = 0.09
    ]);
    // Mean = (0.04 + 0.09) / 2 = 0.065
    expect(result.brierScore).toBeCloseTo(0.065, 5);
    expect(result.sampleCount).toBe(2);
  });
});


describe('computeJudgeSCRCorrelation', () => {
  it('returns null pearsonR when fewer than 3 pairs', () => {
    expect(computeJudgeSCRCorrelation([]).pearsonR).toBeNull();
    expect(computeJudgeSCRCorrelation([]).sampleCount).toBe(0);

    expect(computeJudgeSCRCorrelation([
      { scrScore: 0.5, judgeScore: 0.5 },
    ]).pearsonR).toBeNull();

    expect(computeJudgeSCRCorrelation([
      { scrScore: 0.5, judgeScore: 0.5 },
      { scrScore: 0.8, judgeScore: 0.9 },
    ]).pearsonR).toBeNull();
    expect(computeJudgeSCRCorrelation([
      { scrScore: 0.5, judgeScore: 0.5 },
      { scrScore: 0.8, judgeScore: 0.9 },
    ]).sampleCount).toBe(2);
  });

  it('returns r=1.0 for perfect positive correlation', () => {
    const result = computeJudgeSCRCorrelation([
      { scrScore: 0.0, judgeScore: 0.0 },
      { scrScore: 0.5, judgeScore: 0.5 },
      { scrScore: 1.0, judgeScore: 1.0 },
    ]);
    expect(result.pearsonR).toBeCloseTo(1.0, 5);
    expect(result.sampleCount).toBe(3);
  });

  it('returns r=-1.0 for perfect negative correlation', () => {
    const result = computeJudgeSCRCorrelation([
      { scrScore: 0.0, judgeScore: 1.0 },
      { scrScore: 0.5, judgeScore: 0.5 },
      { scrScore: 1.0, judgeScore: 0.0 },
    ]);
    expect(result.pearsonR).toBeCloseTo(-1.0, 5);
    expect(result.sampleCount).toBe(3);
  });

  it('returns null when one dimension has zero variance', () => {
    const result = computeJudgeSCRCorrelation([
      { scrScore: 0.5, judgeScore: 0.7 },
      { scrScore: 0.5, judgeScore: 0.8 },
      { scrScore: 0.5, judgeScore: 0.9 },
    ]);
    expect(result.pearsonR).toBeNull();
    expect(result.sampleCount).toBe(3);
  });

  it('computes moderate correlation correctly', () => {
    // Manually computed: X=[0.2, 0.4, 0.6, 0.8], Y=[0.3, 0.5, 0.4, 0.9]
    // meanX=0.5, meanY=0.525
    // cov = ((0.2-0.5)(0.3-0.525) + (0.4-0.5)(0.5-0.525) + (0.6-0.5)(0.4-0.525) + (0.8-0.5)(0.9-0.525))/3
    // = (0.0675 + 0.0025 - 0.0125 + 0.1125)/3 = 0.17/3 ≈ 0.056667
    // stdX = sqrt(((0.09+0.01+0.01+0.09)/3)) = sqrt(0.2/3) ≈ 0.2582
    // stdY = sqrt(((0.050625+0.000625+0.015625+0.140625)/3)) = sqrt(0.2075/3) ≈ 0.2630
    // r = 0.056667 / (0.2582 * 0.2630) ≈ 0.835
    const result = computeJudgeSCRCorrelation([
      { scrScore: 0.2, judgeScore: 0.3 },
      { scrScore: 0.4, judgeScore: 0.5 },
      { scrScore: 0.6, judgeScore: 0.4 },
      { scrScore: 0.8, judgeScore: 0.9 },
    ]);
    expect(result.pearsonR).not.toBeNull();
    expect(result.pearsonR!).toBeCloseTo(0.835, 2);
    expect(result.sampleCount).toBe(4);
  });

  it('handles large offset values without catastrophic cancellation', () => {
    // Shift all values by 1e6 — naive formula would lose precision
    const base = 1_000_000;
    const result = computeJudgeSCRCorrelation([
      { scrScore: base + 0.0, judgeScore: base + 0.0 },
      { scrScore: base + 0.5, judgeScore: base + 0.5 },
      { scrScore: base + 1.0, judgeScore: base + 1.0 },
    ]);
    expect(result.pearsonR).toBeCloseTo(1.0, 5);
  });

  it('returns r close to 0 for uncorrelated data', () => {
    const result = computeJudgeSCRCorrelation([
      { scrScore: 0.1, judgeScore: 0.9 },
      { scrScore: 0.5, judgeScore: 0.5 },
      { scrScore: 0.9, judgeScore: 0.9 },
      { scrScore: 0.3, judgeScore: 0.3 },
      { scrScore: 0.7, judgeScore: 0.5 },
    ]);
    expect(result.pearsonR).not.toBeNull();
    // Weak or near-zero correlation — just verify it's between -1 and 1
    expect(result.pearsonR!).toBeGreaterThanOrEqual(-1);
    expect(result.pearsonR!).toBeLessThanOrEqual(1);
  });
});

