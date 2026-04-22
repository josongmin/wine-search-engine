/**
 * E2 Epic tasks — tests for:
 *   E2-T1: conformal-config SSoT module
 *   E2-T2: LTR weights Zod validation on load (NaN/Infinity → uniform fallback)
 *   E2-T3: finalScore clamp after weighted sum
 *   E2-T4: default weights sum to 1.0
 *   E2-T5: feature-parity-hash serve-time mismatch warning
 *   E2-T6: featureNames index bound check throws on out-of-bounds
 */

import { describe, it, expect, vi } from 'vitest';
import {
  CONFORMAL_ALPHA,
  CONFORMAL_COVERAGE_TARGET,
} from '../../shared/config/conformal-config.js';
import {
  scoreDocument,
  validateAndNormalizeWeights,
  DEFAULT_HEURISTIC_WEIGHTS,
  LAMBDAMART_FEATURE_DIMENSION,
  LTR_FEATURE_SCHEMA_HASH,
  type RankingFeatures,
  type QueryClassWeights,
} from '../service/lambdamart-ranker.js';
import { checkFeatureParityAndWarn } from '../service/lambdamart-ranker.js';

// ── E2-T1: conformal-config SSoT ────────────────────────────────────────────

describe('E2-T1: conformal-config SSoT module', () => {
  it('CONFORMAL_ALPHA equals 0.3 (70% coverage target)', () => {
    expect(CONFORMAL_ALPHA).toBe(0.3);
  });

  it('CONFORMAL_COVERAGE_TARGET equals 1 - CONFORMAL_ALPHA', () => {
    expect(CONFORMAL_COVERAGE_TARGET).toBeCloseTo(1 - CONFORMAL_ALPHA, 10);
    expect(CONFORMAL_COVERAGE_TARGET).toBe(0.7);
  });

  it('resolver DEFAULT_ALPHA is derived from CONFORMAL_ALPHA SSoT', async () => {
    const { DEFAULT_ALPHA } = await import('../../resolver/service/resolver.js');
    expect(DEFAULT_ALPHA).toBe(CONFORMAL_ALPHA);
  });
});

// ── Shared fixture ───────────────────────────────────────────────────────────

const ZERO_FEATURES: RankingFeatures = {
  bm25Score: 0,
  semanticScore: 0,
  popularityScore: 0,
  recencyScore: 0,
  classMatchScore: 0,
  attributeMatchScore: 0,
  diversityScore: 0,
  multilingualScore: 0,
  entityPosteriorScore: 0,
  identityExactnessTierScore: 0,
  laneCorroborationScore: 0,
  laneDisagreementScore: 0,
  entityOnlyIndicator: 0,
  generalOnlyIndicator: 0,
};


function makeQueryClassWeights(weights: readonly number[]): QueryClassWeights {
  return {
    queryClass: 'test',
    featureSchemaHash: LTR_FEATURE_SCHEMA_HASH,
    weights,
    bias: 0,
    trainingExampleCount: 10,
    ndcg5ValidationScore: 0.8,
    trainedAt: new Date(),
  };
}

// ── E2-T2: LTR weights Zod validation — NaN/Infinity → uniform fallback ─────

