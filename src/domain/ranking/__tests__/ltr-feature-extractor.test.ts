import { describe, it, expect } from 'vitest';
import {
  extractLTRFeatures,
  extractExtendedLTRFeatures,
  type LTRScoreComponents,
} from '../service/ltr-feature-extractor.js';

describe('extractLTRFeatures', () => {
  it('maps score components to ranking features correctly', () => {
    const scores: LTRScoreComponents = {
      semantic: 0.85,
      popularity: 0.6,
      attributeAlignment: 0.7,
      preferenceAlignment: 0.45,
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

  it('returns exactly 8 feature fields', () => {
    const scores: LTRScoreComponents = {
      semantic: 0.5,
      popularity: 0.5,
      attributeAlignment: 0.5,
      preferenceAlignment: 0.5,
    };

    const features = extractLTRFeatures(scores);
    const keys = Object.keys(features);

    expect(keys).toHaveLength(8);
    expect(keys).toContain('bm25Score');
    expect(keys).toContain('semanticScore');
    expect(keys).toContain('popularityScore');
    expect(keys).toContain('recencyScore');
    expect(keys).toContain('classMatchScore');
    expect(keys).toContain('attributeMatchScore');
    expect(keys).toContain('diversityScore');
    expect(keys).toContain('multilingualScore');
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
  it('includes all 8 base features plus criticScoreFeature and producerPrestigeFeature', () => {
    const scores: LTRScoreComponents = {
      semantic: 0.8,
      popularity: 0.5,
      attributeAlignment: 0.6,
      preferenceAlignment: 0.4,
      criticScore: 0.9,
      producerPrestige: 0.7,
    };
    const features = extractExtendedLTRFeatures(scores);
    expect(Object.keys(features)).toHaveLength(10);
    expect(features.criticScoreFeature).toBe(0.9);
    expect(features.producerPrestigeFeature).toBe(0.7);
  });

  it('criticScore undefined → 0.0 default (not 0.5 — 0 means no critic data)', () => {
    const scores: LTRScoreComponents = {
      semantic: 0.5, popularity: 0.5, attributeAlignment: 0.5, preferenceAlignment: 0.5,
    };
    const features = extractExtendedLTRFeatures(scores);
    expect(features.criticScoreFeature).toBe(0.0);
  });

  it('producerPrestige undefined → 0.5 default (neutral, not 0 — absence is not low prestige)', () => {
    const scores: LTRScoreComponents = {
      semantic: 0.5, popularity: 0.5, attributeAlignment: 0.5, preferenceAlignment: 0.5,
    };
    const features = extractExtendedLTRFeatures(scores);
    expect(features.producerPrestigeFeature).toBe(0.5);
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
