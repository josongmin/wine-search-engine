import { describe, it, expect } from 'vitest';
import { UtilityScorer } from '../service/utility-scorer.js';
import type { EvalCase } from '../model/eval-case.js';
import type { EvalResult } from '../model/eval-result.js';
import { createEntityId } from '../../shared/types/index.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const ENTITY_A = createEntityId('entity-opus-one');
const ENTITY_B = createEntityId('entity-chateau-margaux');

function makeEvalCase(
  expectedStatus: EvalCase['expectedStatus'],
  expectedEntityId?: string,
): EvalCase {
  const base = {
    caseId: 'case-001',
    query: '오푸스원',
    queryClass: 'short_entity' as const,
    expectedStatus,
    labelTier: 'gold' as const,
    annotatorAgreement: 0.9,
    timestamp: new Date('2026-01-01'),
    sliceTags: ['korean_query'],
  };
  if (expectedEntityId !== undefined) {
    return { ...base, expectedEntityId: createEntityId(expectedEntityId) };
  }
  return base;
}

function makeEvalResult(overrides: Partial<EvalResult> = {}): EvalResult {
  return {
    caseId: 'case-001',
    predictedStatus: 'resolved',
    predictedEntityId: ENTITY_A,
    decisionConfidence: 0.9,
    utilityScore: 1.0,
    isCorrectResolve: true,
    isWrongResolve: false,
    isSafeAbstain: false,
    isAvoidableAbstain: false,
    evidenceItems: [],
    latencyMs: 50,
    decisionSnapshot: {
      model_versions: {},
      index_versions: {},
      policy_rule_version: '1.0.0',
      threshold_profile_id: 'default-v1',
      planner_version: '1.0.0',
      feature_flags: {},
    },
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('UtilityScorer', () => {
  const scorer = new UtilityScorer();

  describe('individual scoring', () => {
    it('correct resolve → +1.0', () => {
      const evalCase = makeEvalCase('resolved', 'entity-opus-one');
      const result = scorer.score('resolved', ENTITY_A, evalCase);
      expect(result.utilityScore).toBe(1.0);
      expect(result.isCorrectResolve).toBe(true);
      expect(result.isWrongResolve).toBe(false);
      expect(result.isSafeAbstain).toBe(false);
      expect(result.isAvoidableAbstain).toBe(false);
    });

    it('wrong resolve → -1.5', () => {
      const evalCase = makeEvalCase('resolved', 'entity-opus-one');
      // Predict entity B but expected entity A → wrong resolve
      const result = scorer.score('resolved', ENTITY_B, evalCase);
      expect(result.utilityScore).toBe(-1.5);
      expect(result.isWrongResolve).toBe(true);
      expect(result.isCorrectResolve).toBe(false);
    });

    it('resolved with no expected entity id (hybrid / open-set) → correct resolve when engine resolves', () => {
      const evalCase = makeEvalCase('resolved');
      const result = scorer.score('resolved', ENTITY_A, evalCase);
      expect(result.utilityScore).toBe(1.0);
      expect(result.isCorrectResolve).toBe(true);
      expect(result.isWrongResolve).toBe(false);
    });

    it('safe abstain (genuinely ambiguous) → +0.4', () => {
      const evalCase = makeEvalCase('ambiguous');
      const result = scorer.score('ambiguous', undefined, evalCase);
      expect(result.utilityScore).toBe(0.4);
      expect(result.isSafeAbstain).toBe(true);
      expect(result.isAvoidableAbstain).toBe(false);
    });

    it('avoidable abstain (clear answer existed) → -0.3', () => {
      const evalCase = makeEvalCase('resolved', 'entity-opus-one');
      // Engine went ambiguous even though expected was resolved
      const result = scorer.score('ambiguous', undefined, evalCase);
      expect(result.utilityScore).toBe(-0.3);
      expect(result.isAvoidableAbstain).toBe(true);
      expect(result.isSafeAbstain).toBe(false);
    });

    it('resolved while gold ambiguous (over-resolve) → -0.3 AND isAvoidableAbstain=true', () => {
      // Gold label is ambiguous but the engine resolved to a concrete entity.
      // Per the in-code AVOIDABLE_ABSTAIN penalty, the over-resolve must carry
      // the matching flag so it is visible in avoidableAbstainRate and the
      // exactly-one-flag invariant holds for this non-failed outcome.
      const evalCase = makeEvalCase('ambiguous');
      const result = scorer.score('resolved', ENTITY_A, evalCase);
      expect(result.utilityScore).toBe(-0.3);
      expect(result.isAvoidableAbstain).toBe(true);
      expect(result.isCorrectResolve).toBe(false);
      expect(result.isWrongResolve).toBe(false);
      expect(result.isSafeAbstain).toBe(false);
    });

    it('failed status → 0.0 (neutral)', () => {
      const evalCase = makeEvalCase('resolved', 'entity-opus-one');
      const result = scorer.score('failed', undefined, evalCase);
      expect(result.utilityScore).toBe(0.0);
      expect(result.isCorrectResolve).toBe(false);
      expect(result.isWrongResolve).toBe(false);
      expect(result.isSafeAbstain).toBe(false);
      expect(result.isAvoidableAbstain).toBe(false);
    });

    it('resolved with undefined predictedEntityId → wrong resolve', () => {
      const evalCase = makeEvalCase('resolved', 'entity-opus-one');
      const result = scorer.score('resolved', undefined, evalCase);
      expect(result.utilityScore).toBe(-1.5);
      expect(result.isWrongResolve).toBe(true);
    });

    it('resolved with matching entityId → correct resolve', () => {
      const evalCase = makeEvalCase('resolved', 'entity-opus-one');
      const result = scorer.score('resolved', ENTITY_A, evalCase);
      expect(result.isCorrectResolve).toBe(true);
    });
  });

  describe('aggregate utility', () => {
    it('empty results → 0', () => {
      expect(scorer.aggregateUtility([])).toBe(0);
    });

    it('all correct resolves → mean = 1.0', () => {
      const results = [
        makeEvalResult({ utilityScore: 1.0 }),
        makeEvalResult({ utilityScore: 1.0 }),
        makeEvalResult({ utilityScore: 1.0 }),
      ];
      expect(scorer.aggregateUtility(results)).toBe(1.0);
    });

    it('mixed results → correct mean', () => {
      // [1.0, -1.5, 0.4, -0.3] → mean = (1.0 - 1.5 + 0.4 - 0.3) / 4 = -0.4/4 = -0.1
      const results = [
        makeEvalResult({ utilityScore: 1.0 }),
        makeEvalResult({ utilityScore: -1.5 }),
        makeEvalResult({ utilityScore: 0.4 }),
        makeEvalResult({ utilityScore: -0.3 }),
      ];
      expect(scorer.aggregateUtility(results)).toBeCloseTo(-0.1, 10);
    });

    it('single correct resolve → 1.0', () => {
      const results = [makeEvalResult({ utilityScore: 1.0 })];
      expect(scorer.aggregateUtility(results)).toBe(1.0);
    });

    it('all wrong resolves → mean = -1.5', () => {
      const results = [
        makeEvalResult({ utilityScore: -1.5, isWrongResolve: true }),
        makeEvalResult({ utilityScore: -1.5, isWrongResolve: true }),
      ];
      expect(scorer.aggregateUtility(results)).toBe(-1.5);
    });
  });

  describe('wrongResolveRate check', () => {
    it('wrongResolveRate < 5% when no wrong resolves in 20+ cases', () => {
      const results = Array.from({ length: 20 }, (_, i) =>
        makeEvalResult({ caseId: `case-${i}`, isWrongResolve: false, utilityScore: 1.0 }),
      );
      const wrongResolveCount = results.filter((r) => r.isWrongResolve).length;
      const wrongResolveRate = wrongResolveCount / results.length;
      expect(wrongResolveRate).toBeLessThan(0.05);
    });

    it('wrongResolveRate >= 5% when 1 wrong in 20 cases (5%)', () => {
      const results = Array.from({ length: 20 }, (_, i) =>
        makeEvalResult({
          caseId: `case-${i}`,
          isWrongResolve: i === 0,
          utilityScore: i === 0 ? -1.5 : 1.0,
        }),
      );
      const wrongResolveCount = results.filter((r) => r.isWrongResolve).length;
      const wrongResolveRate = wrongResolveCount / results.length;
      // 1/20 = 5% which is not < 5%
      expect(wrongResolveRate).toBeGreaterThanOrEqual(0.05);
    });

    it('wrongResolveRate is strictly less than 5% at 0 wrong resolves', () => {
      const total = 100;
      const wrongCount = 0;
      const rate = wrongCount / total;
      expect(rate).toBeLessThan(0.05);
    });

    it('negative aggregate utility indicates poor engine performance', () => {
      // 2 wrong resolves, 1 correct → (-1.5 - 1.5 + 1.0) / 3 = -2/3 ≈ -0.667
      const results = [
        makeEvalResult({ utilityScore: -1.5, isWrongResolve: true }),
        makeEvalResult({ utilityScore: -1.5, isWrongResolve: true }),
        makeEvalResult({ utilityScore: 1.0, isCorrectResolve: true }),
      ];
      expect(scorer.aggregateUtility(results)).toBeCloseTo(-2 / 3, 10);
    });
  });

  describe('boolean flag exclusivity', () => {
    it('exactly one flag is true for each non-failed outcome', () => {
      const testCases: Array<{
        status: Parameters<UtilityScorer['score']>[0];
        entityId: Parameters<UtilityScorer['score']>[1];
        evalCase: EvalCase;
        expectedFlag: keyof Omit<ReturnType<UtilityScorer['score']>, 'utilityScore'>;
      }> = [
        { status: 'resolved', entityId: ENTITY_A, evalCase: makeEvalCase('resolved', 'entity-opus-one'), expectedFlag: 'isCorrectResolve' },
        { status: 'resolved', entityId: ENTITY_B, evalCase: makeEvalCase('resolved', 'entity-opus-one'), expectedFlag: 'isWrongResolve' },
        { status: 'ambiguous', entityId: undefined, evalCase: makeEvalCase('ambiguous'), expectedFlag: 'isSafeAbstain' },
        { status: 'ambiguous', entityId: undefined, evalCase: makeEvalCase('resolved', 'entity-opus-one'), expectedFlag: 'isAvoidableAbstain' },
        // Over-resolve: engine resolved on a gold-ambiguous case → penalized as avoidable abstain.
        { status: 'resolved', entityId: ENTITY_A, evalCase: makeEvalCase('ambiguous'), expectedFlag: 'isAvoidableAbstain' },
      ];

      for (const tc of testCases) {
        const result = scorer.score(tc.status, tc.entityId, tc.evalCase);
        const flags = [result.isCorrectResolve, result.isWrongResolve, result.isSafeAbstain, result.isAvoidableAbstain];
        const trueFlags = flags.filter(Boolean).length;
        expect(trueFlags).toBe(1);
        expect(result[tc.expectedFlag]).toBe(true);
      }
    });

    it('failed status has all flags = false', () => {
      const result = scorer.score('failed', undefined, makeEvalCase('failed'));
      expect(result.isCorrectResolve).toBe(false);
      expect(result.isWrongResolve).toBe(false);
      expect(result.isSafeAbstain).toBe(false);
      expect(result.isAvoidableAbstain).toBe(false);
    });
  });
});