describe('E2-T2: validateAndNormalizeWeights — NaN/Infinity fallback', () => {
  it('weights with NaN → falls back to uniform weights', () => {
    const badWeights = Array.from({ length: LAMBDAMART_FEATURE_DIMENSION }, (_, index) =>
      index === 0 ? Number.NaN : 0.5,
    );
    const result = validateAndNormalizeWeights(badWeights);
    expect(result.usedFallback).toBe(true);
    expect(result.weights).toHaveLength(LAMBDAMART_FEATURE_DIMENSION);
    for (const w of result.weights) {
      expect(w).toBeCloseTo(1 / LAMBDAMART_FEATURE_DIMENSION, 10);
    }
  });

  it('weights with Infinity → falls back to uniform weights', () => {
    const badWeights = Array.from({ length: LAMBDAMART_FEATURE_DIMENSION }, (_, index) =>
      index === 0 ? Number.POSITIVE_INFINITY : 0.25,
    );
    const result = validateAndNormalizeWeights(badWeights);
    expect(result.usedFallback).toBe(true);
  });

  it('weights with -Infinity → falls back to uniform weights', () => {
    const badWeights = Array.from({ length: LAMBDAMART_FEATURE_DIMENSION }, (_, index) =>
      index === 0 ? Number.NEGATIVE_INFINITY : 0.5,
    );
    const result = validateAndNormalizeWeights(badWeights);
    expect(result.usedFallback).toBe(true);
  });

  it('empty array → falls back to uniform weights', () => {
    const result = validateAndNormalizeWeights([]);
    expect(result.usedFallback).toBe(true);
  });

  it('valid finite weights → used as-is (no fallback)', () => {
    const goodWeights = Array.from({ length: LAMBDAMART_FEATURE_DIMENSION }, () => 0.5);
    const result = validateAndNormalizeWeights(goodWeights);
    expect(result.usedFallback).toBe(false);
    expect(result.weights).toEqual(goodWeights);
  });

  it('scoreDocument uses uniform fallback when weights contain NaN', () => {
    const badModel = makeQueryClassWeights(
      Array.from({ length: LAMBDAMART_FEATURE_DIMENSION }, (_, index) =>
        index === 0 ? Number.NaN : 0.5,
      ),
    );
    // Should not throw, returns finite score
    const score = scoreDocument(ZERO_FEATURES, badModel);
    expect(Number.isFinite(score)).toBe(true);
  });
});

// ── E2-T3: finalScore clamp after weighted sum ───────────────────────────────

describe('E2-T3: scoreDocument clamps finalScore to [0, 1]', () => {
  it('weightedSum > 1 → finalScore = 1.0', () => {
    // Very high features + weights = large score
    const highFeatures: RankingFeatures = {
      bm25Score: 1,
      semanticScore: 1,
      popularityScore: 1,
      recencyScore: 1,
      classMatchScore: 1,
      attributeMatchScore: 1,
      diversityScore: 1,
      multilingualScore: 1,
      entityPosteriorScore: 1,
      identityExactnessTierScore: 1,
      laneCorroborationScore: 1,
      laneDisagreementScore: 1,
      entityOnlyIndicator: 1,
      generalOnlyIndicator: 1,
    };
    const highBiasModel: QueryClassWeights = {
      queryClass: 'test',
      featureSchemaHash: LTR_FEATURE_SCHEMA_HASH,
      weights: Array.from({ length: LAMBDAMART_FEATURE_DIMENSION }, () => 1),
      bias: 5,
      trainingExampleCount: 1,
      ndcg5ValidationScore: 0,
      trainedAt: new Date(),
    };
    const score = scoreDocument(highFeatures, highBiasModel);
    expect(score).toBe(1.0);
  });

  it('weightedSum < 0 → finalScore = 0.0', () => {
    const negBiasModel: QueryClassWeights = {
      queryClass: 'test',
      featureSchemaHash: LTR_FEATURE_SCHEMA_HASH,
      weights: Array.from({ length: LAMBDAMART_FEATURE_DIMENSION }, () => -1),
      bias: -5,
      trainingExampleCount: 1,
      ndcg5ValidationScore: 0,
      trainedAt: new Date(),
    };
    const score = scoreDocument(ZERO_FEATURES, negBiasModel);
    // bias=-5 drives score well below 0
    expect(score).toBe(0.0);
  });

  it('weightedSum = 0.5 → finalScore = 0.5 (within bounds, no clamping)', () => {
    const neutralModel: QueryClassWeights = {
      queryClass: 'test',
      featureSchemaHash: LTR_FEATURE_SCHEMA_HASH,
      weights: Array.from({ length: LAMBDAMART_FEATURE_DIMENSION }, () => 0),
      bias: 0.5,
      trainingExampleCount: 1,
      ndcg5ValidationScore: 0,
      trainedAt: new Date(),
    };
    const score = scoreDocument(ZERO_FEATURES, neutralModel);
    expect(score).toBeCloseTo(0.5, 10);
  });
});

