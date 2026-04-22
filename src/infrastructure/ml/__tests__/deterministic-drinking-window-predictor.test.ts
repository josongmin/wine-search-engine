import { describe, expect, it } from 'vitest';
import { DeterministicDrinkingWindowPredictor } from '../deterministic-drinking-window-predictor.js';
import {
  FIXED_DRINKING_WINDOW_FORMULA_VERSION,
  FixedDrinkingWindowFormula,
} from '../fixed-drinking-window-formula.js';
import {
  STRUCTURAL_DRINKING_WINDOW_FORMULA_VERSION,
  StructuralDrinkingWindowFormula,
} from '../structural-drinking-window-formula.js';

describe('DeterministicDrinkingWindowPredictor', () => {
  const input = {
    vintage: 2018,
    grapePrimaryEnc: 42,
    regionEnc: 10,
    countryEnc: 1,
    body: 4,
    tannin: 4,
    acidity: 3,
    sweetness: 1,
    avgCriticProxyScore: 95,
  } as const;

  it('exposes a deterministic model version namespace', () => {
    const predictor = new DeterministicDrinkingWindowPredictor();

    expect(predictor.modelVersion).toBe(`deterministic:${STRUCTURAL_DRINKING_WINDOW_FORMULA_VERSION}`);
  });

  it('returns a structural deterministic window anchored to vintage', () => {
    const predictor = new DeterministicDrinkingWindowPredictor();

    expect(predictor.predict(input)).toEqual({
      drinkingWindowStart: 2021,
      drinkingWindowEnd: 2032,
      peakYear: 2026,
      confidence: 'low',
      modelVersion: `deterministic:${STRUCTURAL_DRINKING_WINDOW_FORMULA_VERSION}`,
    });
  });
});

describe('FixedDrinkingWindowFormula', () => {
  it('returns fixed offsets as the placeholder formula slot', () => {
    const formula = new FixedDrinkingWindowFormula();

    expect(
      formula.evaluate({
        vintage: 2020,
        grapePrimaryEnc: 1,
        regionEnc: 2,
        countryEnc: 3,
        tannin: 3,
        acidity: 3,
        avgCriticProxyScore: 90,
      }),
    ).toEqual({
      startOffsetYears: 4,
      endOffsetYears: 12,
      peakOffsetYears: 8,
      confidence: 'low',
    });
  });
});

describe('StructuralDrinkingWindowFormula', () => {
  it('returns decomposed structural terms and bounded offsets', () => {
    const formula = new StructuralDrinkingWindowFormula();

    const result = formula.evaluate({
      vintage: 2020,
      grapePrimaryEnc: 1,
      regionEnc: 2,
      countryEnc: 3,
      grapePrimary: 'Nebbiolo',
      region: 'Piedmont',
      appellation: 'Barolo',
      regionHierarchy: ['Italy', 'Piedmont', 'Barolo'],
      wineType: 'red',
      classification: 'DOCG',
      oakTreatment: 'large oak cask',
      producerType: 'estate',
      body: 4,
      tannin: 4,
      acidity: 3,
      sweetness: 1,
      finishLength: 0.9,
      alcoholPct: 14.5,
      ratingAvg: 4.7,
      ratingsCount: 1287,
      reviewCount: 211,
      ratingDistribution: { '1': 2, '2': 10, '3': 115, '4': 540, '5': 620 },
      avgCriticProxyScore: 95,
      criticScoreNormalized: 0.97,
      producerPrestige: 0.95,
      wineryRatingCount: 8240,
      priceUsd: 150,
      bottleSizeMl: 750,
      bottleSize: '750ml',
      closure: 'Cork',
      hasCompleteStructureSignals: true,
      sourceConfidence: 'high',
    });

    expect(result.confidence).toBe('high');
    expect(result.startOffsetYears).toBeGreaterThanOrEqual(8);
    expect(result.endOffsetYears).toBeGreaterThan(result.startOffsetYears);
    expect(result.longevityScore).toBeGreaterThan(0.7);
    expect(result.readinessScore).toBeLessThan(0.5);
    expect(result.termBreakdown?.varietalAnchor.value).toBeGreaterThan(0.8);
    expect(result.termBreakdown?.blendAdjustment.value).toBeGreaterThanOrEqual(0);
    expect(result.termBreakdown?.offsets.drinkFromYears).toBe(result.startOffsetYears);
    expect(result.termBreakdown?.offsets.bestUntilYears).toBe(result.endOffsetYears);
  });

  it('ignores malformed bottle size strings instead of propagating non-finite size adjustments', () => {
    const formula = new StructuralDrinkingWindowFormula();

    const malformed = formula.evaluate({
      vintage: 2020,
      grapePrimaryEnc: 1,
      regionEnc: 2,
      countryEnc: 3,
      body: 3,
      tannin: 3,
      acidity: 3,
      sweetness: 1,
      avgCriticProxyScore: 90,
      bottleSize: 'bad-size-l',
    });
    const baseline = formula.evaluate({
      vintage: 2020,
      grapePrimaryEnc: 1,
      regionEnc: 2,
      countryEnc: 3,
      body: 3,
      tannin: 3,
      acidity: 3,
      sweetness: 1,
      avgCriticProxyScore: 90,
    });

    expect(malformed.startOffsetYears).toBe(baseline.startOffsetYears);
    expect(malformed.endOffsetYears).toBe(baseline.endOffsetYears);
    expect(malformed.peakOffsetYears).toBe(baseline.peakOffsetYears);
  });
});
