import { describe, expect, it } from 'vitest';
import { buildTrainingExamples } from '../service/ltr-training-service.js';
import {
  LTR_FEATURE_DIMENSION,
  LTR_FEATURE_SCHEMA_HASH,
  rankingFeaturesToVector,
} from '../service/ltr-feature-extractor.js';
import type { EvalResult } from '../../evaluation/model/eval-result.js';
import type { EvalCase } from '../../evaluation/model/eval-case.js';

function makeEvalCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    caseId: 'case-1',
    query: 'opus one',
    queryClass: 'semantic_preference',
    expectedStatus: 'resolved',
    labelTier: 'gold',
    timestamp: new Date('2026-04-22T00:00:00.000Z'),
    sliceTags: [],
    ...overrides,
  };
}

function makeEvalResult(overrides: Partial<EvalResult> = {}): EvalResult {
  return {
    caseId: 'case-1',
    predictedStatus: 'resolved',
    decisionConfidence: 0.82,
    utilityScore: 0.9,
    isCorrectResolve: true,
    isWrongResolve: false,
    isSafeAbstain: false,
    isAvoidableAbstain: false,
    evidenceItems: [],
    latencyMs: 15,
    decisionSnapshot: {
      snapshot_id: 'search-snapshot:v1:test',
      model_versions: {},
      index_versions: {},
      policy_rule_version: 'ranker-policy-v2.0',
      threshold_profile_id: 'default-v1',
      planner_version: 'planner-v1',
      feature_flags: {},
      response_contract_version: 'search-response-v1',
    },
    ...overrides,
  };
}

describe('LTRTrainingService', () => {
  it('emits full-dimension pairwise examples from canonical score components', () => {
    const examples = buildTrainingExamples(
      [
        makeEvalResult({
          topResultScoreComponents: {
            semantic: 0.8,
            popularity: 0.7,
            attributeAlignment: 0.6,
            preferenceAlignment: 0.5,
            entityPosterior: 0.93,
            identityExactnessTier: 'exact',
            lanePresence: 'corroborated',
          },
        }),
      ],
      [makeEvalCase()],
    );

    expect(examples).toHaveLength(3);
    for (const example of examples) {
      expect(rankingFeaturesToVector(example.features1)).toHaveLength(LTR_FEATURE_DIMENSION);
      expect(rankingFeaturesToVector(example.features2)).toHaveLength(LTR_FEATURE_DIMENSION);
    }
    expect(examples[0]?.features1.entityPosteriorScore).toBe(0.93);
    expect(examples[0]?.features1.identityExactnessTierScore).toBe(1.0);
    expect(examples[0]?.features1.laneCorroborationScore).toBe(1.0);
    expect(examples[0]?.features1.laneDisagreementScore).toBe(0.0);
    expect(examples[0]?.features2.identityExactnessTierScore).toBe(1.0);
    expect(examples[0]?.features2.laneCorroborationScore).toBe(1.0);
    expect(examples[0]?.features2.laneDisagreementScore).toBe(0.0);
    expect(examples[0]?.features2.entityOnlyIndicator).toBe(0.0);
    expect(examples[0]?.features2.generalOnlyIndicator).toBe(0.0);
    expect(examples[0]?.features2.semanticScore).toBeCloseTo(0.56);
    expect(examples[0]?.features2.entityPosteriorScore).toBeCloseTo(0.651);
    expect(LTR_FEATURE_SCHEMA_HASH).toMatch(/^[0-9a-f]{16}$/u);
  });

  it('preserves dual-lane categorical states in synthetic negatives', () => {
    const examples = buildTrainingExamples(
      [
        makeEvalResult({
          topResultScoreComponents: {
            semantic: 0.9,
            popularity: 0.75,
            attributeAlignment: 0.65,
            preferenceAlignment: 0.55,
            entityPosterior: 0.81,
            identityExactnessTier: 'alias_exact',
            lanePresence: 'entity_only',
          },
        }),
      ],
      [makeEvalCase()],
    );

    expect(examples).toHaveLength(3);
    for (const example of examples) {
      expect(example.features2.identityExactnessTierScore).toBe(2 / 3);
      expect(example.features2.laneCorroborationScore).toBe(0.0);
      expect(example.features2.laneDisagreementScore).toBe(1.0);
      expect(example.features2.entityOnlyIndicator).toBe(1.0);
      expect(example.features2.generalOnlyIndicator).toBe(0.0);
    }

    expect(examples[0]?.features2.semanticScore).toBeCloseTo(0.63);
    expect(examples[1]?.features2.semanticScore).toBeCloseTo(0.36);
    expect(examples[2]?.features2.semanticScore).toBeCloseTo(0.09);
  });

  it('fails loudly when eval data omits canonical topResultScoreComponents', () => {
    expect(() =>
      buildTrainingExamples(
        [makeEvalResult()],
        [makeEvalCase()],
      ),
    ).toThrow(/topResultScoreComponents/u);
  });
});
