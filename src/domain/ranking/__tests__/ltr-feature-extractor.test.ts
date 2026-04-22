import { describe, it, expect } from 'vitest';
import {
  extractLTRFeatures,
  extractExtendedLTRFeatures,
  LTR_FEATURE_DIMENSION,
  LTR_FEATURE_NAME_ORDER,
  LTR_FEATURE_SCHEMA_HASH,
  rankingFeaturesToVector,
  type LTRScoreComponents,
} from '../service/ltr-feature-extractor.js';

describe('extractLTRFeatures', () => {
  it('maps score components to ranking features correctly', () => {
    const scores: LTRScoreComponents = {
      semantic: 0.85,
      popularity: 0.6,
      attributeAlignment: 0.7,
      preferenceAlignment: 0.45,
      entityPosterior: 0.91,
      identityExactnessTier: 'alias_exact',
      lanePresence: 'entity_only',
    };

    const features = extractLTRFeatures(scores);

    // Real signals — 1:1 mapping from score components
    expect(features.semanticScore).toBe(0.85);
    expect(features.popularityScore).toBe(0.6);
    expect(features.attributeMatchScore).toBe(0.7);
    expect(features.classMatchScore).toBe(0.45);

    // No-data sentinels
    expect(features.bm25Score).toBe(0.0);      // permanently 0: Vespa doesn't expose per-candidate BM25
    expect(features.recencyScore).toBe(0.0);   // 0 = no vintage data; intentionally not neutral
    expect(features.diversityScore).toBe(0.0); // permanently 0: set-level, not per-candidate
    // multilingualScore: 0.0 when absent — matches the score-aggregator `?? 0` and
    // signal-computer explicit 0 for non-Korean queries. The prior 0.5 sentinel caused
    // train-serve skew: non-Korean production queries emit 0, but training data saw 0.5.
    expect(features.multilingualScore).toBe(0.0);
    expect(features.entityPosteriorScore).toBe(0.91);
    expect(features.identityExactnessTierScore).toBeCloseTo(2 / 3, 10);
    expect(features.laneCorroborationScore).toBe(0.0);
    expect(features.laneDisagreementScore).toBe(1.0);
    expect(features.entityOnlyIndicator).toBe(1.0);
    expect(features.generalOnlyIndicator).toBe(0.0);
  });

  it('handles zero scores without producing NaN', () => {
    const scores: LTRScoreComponents = {
      semantic: 0,
      popularity: 0,
      attributeAlignment: 0,
      preferenceAlignment: 0,
    };

    const features = extractLTRFeatures(scores);

    expect(features.semanticScore).toBe(0);
    expect(features.popularityScore).toBe(0);
    expect(features.attributeMatchScore).toBe(0);
    expect(features.classMatchScore).toBe(0);
    expect(Number.isNaN(features.bm25Score)).toBe(false);
  });

  it('handles high scores at boundary', () => {
    const scores: LTRScoreComponents = {
      semantic: 1.0,
      popularity: 1.0,
      attributeAlignment: 1.0,
      preferenceAlignment: 1.0,
    };

    const features = extractLTRFeatures(scores);

    expect(features.semanticScore).toBe(1.0);
    expect(features.popularityScore).toBe(1.0);
    expect(features.attributeMatchScore).toBe(1.0);
    expect(features.classMatchScore).toBe(1.0);
  });

  it('returns the full dual-lane-aware feature schema in canonical order', () => {
    const scores: LTRScoreComponents = {
      semantic: 0.5,
      popularity: 0.5,
      attributeAlignment: 0.5,
      preferenceAlignment: 0.5,
    };

    const features = extractLTRFeatures(scores);
    const keys = Object.keys(features);

    expect(keys).toHaveLength(LTR_FEATURE_DIMENSION);
    expect(keys).toEqual([...LTR_FEATURE_NAME_ORDER]);
  });

  it('vectorizes features with the extractor-defined order', () => {
    const features = extractLTRFeatures({
      semantic: 0.8,
      popularity: 0.7,
      attributeAlignment: 0.6,
      preferenceAlignment: 0.5,
      entityPosterior: 0.95,
      identityExactnessTier: 'exact',
      lanePresence: 'corroborated',
    });

    const vector = rankingFeaturesToVector(features);

    expect(vector).toHaveLength(LTR_FEATURE_DIMENSION);
    expect(vector).toEqual([
      0.0,
      0.8,
      0.7,
      0.0,
      0.5,
      0.6,
      0.0,
      0.0,
      0.95,
      1.0,
      1.0,
      0.0,
      0.0,
      0.0,
    ]);
  });

  it('publishes a deterministic schema hash for the canonical feature order', () => {
    expect(LTR_FEATURE_SCHEMA_HASH).toHaveLength(16);
    expect(LTR_FEATURE_SCHEMA_HASH).toMatch(/^[0-9a-f]{16}$/u);
  });

  it('inference and training produce identical features from same scores', () => {
    // This test documents the core invariant: the SAME function is used
    // by both inference (search.usecase.ts) and training (ltr-training-service.ts).
    // Calling it twice with the same input must produce the same output.
    const scores: LTRScoreComponents = {
      semantic: 0.72,
      popularity: 0.43,
      attributeAlignment: 0.91,
      preferenceAlignment: 0.38,
    };

    const inferenceFeatures = extractLTRFeatures(scores);
    const trainingFeatures = extractLTRFeatures(scores);

    expect(inferenceFeatures).toEqual(trainingFeatures);
  });
});

