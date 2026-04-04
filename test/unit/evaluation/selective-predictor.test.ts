import { describe, it, expect } from 'vitest';
import { SelectivePredictor } from '../../../src/domain/evaluation/service/selective-predictor.js';
import type { EvalResult } from '../../../src/domain/evaluation/model/eval-result.js';

const predictor = new SelectivePredictor();

function makeResult(overrides: Partial<EvalResult> & Pick<EvalResult, 'decisionConfidence' | 'isWrongResolve'>): EvalResult {
  return {
    caseId: 'case-1',
    predictedStatus: 'resolved',
    utilityScore: overrides.isWrongResolve ? -1.5 : 1.0,
    isCorrectResolve: !overrides.isWrongResolve,
    isSafeAbstain: false,
    isAvoidableAbstain: false,
    evidenceItems: [],
    latencyMs: 50,
    decisionSnapshot: {
      plannerVersion: '1.0.0',
      resolverVersion: '1.0.0',
      rankingVersion: '1.0.0',
      thresholdProfileId: 'default-v1',
      capturedAt: new Date(),
    },
    ...overrides,
  };
}

describe('SelectivePredictor', () => {
  describe('computeAURC', () => {
    it('perfect system (all correct) → AURC = 0', () => {
      const results: EvalResult[] = [
        makeResult({ decisionConfidence: 0.9, isWrongResolve: false }),
        makeResult({ decisionConfidence: 0.85, isWrongResolve: false }),
        makeResult({ decisionConfidence: 0.8, isWrongResolve: false }),
        makeResult({ decisionConfidence: 0.75, isWrongResolve: false }),
      ];
      const aurc = predictor.computeAURC(results);
      expect(aurc).toBeCloseTo(0, 5);
    });

    it('all wrong → AURC = 1.0 (maximum risk at all coverage levels)', () => {
      const results: EvalResult[] = [
        makeResult({ decisionConfidence: 0.9, isWrongResolve: true }),
        makeResult({ decisionConfidence: 0.8, isWrongResolve: true }),
        makeResult({ decisionConfidence: 0.7, isWrongResolve: true }),
        makeResult({ decisionConfidence: 0.6, isWrongResolve: true }),
      ];
      const aurc = predictor.computeAURC(results);
      expect(aurc).toBeCloseTo(1.0, 1);
    });

    it('returns 0 for empty results', () => {
      expect(predictor.computeAURC([])).toBe(0);
    });

    it('AURC is computed via trapezoidal integration (non-negative)', () => {
      const results: EvalResult[] = [
        makeResult({ decisionConfidence: 0.9, isWrongResolve: false }),
        makeResult({ decisionConfidence: 0.7, isWrongResolve: true }),
        makeResult({ decisionConfidence: 0.5, isWrongResolve: false }),
      ];
      const aurc = predictor.computeAURC(results);
      expect(aurc).toBeGreaterThanOrEqual(0);
      expect(aurc).toBeLessThanOrEqual(1);
    });
  });

  describe('computeRiskAtCoverage', () => {
    it('computeRiskAtCoverage(results, 0.5) → risk of top 50% by confidence', () => {
      const results: EvalResult[] = [
        makeResult({ decisionConfidence: 0.9, isWrongResolve: false }),
        makeResult({ decisionConfidence: 0.8, isWrongResolve: true }),
        makeResult({ decisionConfidence: 0.7, isWrongResolve: false }),
        makeResult({ decisionConfidence: 0.6, isWrongResolve: true }),
      ];
      // Top 50% by confidence = top 2 results: confidence 0.9 (correct) and 0.8 (wrong)
      const risk = predictor.computeRiskAtCoverage(results, 0.5);
      // 1 wrong resolve out of 2 covered = 0.5
      expect(risk).toBeCloseTo(0.5, 5);
    });

    it('returns 0 risk when empty results', () => {
      expect(predictor.computeRiskAtCoverage([], 0.5)).toBe(0);
    });

    it('returns 0 risk when all covered are correct', () => {
      const results: EvalResult[] = [
        makeResult({ decisionConfidence: 0.9, isWrongResolve: false }),
        makeResult({ decisionConfidence: 0.8, isWrongResolve: false }),
        makeResult({ decisionConfidence: 0.7, isWrongResolve: true }),
      ];
      // Top 1/3 by confidence = 1 result (confidence 0.9, correct)
      const risk = predictor.computeRiskAtCoverage(results, 0.33);
      expect(risk).toBe(0);
    });

    it('coverage=1.0 covers all results', () => {
      const results: EvalResult[] = [
        makeResult({ decisionConfidence: 0.9, isWrongResolve: false }),
        makeResult({ decisionConfidence: 0.8, isWrongResolve: false }),
        makeResult({ decisionConfidence: 0.7, isWrongResolve: true }),
      ];
      const risk = predictor.computeRiskAtCoverage(results, 1.0);
      // 1 wrong out of 3 total = 1/3
      expect(risk).toBeCloseTo(1 / 3, 5);
    });
  });

  describe('high confidence wrong resolve → visible risk spike', () => {
    it('risk at high coverage equals risk at low coverage when wrong resolve is highest confidence', () => {
      // System incorrectly resolves with high confidence → risk spike at low coverage
      const results: EvalResult[] = [
        makeResult({ decisionConfidence: 0.99, isWrongResolve: true }),  // HIGH confidence wrong
        makeResult({ decisionConfidence: 0.60, isWrongResolve: false }),
        makeResult({ decisionConfidence: 0.50, isWrongResolve: false }),
        makeResult({ decisionConfidence: 0.40, isWrongResolve: false }),
      ];
      // At 25% coverage (top 1 result = the wrong one), risk = 1.0
      const riskAt25 = predictor.computeRiskAtCoverage(results, 0.25);
      // At 100% coverage, risk = 0.25
      const riskAt100 = predictor.computeRiskAtCoverage(results, 1.0);

      expect(riskAt25).toBe(1.0); // Only the wrong resolve is covered
      expect(riskAt100).toBeCloseTo(1 / 4, 5);
    });
  });

  describe('sortByCoverageBins', () => {
    it('returns empty array for empty results', () => {
      expect(predictor.sortByCoverageBins([])).toHaveLength(0);
    });

    it('sorts results by confidence descending within bins', () => {
      const results: EvalResult[] = [
        makeResult({ decisionConfidence: 0.3, isWrongResolve: false }),
        makeResult({ decisionConfidence: 0.9, isWrongResolve: false }),
        makeResult({ decisionConfidence: 0.6, isWrongResolve: false }),
      ];
      const bins = predictor.sortByCoverageBins(results, 3);
      // First bin should have highest confidence result
      expect(bins[0]![0]!.decisionConfidence).toBe(0.9);
    });
  });

  describe('computeRiskCoverageCurve', () => {
    it('returns correct number of points', () => {
      const results: EvalResult[] = [
        makeResult({ decisionConfidence: 0.9, isWrongResolve: false }),
        makeResult({ decisionConfidence: 0.8, isWrongResolve: true }),
      ];
      const curve = predictor.computeRiskCoverageCurve(results, 10);
      expect(curve).toHaveLength(10);
    });

    it('coverage values go from small to 1.0', () => {
      const results: EvalResult[] = [
        makeResult({ decisionConfidence: 0.9, isWrongResolve: false }),
        makeResult({ decisionConfidence: 0.8, isWrongResolve: false }),
      ];
      const curve = predictor.computeRiskCoverageCurve(results, 5);
      expect(curve[curve.length - 1]!.coverage).toBe(1.0);
      expect(curve[0]!.coverage).toBeGreaterThan(0);
    });
  });
});
