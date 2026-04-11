import { describe, it, expect } from 'vitest';
import { Calibrator } from '../../../src/domain/resolver/service/calibrator.js';
import type { CalibrationStore, CalibrationParams } from '../../../src/domain/resolver/port/calibration-store.port.js';
import type { QueryClass } from '../../../src/domain/shared/types/index.js';

// ---------------------------------------------------------------------------
// Inline stub CalibrationStore
// ---------------------------------------------------------------------------

/**
 * Stub CalibrationStore for unit tests.
 * Pass `null` to simulate "no trained params" (triggers default isotonic identity).
 * Pass a {@link CalibrationParams} object to simulate a stored trained model.
 */
function makeStubStore(storedParams: CalibrationParams | null): CalibrationStore {
  return {
    getCalibrationParams(_queryClass: QueryClass): Promise<CalibrationParams | null> {
      return Promise.resolve(storedParams);
    },
    save(_queryClass: QueryClass, _params: CalibrationParams): Promise<void> {
      return Promise.resolve();
    },
  };
}

/** Convenience: build a Calibrator backed by a null store (default identity path). */
function makeDefaultCalibrator(): Calibrator {
  return new Calibrator(makeStubStore(null));
}

// ---------------------------------------------------------------------------
// Helper: compute sigmoid manually for expected-value assertions
// ---------------------------------------------------------------------------
function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Calibrator', () => {
  // -------------------------------------------------------------------------
  // Default identity (isotonic, breakpoint_count=0)
  // -------------------------------------------------------------------------

  describe('default identity path (null store → isotonic breakpoint_count=0)', () => {
    it('case 1 – typical pair: top1=0.8, top2=0.3 → calibratedGap=0.5, decisionConfidenceC=0.8', async () => {
      const calibrator = makeDefaultCalibrator();
      const result = await calibrator.calibrate({ top1: 0.8, top2: 0.3 }, 'short_entity');

      expect(result.top1CalibratedScore).toBeCloseTo(0.8, 10);
      expect(result.top2CalibratedScore).toBeCloseTo(0.3, 10);
      // Gap = top1 - top2 = 0.5 exactly (floating-point difference)
      expect(result.calibratedGap).toBeCloseTo(0.5, 10);
      // decisionConfidenceC is derived directly from the calibrated top-1 score
      expect(result.decisionConfidenceC).toBeCloseTo(0.8, 10);
    });

    it('case 2 – score 0.0 stays 0.0 (lower clamp boundary)', async () => {
      const calibrator = makeDefaultCalibrator();
      const result = await calibrator.calibrate({ top1: 0.0, top2: 0.0 }, 'unknown');

      expect(result.top1CalibratedScore).toBe(0.0);
      expect(result.top2CalibratedScore).toBe(0.0);
    });

    it('case 3 – score 1.0 stays 1.0 (upper clamp boundary)', async () => {
      const calibrator = makeDefaultCalibrator();
      const result = await calibrator.calibrate({ top1: 1.0, top2: 0.0 }, 'unknown');

      expect(result.top1CalibratedScore).toBe(1.0);
    });

    it('case 4 – score -0.5 is clamped to 0 (below range)', async () => {
      const calibrator = makeDefaultCalibrator();
      const result = await calibrator.calibrate({ top1: -0.5, top2: -0.5 }, 'unknown');

      expect(result.top1CalibratedScore).toBe(0.0);
      expect(result.top2CalibratedScore).toBe(0.0);
    });

    it('case 5 – score 1.5 is clamped to 1 (above range)', async () => {
      const calibrator = makeDefaultCalibrator();
      const result = await calibrator.calibrate({ top1: 1.5, top2: 0.0 }, 'unknown');

      expect(result.top1CalibratedScore).toBe(1.0);
    });
  });

  // -------------------------------------------------------------------------
  // Platt scaling: P = sigmoid(a * logit + b)
  // -------------------------------------------------------------------------

  describe('Platt scaling', () => {
    function makePlattCalibrator(a: number, b: number): Calibrator {
      const params: CalibrationParams = {
        method: 'platt',
        queryClass: 'short_entity',
        params: { a, b },
        trainedAt: new Date(),
        ece: 0.05,
      };
      return new Calibrator(makeStubStore(params));
    }

    it('case 6 – a=1, b=0, rawScore=0.0 → sigmoid(0) = 0.5 exactly', async () => {
      const calibrator = makePlattCalibrator(1, 0);
      const result = await calibrator.calibrate({ top1: 0.0, top2: 0.0 }, 'short_entity');

      // sigmoid(1*0+0) = sigmoid(0) = 0.5
      expect(result.top1CalibratedScore).toBeCloseTo(0.5, 15);
    });

    it('case 7 – a=1, b=0, rawScore=1.0 → sigmoid(1) ≈ 0.7310585786 (NOT 1.0)', async () => {
      const calibrator = makePlattCalibrator(1, 0);
      const result = await calibrator.calibrate({ top1: 1.0, top2: 0.0 }, 'short_entity');

      const expected = sigmoid(1.0); // ≈ 0.7310585786300049
      // This is the "ceiling problem": Platt with a=1,b=0 maps raw=1.0 to ~0.731, not 1.0
      expect(result.top1CalibratedScore).toBeCloseTo(expected, 10);
      expect(result.top1CalibratedScore).not.toBeCloseTo(1.0, 5);
    });

    it('case 8 – a=0, b=0, rawScore=0.8 → sigmoid(0) = 0.5 (input ignored when a=0)', async () => {
      const calibrator = makePlattCalibrator(0, 0);
      // a=0 means a*rawScore+b = 0*0.8+0 = 0, so result is sigmoid(0) = 0.5
      const result = await calibrator.calibrate({ top1: 0.8, top2: 0.8 }, 'short_entity');

      expect(result.top1CalibratedScore).toBeCloseTo(0.5, 15);
      expect(result.top2CalibratedScore).toBeCloseTo(0.5, 15);
    });

    it('case 9 – gap = top1Calibrated - top2Calibrated (verified with distinct platt outputs)', async () => {
      const calibrator = makePlattCalibrator(1, 0);
      const rawTop1 = 0.9;
      const rawTop2 = 0.4;
      const result = await calibrator.calibrate({ top1: rawTop1, top2: rawTop2 }, 'short_entity');

      const expectedTop1 = sigmoid(rawTop1);
      const expectedTop2 = sigmoid(rawTop2);
      const expectedGap = expectedTop1 - expectedTop2;

      expect(result.top1CalibratedScore).toBeCloseTo(expectedTop1, 10);
      expect(result.top2CalibratedScore).toBeCloseTo(expectedTop2, 10);
      expect(result.calibratedGap).toBeCloseTo(expectedGap, 10);
    });

    it('case 16 – stored Platt params override the default isotonic identity', async () => {
      // Default would give top1CalibratedScore=0.8 (identity).
      // Platt a=1,b=0 gives sigmoid(0.8) ≈ 0.689, which differs from 0.8.
      const calibrator = makePlattCalibrator(1, 0);
      const result = await calibrator.calibrate({ top1: 0.8, top2: 0.0 }, 'short_entity');

      const expected = sigmoid(0.8); // ≈ 0.6899744811276125
      expect(result.top1CalibratedScore).toBeCloseTo(expected, 10);
      // Must NOT be the identity value 0.8
      expect(result.top1CalibratedScore).not.toBeCloseTo(0.8, 5);
    });
  });

  // -------------------------------------------------------------------------
  // Temperature scaling: softmax with temperature parameter
  // -------------------------------------------------------------------------

  describe('temperature scaling', () => {
    function makeTempCalibrator(temperature: number): Calibrator {
      const params: CalibrationParams = {
        method: 'temperature',
        queryClass: 'anchored_similarity',
        params: { temperature },
        trainedAt: new Date(),
        ece: 0.04,
      };
      return new Calibrator(makeStubStore(params));
    }

    it('case 10 – temperature=1.0 produces result in [0, 1]', async () => {
      const calibrator = makeTempCalibrator(1.0);
      const result = await calibrator.calibrate({ top1: 0.8, top2: 0.2 }, 'anchored_similarity');

      expect(result.top1CalibratedScore).toBeGreaterThanOrEqual(0);
      expect(result.top1CalibratedScore).toBeLessThanOrEqual(1);
    });

    it('case 11 – temperature=0.5 (sharp) gives higher probability than temperature=1.0 for rawScore=0.8', async () => {
      // Lower temperature sharpens the distribution: high-scoring input gets boosted further
      // Binary logits = [0.8, 0.2]. With T<1, softmax concentrates on the max.
      const calibratorSharp = makeTempCalibrator(0.5);
      const calibratorNormal = makeTempCalibrator(1.0);

      const rawScores = { top1: 0.8, top2: 0.2 };
      const resultSharp = await calibratorSharp.calibrate(rawScores, 'anchored_similarity');
      const resultNormal = await calibratorNormal.calibrate(rawScores, 'anchored_similarity');

      expect(resultSharp.top1CalibratedScore).toBeGreaterThan(resultNormal.top1CalibratedScore);
    });

    it('case 12 – temperature=2.0 (flat) pushes probability closer to 0.5 than temperature=1.0 for rawScore=0.8', async () => {
      // Higher temperature flattens the distribution toward uniform.
      const calibratorFlat = makeTempCalibrator(2.0);
      const calibratorNormal = makeTempCalibrator(1.0);

      const rawScores = { top1: 0.8, top2: 0.2 };
      const resultFlat = await calibratorFlat.calibrate(rawScores, 'anchored_similarity');
      const resultNormal = await calibratorNormal.calibrate(rawScores, 'anchored_similarity');

      const distFlat = Math.abs(resultFlat.top1CalibratedScore - 0.5);
      const distNormal = Math.abs(resultNormal.top1CalibratedScore - 0.5);

      // Flat distribution (T=2) must be closer to 0.5 than normal (T=1)
      expect(distFlat).toBeLessThan(distNormal);
    });
  });

  // -------------------------------------------------------------------------
  // Isotonic (piecewise-linear breakpoints)
  // -------------------------------------------------------------------------

  describe('isotonic calibration', () => {
    it('case 13 – 0 breakpoints: identity pass-through for mid-range value', async () => {
      const params: CalibrationParams = {
        method: 'isotonic',
        queryClass: 'unknown',
        params: { breakpoint_count: 0 },
        trainedAt: new Date(),
        ece: 0.5,
      };
      const calibrator = new Calibrator(makeStubStore(params));
      const result = await calibrator.calibrate({ top1: 0.65, top2: 0.2 }, 'unknown');

      expect(result.top1CalibratedScore).toBeCloseTo(0.65, 10);
      expect(result.top2CalibratedScore).toBeCloseTo(0.2, 10);
    });

    it('case 14 – 2 breakpoints: rawScore=0.5 → exact linear interpolation = 0.65', async () => {
      // Breakpoints: (x_0=0.3, y_0=0.4), (x_1=0.7, y_1=0.9)
      // For rawScore=0.5 (between x_0 and x_1):
      //   t = (0.5 - 0.3) / (0.7 - 0.3) = 0.2 / 0.4 = 0.5
      //   result = 0.4 + 0.5 * (0.9 - 0.4) = 0.4 + 0.5 * 0.5 = 0.4 + 0.25 = 0.65 exactly
      const params: CalibrationParams = {
        method: 'isotonic',
        queryClass: 'short_entity',
        params: {
          breakpoint_count: 2,
          x_0: 0.3,
          y_0: 0.4,
          x_1: 0.7,
          y_1: 0.9,
        },
        trainedAt: new Date(),
        ece: 0.03,
      };
      const calibrator = new Calibrator(makeStubStore(params));
      const result = await calibrator.calibrate({ top1: 0.5, top2: 0.0 }, 'short_entity');

      // Verify via explicit interpolation formula: t = (rawScore - x0)/(x1 - x0); expected = y0 + t*(y1-y0)
      const x0 = 0.3, y0 = 0.4, x1 = 0.7, y1 = 0.9, rawScore = 0.5;
      const t = (rawScore - x0) / (x1 - x0); // 0.5
      const formulaExpected = y0 + t * (y1 - y0); // 0.65
      expect(result.top1CalibratedScore).toBeCloseTo(formulaExpected, 10);
      expect(result.top1CalibratedScore).toBeCloseTo(0.65, 10);
    });

    it('case 15 – beyond last breakpoint: rawScore=0.9 with last breakpoint at x=0.7,y=0.9 → returns 0.9 (prevY)', async () => {
      // When rawScore exceeds every breakpoint x value, the loop exhausts and
      // returns prevY (the y of the last breakpoint). Here prevY=0.9.
      const params: CalibrationParams = {
        method: 'isotonic',
        queryClass: 'short_entity',
        params: {
          breakpoint_count: 2,
          x_0: 0.3,
          y_0: 0.4,
          x_1: 0.7,
          y_1: 0.9,
        },
        trainedAt: new Date(),
        ece: 0.03,
      };
      const calibrator = new Calibrator(makeStubStore(params));
      const result = await calibrator.calibrate({ top1: 0.9, top2: 0.0 }, 'short_entity');

      // rawScore=0.9 > x_1=0.7: loop finishes, returns prevY = y_1 = 0.9
      expect(result.top1CalibratedScore).toBeCloseTo(0.9, 10);
    });
  });

  // -------------------------------------------------------------------------
  // Store returning null falls back to isotonic identity
  // -------------------------------------------------------------------------

  describe('null store → fallback normalization + isotonic identity', () => {
    it('case 17 – CalibrationStore returning null preserves in-range scores', async () => {
      // Null store triggers DEFAULT_PLATT_PARAMS (isotonic, breakpoint_count=0)
      const calibrator = new Calibrator(makeStubStore(null));
      const result = await calibrator.calibrate({ top1: 0.72, top2: 0.31 }, 'ambiguous_short_form');

      // Identity: calibrated = rawScore (clamped to [0,1])
      expect(result.top1CalibratedScore).toBeCloseTo(0.72, 10);
      expect(result.top2CalibratedScore).toBeCloseTo(0.31, 10);
      expect(result.decisionConfidenceC).toBeCloseTo(0.72, 10);
      expect(result.calibratedGap).toBeCloseTo(0.72 - 0.31, 10);
    });

    it('normalizes additive resolver scores above 1.0 before fallback calibration', async () => {
      const calibrator = new Calibrator(makeStubStore(null));
      const result = await calibrator.calibrate({ top1: 2.2, top2: 1.1 }, 'ambiguous_short_form');

      expect(result.top1CalibratedScore).toBeCloseTo(1, 10);
      expect(result.top2CalibratedScore).toBeCloseTo(0.5, 10);
      expect(result.calibratedGap).toBeCloseTo(0.5, 10);
    });

    it('throws when trained calibration is required but missing', async () => {
      const calibrator = new Calibrator(makeStubStore(null), {
        requireTrainedParams: true,
      });

      await expect(
        calibrator.calibrate({ top1: 0.72, top2: 0.31 }, 'ambiguous_short_form'),
      ).rejects.toThrow(/Missing trained calibration params/);
    });
  });
});