// BUG-13: extractExtendedLTRFeatures() 테스트 전무
// criticScore와 producerPrestige의 default 처리가 비대칭 (0.0 vs 0.5).
// 잘못된 default는 train-serve skew를 유발한다.
describe('extractExtendedLTRFeatures (BUG-13)', () => {
  it('includes all base dual-lane features plus criticScoreFeature, producerPrestigeFeature, and 4 target-type 1-hot fields', () => {
    const scores: LTRScoreComponents = {
      semantic: 0.8,
      popularity: 0.5,
      attributeAlignment: 0.6,
      preferenceAlignment: 0.4,
      criticScore: 0.9,
      producerPrestige: 0.7,
    };
    const features = extractExtendedLTRFeatures(scores);
    expect(Object.keys(features)).toHaveLength(LTR_FEATURE_DIMENSION + 6);
    expect(features.criticScoreFeature).toBe(0.9);
    expect(features.producerPrestigeFeature).toBe(0.7);
    // No targetType supplied → all 1-hot zeros
    expect(features.isTargetWine).toBe(0);
    expect(features.isTargetProducer).toBe(0);
    expect(features.isTargetRegion).toBe(0);
    expect(features.isTargetStyle).toBe(0);
  });

  it('criticScore undefined → 0.0 default (not 0.5 — 0 means no critic data)', () => {
    const scores: LTRScoreComponents = {
      semantic: 0.5, popularity: 0.5, attributeAlignment: 0.5, preferenceAlignment: 0.5,
    };
    const features = extractExtendedLTRFeatures(scores);
    expect(features.criticScoreFeature).toBe(0.0);
  });

  it('producerPrestige undefined in LTR scores → 0.0 (do not fabricate neutral at extractor layer; SignalComputer handles neutrality upstream)', () => {
    const scores: LTRScoreComponents = {
      semantic: 0.5, popularity: 0.5, attributeAlignment: 0.5, preferenceAlignment: 0.5,
    };
    const features = extractExtendedLTRFeatures(scores);
    // LTR extractor does not fabricate; 0.5 neutrality is applied upstream in SignalComputer.
    expect(features.producerPrestigeFeature).toBe(0);
  });

  it('criticScore=0 (explicit zero) is preserved, not replaced by default', () => {
    // Rule 26: value ?? default must not replace legitimate 0
    const scores: LTRScoreComponents = {
      semantic: 0.5, popularity: 0.5, attributeAlignment: 0.5, preferenceAlignment: 0.5,
      criticScore: 0,
    };
    const features = extractExtendedLTRFeatures(scores);
    expect(features.criticScoreFeature).toBe(0);
  });

  it('producerPrestige=0 (explicit zero) is preserved, not replaced by default', () => {
    const scores: LTRScoreComponents = {
      semantic: 0.5, popularity: 0.5, attributeAlignment: 0.5, preferenceAlignment: 0.5,
      producerPrestige: 0,
    };
    const features = extractExtendedLTRFeatures(scores);
    expect(features.producerPrestigeFeature).toBe(0);
  });

  it('base features are identical to extractLTRFeatures output', () => {
    const scores: LTRScoreComponents = {
      semantic: 0.72, popularity: 0.43, attributeAlignment: 0.91, preferenceAlignment: 0.38,
      criticScore: 0.85, producerPrestige: 0.6,
    };
    const base = extractLTRFeatures(scores);
    const extended = extractExtendedLTRFeatures(scores);
    // All base fields must match
    for (const key of Object.keys(base) as (keyof typeof base)[]) {
      expect(extended[key]).toBe(base[key]);
    }
  });

  it('no NaN produced for any undefined optional field', () => {
    const scores: LTRScoreComponents = {
      semantic: 0.5, popularity: 0.5, attributeAlignment: 0.5, preferenceAlignment: 0.5,
    };
    const features = extractExtendedLTRFeatures(scores);
    for (const [key, val] of Object.entries(features)) {
      expect(Number.isNaN(val), `${key} should not be NaN`).toBe(false);
    }
  });

  // IDX-06: preferenceAlignment is wired (not dead code) but always returns 0.5 (neutral)
  // because user history is not yet connected. Scoring formula is ready; data source is missing.
  it.todo('IDX-06: preferenceAlignment always 0.5 — needs user history wiring (Epic-18 click pipeline)');
});
