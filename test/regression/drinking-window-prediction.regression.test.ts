/**
 * Regression suite: retrieval.drinking-window-prediction (maturity 2 -> 3 bump).
 *
 * Locks in the deterministic structural drinking-window formula behaviour for:
 *  - young vs drink-now vs vintage Champagne style differentiation
 *  - Korean entity stability ('오푸스 원' ASCII boundary edge — rule 5)
 *  - vintage boundary handling (current year, deep past)
 *  - numeric confidence bound contract (in [0, 1]) emitted alongside the
 *    legacy enum confidence — required for maturity 3
 *  - determinism across repeat invocations
 *  - fortified > table wine longevity
 *
 * Append-only. Tests in this file MUST NOT be deleted.
 */

import { describe, expect, it } from 'vitest';
import { DeterministicDrinkingWindowPredictor } from '../../src/infrastructure/ml/deterministic-drinking-window-predictor.js';
import type { DrinkingWindowInput } from '../../src/domain/drinking-window/port/drinking-window-predictor.port.js';

// Current calendar year is pinned to the runtime clock — tests use a constant
// to avoid time-flake. The structural formula does NOT use the wall clock; it
// anchors all offsets to `input.vintage`, so a fixed reference year is safe.
const REFERENCE_YEAR_2026 = 2026;

function predictor(): DeterministicDrinkingWindowPredictor {
  return new DeterministicDrinkingWindowPredictor();
}

function baseInput(overrides: Partial<DrinkingWindowInput>): DrinkingWindowInput {
  return {
    vintage: 2020,
    grapePrimaryEnc: 0,
    regionEnc: 0,
    countryEnc: 0,
    tannin: 3,
    acidity: 3,
    avgCriticProxyScore: 90,
    ...overrides,
  };
}