// ── E2-T4: default weights sum to 1.0 ───────────────────────────────────────

describe('E2-T4: DEFAULT_HEURISTIC_WEIGHTS sum to 1.0', () => {
  it('sum of default heuristic weights is within 1e-9 of 1.0', () => {
    const sum = DEFAULT_HEURISTIC_WEIGHTS.reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1.0)).toBeLessThan(1e-9);
  });

  it('DEFAULT_HEURISTIC_WEIGHTS has exactly one weight per live feature', () => {
    expect(DEFAULT_HEURISTIC_WEIGHTS).toHaveLength(LAMBDAMART_FEATURE_DIMENSION);
  });
});

// ── E2-T5: feature-parity-hash serve-time mismatch warning ─────────────────

describe('E2-T5: checkFeatureParityAndWarn logs warning on hash mismatch', () => {
  it('matching hashes → no warning logged', () => {
    const warnFn = vi.fn();
    const log = { warn: warnFn };
    checkFeatureParityAndWarn('matching-hash-abc', 'matching-hash-abc', log);
    expect(warnFn).not.toHaveBeenCalled();
  });

  it('mismatching featureSchemaHash → warning logged with both hashes', () => {
    const warnFn = vi.fn();
    const log = { warn: warnFn };
    checkFeatureParityAndWarn('old-hash-123', 'new-hash-456', log);
    expect(warnFn).toHaveBeenCalledTimes(1);
    const [ctx, msg] = warnFn.mock.calls[0] as [Record<string, unknown>, string];
    expect(ctx).toMatchObject({ modelHash: 'old-hash-123', currentHash: 'new-hash-456' });
    expect(msg).toContain('mismatch');
  });

  it('scoreDocument rejects stale featureSchemaHash instead of serving skewed scores', () => {
    const staleModel: QueryClassWeights = {
      queryClass: 'test',
      featureSchemaHash: 'stale-hash-v1',
      weights: Array.from({ length: LAMBDAMART_FEATURE_DIMENSION }, () => 0),
      bias: 0.5,
      trainingExampleCount: 1,
      ndcg5ValidationScore: 0,
      trainedAt: new Date(),
    };

    expect(() => scoreDocument(ZERO_FEATURES, staleModel)).toThrow(/feature schema mismatch/u);
  });
});

// ── E2-T6: featureNames index bound check ───────────────────────────────────

describe('E2-T6: trainLambdaMARTModel — featureNames out-of-bounds throws', () => {
  // The function enforces the live LambdaMART feature dimension at every in-range index.
  // There is no way to trigger the out-of-bounds via the public API without
  // bypassing the featureNames-length invariant. We test the guard via the
  // exported throwOnUndefinedFeatureName utility.
  it('throwOnUndefinedFeatureName with in-range index → does not throw', async () => {
    const { throwOnUndefinedFeatureName } = await import('../service/lambdamart-ranker.js');
    const names = Array.from({ length: LAMBDAMART_FEATURE_DIMENSION }, (_, index) => `f${index}`);
    expect(() => throwOnUndefinedFeatureName(names, 0)).not.toThrow();
    expect(() => throwOnUndefinedFeatureName(names, LAMBDAMART_FEATURE_DIMENSION - 1)).not.toThrow();
  });

  it('throwOnUndefinedFeatureName with out-of-range index → throws with clear message', async () => {
    const { throwOnUndefinedFeatureName } = await import('../service/lambdamart-ranker.js');
    const shortNames = ['a', 'b']; // fewer than LAMBDAMART_FEATURE_DIMENSION
    expect(() => throwOnUndefinedFeatureName(shortNames, 5)).toThrowError(
      /LambdaMART invariant.*featureNames\[5\].*undefined/,
    );
  });
});
