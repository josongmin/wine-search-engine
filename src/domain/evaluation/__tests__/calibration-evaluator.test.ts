import { describe, expect, it } from 'vitest';
import { CalibrationEvaluator } from '../service/calibration-evaluator.js';
import type { EvalResult } from '../model/eval-result.js';

function makeEvalResult(overrides: Partial<EvalResult> = {}): EvalResult {
  return {
    caseId: 'case-1',
    predictedStatus: 'resolved',
    decisionConfidence: 0.5,
    decisionConfidenceTrusted: true,
    utilityScore: 1,
    isCorrectResolve: true,
    isWrongResolve: false,
    isSafeAbstain: false,
    isAvoidableAbstain: false,
    evidenceItems: [],
    latencyMs: 5,
    decisionSnapshot: {
      snapshot_id: 'snap-1',
      model_versions: {},
      index_versions: {},
      policy_rule_version: '1',
      threshold_profile_id: 'default',
      planner_version: '1',
      feature_flags: {},
      response_contract_version: 'search_response_v1',
    },
    ...overrides,
  };
}

describe('CalibrationEvaluator', () => {
  it('excludes untrusted resolved scores from ECE', () => {
    const evaluator = new CalibrationEvaluator();
    const trustedOnly = [
      makeEvalResult({ caseId: 'trusted', decisionConfidence: 1, isCorrectResolve: true }),
    ];
    const mixed = [
      ...trustedOnly,
      makeEvalResult({
        caseId: 'untrusted',
        decisionConfidence: 0.51,
        decisionConfidenceTrusted: false,
        isCorrectResolve: true,
      }),
    ];

    expect(evaluator.computeECE(trustedOnly)).toBe(0);
    expect(evaluator.computeECE(mixed)).toBe(0);
  });

  it('excludes ambiguous and failed outcomes from reliability bins', () => {
    const evaluator = new CalibrationEvaluator();
    const reliability = evaluator.computeReliabilityDiagram([
      makeEvalResult({
        caseId: 'resolved',
        predictedStatus: 'resolved',
        decisionConfidence: 1,
        isCorrectResolve: true,
      }),
      makeEvalResult({
        caseId: 'ambiguous',
        predictedStatus: 'ambiguous',
        decisionConfidence: 0.6,
        isCorrectResolve: false,
      }),
      makeEvalResult({
        caseId: 'failed',
        predictedStatus: 'failed',
        decisionConfidence: 0,
        decisionConfidenceTrusted: false,
        isCorrectResolve: false,
      }),
    ]);

    const totalCount = reliability.reduce((sum, bin) => sum + bin.count, 0);
    expect(totalCount).toBe(1);
    const nonEmptyBin = reliability.find((bin) => bin.count === 1);
    expect(nonEmptyBin?.avgConfidence).toBe(1);
    expect(nonEmptyBin?.avgAccuracy).toBe(1);
  });
});