describe('drinking-window-prediction regression', () => {
  describe('style-aware window shape', () => {
    it('young red full-body (2020 Bordeaux Cabernet) starts later, peak >= 2030', () => {
      const result = predictor().predict(
        baseInput({
          vintage: 2020,
          grapePrimary: 'Cabernet Sauvignon',
          grapes: ['Cabernet Sauvignon', 'Merlot', 'Cabernet Franc'],
          country: 'France',
          region: 'Bordeaux',
          appellation: 'Pauillac',
          wineType: 'red',
          body: 5,
          tannin: 5,
          acidity: 4,
          producer: 'Chateau Margaux',
          ratingAvg: 4.6,
          ratingsCount: 12000,
          wineryRatingCount: 250000,
          priceUsd: 800,
        }),
      );

      // A young, structured Bordeaux blend must not be drinkable right at
      // bottling and must peak in the 2030s.
      expect(result.drinkingWindowStart).toBeGreaterThanOrEqual(2022);
      expect(result.peakYear).toBeGreaterThanOrEqual(2030);
      expect(result.drinkingWindowEnd).toBeGreaterThan(result.drinkingWindowStart);
      expect(result.drinkingWindowEnd).toBeGreaterThanOrEqual(2035);
    });

    it('drink-now style (2022 Pinot Grigio / Glera) window starts within a couple of years of vintage', () => {
      const result = predictor().predict(
        baseInput({
          vintage: 2022,
          grapePrimary: 'Glera',
          grapes: ['Glera'],
          country: 'Italy',
          region: 'Veneto',
          wineType: 'sparkling',
          body: 2,
          tannin: 1,
          acidity: 4,
          sweetness: 2,
          ratingAvg: 3.9,
          ratingsCount: 8000,
        }),
      );

      // Drink-now Glera (Prosecco-style) must be drinkable close to vintage —
      // we allow at most a 3-year aging cap before "start" because the
      // structural formula's minimum drinkFromOffset is 1 + small adjustments.
      expect(result.drinkingWindowStart).toBeLessThanOrEqual(2022 + 3);
      // End must be in the near term — Glera tail is capped at 8 years.
      expect(result.drinkingWindowEnd).toBeLessThanOrEqual(2022 + 9);
    });

    it('vintage Champagne (2015) yields a long window', () => {
      const result = predictor().predict(
        baseInput({
          vintage: 2015,
          grapePrimary: 'Chardonnay',
          grapes: ['Chardonnay', 'Pinot Noir', 'Pinot Meunier'],
          country: 'France',
          region: 'Champagne',
          appellation: 'Champagne',
          wineType: 'sparkling',
          style: 'vintage champagne',
          body: 3,
          tannin: 2,
          acidity: 5,
          ratingAvg: 4.5,
          ratingsCount: 6000,
          wineryRatingCount: 100000,
          priceUsd: 250,
        }),
      );

      // Vintage Champagne is a famously age-worthy sparkling — the window
      // must span at least 8 years end-to-end.
      const span = result.drinkingWindowEnd - result.drinkingWindowStart;
      expect(span).toBeGreaterThanOrEqual(8);
      expect(result.drinkingWindowEnd).toBeGreaterThanOrEqual(2025);
    });
  });

  describe('Korean entity', () => {
    it("predicts a reasonable window for '오푸스 원' 2018 (Korean alias for Opus One)", () => {
      const result = predictor().predict(
        baseInput({
          vintage: 2018,
          // Korean alias surfaces in producer / grapePrimary string paths —
          // the deterministic formula must not crash and must produce a
          // sensible Bordeaux-blend window because the varietals are set.
          producer: '오푸스 원',
          grapePrimary: 'Cabernet Sauvignon',
          grapes: ['Cabernet Sauvignon', 'Cabernet Franc', 'Merlot', 'Petit Verdot'],
          country: 'United States',
          region: 'Napa Valley',
          wineType: 'red',
          body: 5,
          tannin: 5,
          acidity: 4,
          ratingAvg: 4.7,
          ratingsCount: 15000,
          wineryRatingCount: 80000,
          priceUsd: 450,
        }),
      );

      expect(Number.isFinite(result.drinkingWindowStart)).toBe(true);
      expect(Number.isFinite(result.drinkingWindowEnd)).toBe(true);
      expect(result.drinkingWindowEnd).toBeGreaterThan(result.drinkingWindowStart);
      // Premium Cab blend: opens by 2020+ at earliest, runs well into the
      // 2030s.
      expect(result.drinkingWindowStart).toBeGreaterThanOrEqual(2018);
      expect(result.drinkingWindowEnd).toBeGreaterThanOrEqual(2030);
    });
  });

  describe('vintage boundary handling', () => {
    it('vintage = REFERENCE_YEAR yields begin >= REFERENCE_YEAR', () => {
      const result = predictor().predict(
        baseInput({
          vintage: REFERENCE_YEAR_2026,
          grapePrimary: 'Pinot Noir',
          wineType: 'red',
        }),
      );

      expect(result.drinkingWindowStart).toBeGreaterThanOrEqual(REFERENCE_YEAR_2026);
    });

    it('vintage = 1900 produces a window that opens in the past and is mature', () => {
      const result = predictor().predict(
        baseInput({
          vintage: 1900,
          grapePrimary: 'Riesling',
          wineType: 'white',
        }),
      );

      expect(result.drinkingWindowStart).toBeLessThan(REFERENCE_YEAR_2026);
      // End must still respect the invariant end > start, even for an absurd
      // historical vintage.
      expect(result.drinkingWindowEnd).toBeGreaterThan(result.drinkingWindowStart);
      // Window must end well in the past — well-aged wine cannot suddenly
      // start aging again in the future relative to a 1900 vintage.
      expect(result.drinkingWindowEnd).toBeLessThan(2000);
    });
  });

  describe('confidence bound output (maturity 3 contract)', () => {
    it('emits a numeric confidenceScore in [0, 1]', () => {
      const result = predictor().predict(
        baseInput({
          vintage: 2018,
          grapePrimary: 'Nebbiolo',
          producer: 'Giacomo Conterno',
          country: 'Italy',
          region: 'Piedmont',
          wineType: 'red',
          ratingAvg: 4.7,
          ratingsCount: 5000,
        }),
      );

      // Numeric confidence field is the new contract for maturity 3.
      expect(typeof result.confidenceScore).toBe('number');
      expect(Number.isFinite(result.confidenceScore)).toBe(true);
      expect(result.confidenceScore).toBeGreaterThanOrEqual(0);
      expect(result.confidenceScore).toBeLessThanOrEqual(1);
    });

    it('legacy enum confidence remains aligned with confidenceScore thresholds', () => {
      const result = predictor().predict(
        baseInput({
          vintage: 2018,
          grapePrimary: 'Nebbiolo',
          producer: 'Giacomo Conterno',
          ratingAvg: 4.7,
          ratingsCount: 5000,
          priceUsd: 300,
        }),
      );

      // Threshold contract (structural-drinking-window-formula.ts): score
      // >= 0.75 -> high, >= 0.5 -> medium, else low. Lock the alignment so
      // future refactors cannot silently drift the two surfaces apart.
      if (result.confidence === 'high') {
        expect(result.confidenceScore).toBeGreaterThanOrEqual(0.75);
      } else if (result.confidence === 'medium') {
        expect(result.confidenceScore).toBeGreaterThanOrEqual(0.5);
        expect(result.confidenceScore).toBeLessThan(0.75);
      } else {
        expect(result.confidenceScore).toBeLessThan(0.5);
      }
    });

    it('low-data input emits lower confidenceScore than rich-data input', () => {
      const rich = predictor().predict(
        baseInput({
          vintage: 2018,
          grapePrimary: 'Cabernet Sauvignon',
          producer: 'Chateau Margaux',
          ratingAvg: 4.6,
          ratingsCount: 12000,
          reviewCount: 8000,
          wineryRatingCount: 200000,
          priceUsd: 800,
          ratingDistribution: { '1': 10, '2': 30, '3': 200, '4': 800, '5': 2000 },
          bottleSizeMl: 750,
          closure: 'Cork',
        }),
      );
      const sparse = predictor().predict(
        baseInput({
          vintage: 2018,
          grapePrimary: 'Cabernet Sauvignon',
        }),
      );

      // Rich input must produce strictly higher confidence than sparse input —
      // the formula blends data completeness, engagement, and presence of
      // anchors. If this ever flips, the confidence scoring is broken.
      expect(rich.confidenceScore).toBeGreaterThan(sparse.confidenceScore);
    });
  });

  describe('adjacent regressions', () => {
    it('determinism: identical input five times yields identical output', () => {
      const input = baseInput({
        vintage: 2019,
        grapePrimary: 'Syrah',
        producer: 'E. Guigal',
        country: 'France',
        region: 'Rhône',
        wineType: 'red',
        ratingAvg: 4.4,
        ratingsCount: 9000,
        priceUsd: 120,
      });

      const runs = Array.from({ length: 5 }, () => predictor().predict(input));
      const first = runs[0]!;
      for (const r of runs) {
        expect(r.drinkingWindowStart).toBe(first.drinkingWindowStart);
        expect(r.drinkingWindowEnd).toBe(first.drinkingWindowEnd);
        expect(r.peakYear).toBe(first.peakYear);
        expect(r.confidenceScore).toBe(first.confidenceScore);
        expect(r.confidence).toBe(first.confidence);
        expect(r.modelVersion).toBe(first.modelVersion);
      }
    });

    it('producer signal (wineryRatingCount) lengthens the window vs a low-prestige producer', () => {
      const prestige = predictor().predict(
        baseInput({
          vintage: 2018,
          grapePrimary: 'Cabernet Sauvignon',
          producer: 'Premier Cru Producer',
          wineryRatingCount: 500000,
          priceUsd: 500,
          ratingAvg: 4.6,
          ratingsCount: 20000,
        }),
      );
      const lowKey = predictor().predict(
        baseInput({
          vintage: 2018,
          grapePrimary: 'Cabernet Sauvignon',
          producer: 'Unknown Producer',
          ratingAvg: 3.4,
          ratingsCount: 12,
        }),
      );

      // Higher prestige -> later end-of-window (more cellaring headroom).
      expect(prestige.drinkingWindowEnd).toBeGreaterThanOrEqual(lowKey.drinkingWindowEnd);
    });
  });
});
