/**
 * Property-based regression suite: retrieval.drinking-window-prediction.
 *
 * The deterministic drinking-window predictor anchors a hand-built structural
 * formula's dimensionless longevity/readiness scores to `input.vintage` and
 * emits absolute calendar years (drink-from / peak / best-until) plus a numeric
 * confidence bound. Because it feeds both the `check_drinking_window` agent
 * tool and search-result cards, the following invariants MUST hold for ALL
 * well-formed inputs — not just the curated example rows in
 * `drinking-window-prediction.regression.test.ts`.
 *
 * Invariants verified (fast-check, numRuns=100, append-only, SOTA++ grade):
 *  1. Determinism — predict(x) deep-equals predict(x) for arbitrary x. The
 *     formula uses no wall clock and no randomness, so output is a pure
 *     function of input.
 *  2. Window validity — drinkingWindowEnd > drinkingWindowStart STRICTLY
 *     (the predictor clamps end to start+1), for every finite-vintage input.
 *  3. Peak containment — drinkingWindowStart <= peakYear <= drinkingWindowEnd.
 *  4. Finite output — every emitted year and the confidenceScore are finite
 *     for any finite-vintage input, even with adversarial NaN/Infinity
 *     sensory/market features (Rule 28 / Rule 32 — non-finite features must
 *     not poison the year arithmetic).
 *  5. Anchor-relative lower bound — drinkingWindowStart >= vintage. The
 *     drink-from offset is clamped to >= 0, so a wine is never "ready" before
 *     it was produced.
 *  6. Anchor-relative upper bound — drinkingWindowEnd <= vintage +
 *     MAX_BEST_UNTIL_OFFSET_YEARS. Every offset term in the structural formula
 *     is independently clamped, so the total best-until offset is bounded by a
 *     value derivable from the documented formula maxima.
 *  7. Confidence bound — confidenceScore in [0, 1], and the enum `confidence`
 *     stays aligned with the documented thresholds (>=0.75 high, >=0.5 medium,
 *     else low). The two surfaces must never drift apart.
 *  8. Non-finite vintage guard — a NaN / +-Infinity vintage THROWS rather than
 *     silently fabricating null-year ("NaN") output, matching the ONNX path.
 *  9. Provable longevity ordering — a hard-floored long-lived primary
 *     (Nebbiolo / Cabernet Sauvignon / Riesling) never ends BEFORE a
 *     hard-ceilinged short-lived primary (Glera / Sauvignon Blanc / Gamay)
 *     of the same vintage, all else equal. This is provable from the
 *     SHORT_LIVED_BEST_UNTIL_CEILING_YEARS (8) <
 *     LONG_LIVED_BEST_UNTIL_FLOOR_YEARS (12) constants in the formula.
 *
 * Touch-policy: regression-only, append-only. Properties that do not hold are
 * documented in the feature-catalog YAML under `known_limitations` — the
 * engine is never loosened to make a property pass.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { DeterministicDrinkingWindowPredictor } from '../../src/infrastructure/ml/deterministic-drinking-window-predictor.js';
import type { DrinkingWindowInput } from '../../src/domain/drinking-window/port/drinking-window-predictor.port.js';

const FC_RUNS = 100;

const predictor = new DeterministicDrinkingWindowPredictor();

// ---------------------------------------------------------------------------
// Anchor-relative upper bound, derived from the documented structural-formula
// offset maxima (structural-drinking-window-formula.ts). The deterministic
// predictor sets drinkingWindowEnd = round(vintage + bestUntilOffset), where:
//   bestUntilOffset <= peakEndOffset + tailOffset
//   peakEndOffset   <= OFFSET_PEAK_CENTER_MAX_YEARS (32) + ceil(OFFSET_PEAK_WIDTH_MAX_YEARS/2) (7)
//   tailOffset      <= OFFSET_TAIL_MAX_YEARS (8)
//   long-lived floor = LONG_LIVED_BEST_UNTIL_FLOOR_YEARS (12)  // below the above max
// => bestUntilOffset <= 32 + 7 + 8 = 47. A small +2 cushion absorbs the
// post-clamp `+1` invariant nudges. If the formula's offset ceilings ever
// rise, THIS bound must be re-derived — that is the point of the property.
const MAX_BEST_UNTIL_OFFSET_YEARS = 47 + 2;

// Confidence thresholds mirrored from structural-drinking-window-formula.ts.
const CONFIDENCE_THRESHOLD_HIGH = 0.75;
const CONFIDENCE_THRESHOLD_MEDIUM = 0.5;

// Hard floor / ceiling primaries from the structural formula. Long-lived
// floor (12y) strictly exceeds short-lived ceiling (8y), making invariant 9
// provable regardless of every other term.
const LONG_LIVED_PRIMARIES = ['Nebbiolo', 'Cabernet Sauvignon', 'Riesling'] as const;
const SHORT_LIVED_PRIMARIES = ['Glera', 'Sauvignon Blanc', 'Gamay'] as const;

const KNOWN_PRIMARIES = [
  ...LONG_LIVED_PRIMARIES,
  ...SHORT_LIVED_PRIMARIES,
  'Pinot Noir',
  'Chardonnay',
  'Merlot',
  'Syrah',
  'Tempranillo',
  'Zinfandel',
  // Korean alias surface + unknown varietal exercise the neutral-prior path.
  '오푸스 원',
  'Totally Unknown Grape',
] as const;

const WINE_TYPES = [
  'red',
  'white',
  'rosé',
  'sparkling',
  'dessert',
  'fortified',
] as const;

/** Arbitrary for a fully-formed, schema-valid drinking-window input. */
function inputArb(): fc.Arbitrary<DrinkingWindowInput> {
  return fc.record({
    vintage: fc.integer({ min: 1800, max: 2200 }),
    grapePrimaryEnc: fc.integer({ min: 0, max: 999 }),
    regionEnc: fc.integer({ min: 0, max: 999 }),
    countryEnc: fc.integer({ min: 0, max: 999 }),
    body: fc.integer({ min: 1, max: 5 }),
    tannin: fc.integer({ min: 1, max: 5 }),
    acidity: fc.integer({ min: 1, max: 5 }),
    sweetness: fc.integer({ min: 1, max: 5 }),
    avgCriticProxyScore: fc.integer({ min: 0, max: 100 }),
    grapePrimary: fc.constantFrom(...KNOWN_PRIMARIES),
    wineType: fc.constantFrom(...WINE_TYPES),
    ratingAvg: fc.double({ min: 1, max: 5, noNaN: true }),
    ratingsCount: fc.integer({ min: 0, max: 1_000_000 }),
    reviewCount: fc.integer({ min: 0, max: 1_000_000 }),
    wineryRatingCount: fc.integer({ min: 0, max: 1_000_000 }),
    priceUsd: fc.double({ min: 0, max: 100_000, noNaN: true }),
    bottleSizeMl: fc.constantFrom(375, 750, 1500, 3000),
  });
}

