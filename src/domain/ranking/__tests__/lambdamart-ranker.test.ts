import { describe, it, expect } from 'vitest';
import {
  trainLambdaMARTModel,
  LAMBDAMART_FEATURE_DIMENSION,
  LTR_FEATURE_SCHEMA_HASH,
} from '../service/lambdamart-ranker.js';
import type { LambdaMARTExample } from '../service/lambdamart-ranker.js';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const FEATURES_A = {
  bm25Score: 0.8,
  semanticScore: 0.7,
  popularityScore: 0.6,
  recencyScore: 0.5,
  classMatchScore: 0.9,
  attributeMatchScore: 0.4,
  diversityScore: 0.3,
  multilingualScore: 0.2,
  entityPosteriorScore: 0.95,
  identityExactnessTierScore: 1.0,
  laneCorroborationScore: 1.0,
  laneDisagreementScore: 0.0,
  entityOnlyIndicator: 0.0,
  generalOnlyIndicator: 0.0,
} as const;

const FEATURES_B = {
  bm25Score: 0.3,
  semanticScore: 0.4,
  popularityScore: 0.5,
  recencyScore: 0.6,
  classMatchScore: 0.2,
  attributeMatchScore: 0.7,
  diversityScore: 0.8,
  multilingualScore: 0.9,
  entityPosteriorScore: 0.1,
  identityExactnessTierScore: 0.0,
  laneCorroborationScore: 0.0,
  laneDisagreementScore: 1.0,
  entityOnlyIndicator: 0.0,
  generalOnlyIndicator: 1.0,
} as const;

function makeExamples(queryClass: string, count: number): LambdaMARTExample[] {
  const examples: LambdaMARTExample[] = [];
  for (let i = 0; i < count; i++) {
    examples.push({
      query: `query-${i}`,
      queryClass,
      label1: (i % 4) as 0 | 1 | 2 | 3,
      features1: FEATURES_A,
      label2: ((i + 1) % 4) as 0 | 1 | 2 | 3,
      features2: FEATURES_B,
    });
  }
  return examples;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('trainLambdaMARTModel', () => {
  it('produces identical weights on repeated calls with the same input (deterministic training)', () => {
    const examples = makeExamples('exact_entity', 20);

    const result1 = trainLambdaMARTModel(examples, 'exact_entity');
    const result2 = trainLambdaMARTModel(examples, 'exact_entity');

    expect(result1.weights).toEqual(result2.weights);
    expect(result1.bias).toBe(result2.bias);
    expect(result1.ndcg5ValidationScore).toBe(result2.ndcg5ValidationScore);
    expect(result1.featureSchemaHash).toBe(LTR_FEATURE_SCHEMA_HASH);
  });

  it('produces different weights for different query classes (class-specific seeding)', () => {
    const examples = [
      ...makeExamples('exact_entity', 15),
      ...makeExamples('semantic_preference', 15),
    ];

    const exactWeights = trainLambdaMARTModel(examples, 'exact_entity');
    const semanticWeights = trainLambdaMARTModel(examples, 'semantic_preference');

    // Different query classes should produce different model weights
    expect(exactWeights.weights).not.toEqual(semanticWeights.weights);
  });

  it('returns default uniform weights when no examples exist for the class', () => {
    const result = trainLambdaMARTModel([], 'missing_class');

    expect(result.trainingExampleCount).toBe(0);
    expect(result.weights).toHaveLength(LAMBDAMART_FEATURE_DIMENSION);
    expect(result.featureSchemaHash).toBe(LTR_FEATURE_SCHEMA_HASH);
    for (const w of result.weights) {
      expect(w).toBeCloseTo(1 / LAMBDAMART_FEATURE_DIMENSION, 10);
    }
  });
});
