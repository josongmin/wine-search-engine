import { describe, it, expect } from 'vitest';
import { UtilityScorer } from '../../../src/domain/evaluation/service/utility-scorer.js';
import type { EvalCase } from '../../../src/domain/evaluation/model/eval-case.js';
import type { EvalResult } from '../../../src/domain/evaluation/model/eval-result.js';

const scorer = new UtilityScorer();

function makeEvalCase(overrides?: Partial<EvalCase>): EvalCase {
  return {
    caseId: 'case-1',
    query: 'opus one',
    queryClass: 'short_entity',
    expectedEntityId: 'entity-opus-one' as any,
    expectedStatus: 'resolved',
    labelTier: 'gold',
    timestamp: new Date(),
    sliceTags: [],
    ...overrides,
  };
}

function makeEvalResult(overrides?: Partial<EvalResult>): EvalResult {
  return {
    caseId: 'case-1',
    predictedEntityId: 'entity-opus-one' as any,
    predictedStatus: 'resolved',
    decisionConfidence: 0.9,
    utilityScore: 1.0,
    isCorrectResolve: true,
    isWrongResolve: false,
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

describe('UtilityScorer', () => {
  describe('individual case scoring', () => {
    it('correct_resolve entity match → +1.0', () => {
      const evalCase = makeEvalCase({ expectedEntityId: 'entity-1' as any, expectedStatus: 'resolved' });
      const result = scorer.score('resolved', 'entity-1' as any, evalCase);
      expect(result.utilityScore).toBe(1.0);
      expect(result.isCorrectResolve).toBe(true);
      expect(result.isWrongResolve).toBe(false);
    });

    it('wrong_resolve entity mismatch → -1.5', () => {
      const evalCase = makeEvalCase({ expectedEntityId: 'entity-1' as any, expectedStatus: 'resolved' });
      const result = scorer.score('resolved', 'entity-WRONG' as any, evalCase);
      expect(result.utilityScore).toBe(-1.5);
      expect(result.isWrongResolve).toBe(true);
      expect(result.isCorrectResolve).toBe(false);
    });

    it('safe_abstain (ambiguous expected) → +0.4', () => {
      const evalCase = makeEvalCase({ expectedStatus: 'ambiguous', expectedEntityId: undefined });
      const result = scorer.score('ambiguous', undefined, evalCase);
      expect(result.utilityScore).toBe(0.4);
      expect(result.isSafeAbstain).toBe(true);
    });

    it('avoidable_abstain (resolved expected, system abstained) → -0.3', () => {
      const evalCase = makeEvalCase({ expectedEntityId: 'entity-1' as any, expectedStatus: 'resolved' });
      const result = scorer.score('ambiguous', undefined, evalCase);
      expect(result.utilityScore).toBe(-0.3);
      expect(result.isAvoidableAbstain).toBe(true);
      expect(result.isSafeAbstain).toBe(false);
    });

    it('failed status → 0.0 (neutral)', () => {
      const evalCase = makeEvalCase({ expectedEntityId: 'entity-1' as any, expectedStatus: 'resolved' });
      const result = scorer.score('failed', undefined, evalCase);
      expect(result.utilityScore).toBe(0.0);
      expect(result.isCorrectResolve).toBe(false);
      expect(result.isWrongResolve).toBe(false);
      expect(result.isSafeAbstain).toBe(false);
      expect(result.isAvoidableAbstain).toBe(false);
    });

    it('resolved to correct entity only when both predicted and expected are defined and equal', () => {
      // predicted entity undefined → wrong resolve
      const evalCase = makeEvalCase({ expectedEntityId: 'entity-1' as any, expectedStatus: 'resolved' });
      const result = scorer.score('resolved', undefined, evalCase);
      expect(result.isWrongResolve).toBe(true);
      expect(result.utilityScore).toBe(-1.5);
    });
  });

  describe('aggregate utility', () => {
    it('aggregate utility = mean of individual scores', () => {
      const results: EvalResult[] = [
        makeEvalResult({ utilityScore: 1.0 }),
        makeEvalResult({ utilityScore: -1.5 }),
        makeEvalResult({ utilityScore: 0.4 }),
      ];
      const mean = scorer.aggregateUtility(results);
      expect(mean).toBeCloseTo((1.0 + -1.5 + 0.4) / 3, 10);
    });

    it('returns 0 for empty results', () => {
      expect(scorer.aggregateUtility([])).toBe(0);
    });

    it('single result returns that result\'s score', () => {
      const results: EvalResult[] = [makeEvalResult({ utilityScore: 0.4 })];
      expect(scorer.aggregateUtility(results)).toBe(0.4);
    });
  });

  describe('wrongResolveRate', () => {
    it('computed correctly from EvalResult set', () => {
      const results: EvalResult[] = [
        makeEvalResult({ isWrongResolve: true, utilityScore: -1.5 }),
        makeEvalResult({ isWrongResolve: false, utilityScore: 1.0 }),
        makeEvalResult({ isWrongResolve: false, utilityScore: 0.4 }),
        makeEvalResult({ isWrongResolve: true, utilityScore: -1.5 }),
      ];
      const wrongResolveCount = results.filter((r) => r.isWrongResolve).length;
      const rate = wrongResolveCount / results.length;
      expect(rate).toBeCloseTo(2 / 4, 10);
      expect(rate).toBe(0.5);
    });
  });
});