describe('drinking-window-prediction property-based regression', () => {
  it('invariant 1 + 2 + 3 + 5 + 7: deterministic, valid window, peak-contained, anchored, bounded confidence', () => {
    fc.assert(
      fc.property(inputArb(), (input) => {
        const a = predictor.predict(input);
        const b = predictor.predict(input);

        // 1. Determinism — pure function of input.
        expect(b).toStrictEqual(a);

        // 4. Finite output.
        expect(Number.isFinite(a.drinkingWindowStart)).toBe(true);
        expect(Number.isFinite(a.drinkingWindowEnd)).toBe(true);
        expect(Number.isFinite(a.peakYear)).toBe(true);
        expect(Number.isFinite(a.confidenceScore)).toBe(true);

        // 2. Strict window validity.
        expect(a.drinkingWindowEnd).toBeGreaterThan(a.drinkingWindowStart);

        // 3. Peak containment.
        expect(a.peakYear).toBeGreaterThanOrEqual(a.drinkingWindowStart);
        expect(a.peakYear).toBeLessThanOrEqual(a.drinkingWindowEnd);

        // 5. Anchor-relative lower bound — never ready before produced.
        expect(a.drinkingWindowStart).toBeGreaterThanOrEqual(input.vintage);

        // 7. Confidence bound + enum alignment.
        expect(a.confidenceScore).toBeGreaterThanOrEqual(0);
        expect(a.confidenceScore).toBeLessThanOrEqual(1);
        if (a.confidence === 'high') {
          expect(a.confidenceScore).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD_HIGH);
        } else if (a.confidence === 'medium') {
          expect(a.confidenceScore).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD_MEDIUM);
          expect(a.confidenceScore).toBeLessThan(CONFIDENCE_THRESHOLD_HIGH);
        } else {
          expect(a.confidenceScore).toBeLessThan(CONFIDENCE_THRESHOLD_MEDIUM);
        }
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('invariant 6: drinkingWindowEnd <= vintage + MAX_BEST_UNTIL_OFFSET_YEARS', () => {
    fc.assert(
      fc.property(inputArb(), (input) => {
        const r = predictor.predict(input);
        expect(r.drinkingWindowEnd).toBeLessThanOrEqual(
          input.vintage + MAX_BEST_UNTIL_OFFSET_YEARS,
        );
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('invariant 4: adversarial non-finite features still yield a finite, valid window', () => {
    // vintage stays finite (guarded separately by invariant 8); every OTHER
    // numeric feature may be NaN / +-Infinity. The structural formula must
    // treat non-finite features as "absent" and never leak NaN into a year.
    const nonFinite = fc.constantFrom(
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 1800, max: 2200 }),
        nonFinite,
        nonFinite,
        nonFinite,
        nonFinite,
        (vintage, ratingAvg, ratingsCount, priceUsd, wineryRatingCount) => {
          const r = predictor.predict({
            vintage,
            grapePrimaryEnc: 0,
            regionEnc: 0,
            countryEnc: 0,
            tannin: 3,
            acidity: 3,
            avgCriticProxyScore: 90,
            grapePrimary: 'Cabernet Sauvignon',
            ratingAvg,
            ratingsCount,
            priceUsd,
            wineryRatingCount,
            ratingDistribution: { '1': ratingsCount, '5': priceUsd },
          });
          expect(Number.isFinite(r.drinkingWindowStart)).toBe(true);
          expect(Number.isFinite(r.drinkingWindowEnd)).toBe(true);
          expect(Number.isFinite(r.peakYear)).toBe(true);
          expect(Number.isFinite(r.confidenceScore)).toBe(true);
          expect(r.drinkingWindowEnd).toBeGreaterThan(r.drinkingWindowStart);
          expect(r.confidenceScore).toBeGreaterThanOrEqual(0);
          expect(r.confidenceScore).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  it('invariant 8: non-finite vintage throws (no fabricated null-year output)', () => {
    const badVintage = fc.constantFrom(
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    );
    fc.assert(
      fc.property(badVintage, (vintage) => {
        expect(() =>
          predictor.predict({
            vintage,
            grapePrimaryEnc: 0,
            regionEnc: 0,
            countryEnc: 0,
            tannin: 3,
            acidity: 3,
            avgCriticProxyScore: 90,
          }),
        ).toThrow(/vintage is not finite/);
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('invariant 9: hard-floored long-lived primary never ends before a hard-ceilinged short-lived primary (same vintage)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1900, max: 2100 }),
        fc.constantFrom(...LONG_LIVED_PRIMARIES),
        fc.constantFrom(...SHORT_LIVED_PRIMARIES),
        (vintage, longGrape, shortGrape) => {
          const common = {
            vintage,
            grapePrimaryEnc: 0,
            regionEnc: 0,
            countryEnc: 0,
            tannin: 3,
            acidity: 3,
            avgCriticProxyScore: 90,
          } as const;
          const longLived = predictor.predict({ ...common, grapePrimary: longGrape, grapes: [longGrape] });
          const shortLived = predictor.predict({ ...common, grapePrimary: shortGrape, grapes: [shortGrape] });
          // Provable from formula constants: long-lived floor (12y) > short
          // ceiling (8y), so the long-lived window never closes first.
          expect(longLived.drinkingWindowEnd).toBeGreaterThanOrEqual(
            shortLived.drinkingWindowEnd,
          );
        },
      ),
      { numRuns: FC_RUNS },
    );
  });
});
