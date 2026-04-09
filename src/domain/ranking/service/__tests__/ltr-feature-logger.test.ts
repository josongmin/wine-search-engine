import { describe, it, expect } from 'vitest';
import { extractFeatureBatch, serializeBatchToNdjson } from '../ltr-feature-logger.js';
import type { HybridCandidate } from '../../../retrieval/model/hybrid-candidate.js';
import { createEntityId } from '../../../shared/types/index.js';

const minimal: HybridCandidate = {
  entityId: createEntityId('w-1'),
  retrievalFusionScore: 0.5,
  retrievalTrace: {
    candidateSources: [],
    retrievalProfile: 'default',
    lexicalQueriesUsed: [],
    semanticQueriesUsed: [],
    filtersApplied: [],
    skippedPhases: [],
  },
  matchedConstraints: [],
} as unknown as HybridCandidate;

const noDegradation = { dense: false, sparse: false, anchor: false } as const;

describe('extractFeatureBatch', () => {
  it('empty candidates → empty batch', () => {
    const batch = extractFeatureBatch({
      queryId: 'q1',
      query: 'pinot noir',
      normalizedQuery: 'pinot noir',
      candidates: [],
      hardConstraints: [],
      softConstraints: [],
      degradationFlags: noDegradation,
    });
    expect(batch.queryId).toBe('q1');
    expect(batch.entries).toHaveLength(0);
  });

  it('single candidate → 1 entry with all 26 features', () => {
    const batch = extractFeatureBatch({
      queryId: 'q1',
      query: 'q',
      normalizedQuery: 'q',
      candidates: [minimal],
      hardConstraints: [],
      softConstraints: [],
      degradationFlags: noDegradation,
    });
    expect(batch.entries).toHaveLength(1);
    const entry = batch.entries[0]!;
    expect(entry.queryId).toBe('q1');
    expect(entry.entityId).toBe('w-1');
    expect(typeof entry.features.bm25_score).toBe('number');
    expect(typeof entry.features.fusion_score).toBe('number');
  });

  it('multiple candidates → entries match candidate count', () => {
    const candidates = [minimal, minimal, minimal];
    const batch = extractFeatureBatch({
      queryId: 'q1',
      query: 'q',
      normalizedQuery: 'q',
      candidates,
      hardConstraints: [],
      softConstraints: [],
      degradationFlags: noDegradation,
    });
    expect(batch.entries).toHaveLength(3);
  });

  it('all entries share the same timestamp within the batch', () => {
    const candidates = [minimal, minimal];
    const batch = extractFeatureBatch({
      queryId: 'q1',
      query: 'q',
      normalizedQuery: 'q',
      candidates,
      hardConstraints: [],
      softConstraints: [],
      degradationFlags: noDegradation,
    });
    expect(batch.entries[0]!.timestamp).toBe(batch.entries[1]!.timestamp);
  });
});

describe('serializeBatchToNdjson', () => {
  it('serializes each entry as one line of JSON', () => {
    const batch = extractFeatureBatch({
      queryId: 'q1',
      query: 'q',
      normalizedQuery: 'q',
      candidates: [minimal, minimal],
      hardConstraints: [],
      softConstraints: [],
      degradationFlags: noDegradation,
    });
    const ndjson = serializeBatchToNdjson(batch);
    const lines = ndjson.split('\n');
    expect(lines).toHaveLength(2);
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
  });

  it('empty batch → empty string', () => {
    const batch = extractFeatureBatch({
      queryId: 'q1',
      query: 'q',
      normalizedQuery: 'q',
      candidates: [],
      hardConstraints: [],
      softConstraints: [],
      degradationFlags: noDegradation,
    });
    expect(serializeBatchToNdjson(batch)).toBe('');
  });

  it('candidate with NaN fusion field → feature defaults to 0 (safeNumber guard)', () => {
    // safeNumber() in ltr-features should clamp NaN/Infinity to the
    // fallback value (0 for additive features). Verify both fusionRrfTotal
    // and the deprecated retrievalFusionScore are NaN-safe.
    const nanCandidate = {
      ...minimal,
      fusionRrfTotal: Number.NaN,
      retrievalFusionScore: Number.POSITIVE_INFINITY,
    } as unknown as typeof minimal;
    const batch = extractFeatureBatch({
      queryId: 'q1',
      query: 'q',
      normalizedQuery: 'q',
      candidates: [nanCandidate],
      hardConstraints: [],
      softConstraints: [],
      degradationFlags: noDegradation,
    });
    expect(batch.entries).toHaveLength(1);
    const features = batch.entries[0]!.features;
    expect(Number.isFinite(features.fusion_score)).toBe(true);
    expect(features.fusion_score).toBe(0);
  });
});
