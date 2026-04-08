import { describe, it, expect } from 'vitest';
import { extractLTRFeatures, type LTRScoreComponents } from '../service/ltr-feature-extractor.js';

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
    // multilingualScore: 0.5 neutral when absent — missing alias data should not
    // penalise the candidate. Wines with confirmed non-Korean labels score 0.
    expect(features.multilingualScore).toBe(0.5);
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
