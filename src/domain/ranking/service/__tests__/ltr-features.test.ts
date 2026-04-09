import { describe, it, expect } from 'vitest';
import { extractLTRFeatures, LTR_FEATURE_NAMES } from '../ltr-features.js';
import { hashFeatureSchema, getCurrentFeatureSchemaHash } from '../feature-parity-hash.js';
import type { HybridCandidate } from '../../../retrieval/model/hybrid-candidate.js';
import type { NormalizedConstraint } from '../../../shared/types/index.js';
import { createEntityId } from '../../../shared/types/index.js';

const minimalCandidate: HybridCandidate = {
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

describe('extractLTRFeatures', () => {
  it('produces all 26 features', () => {
    const features = extractLTRFeatures({
      query: 'pinot noir',
      normalizedQuery: 'pinot noir',
      candidate: minimalCandidate,
      hardConstraints: [],
      softConstraints: [],
      degradationFlags: noDegradation,
    });
    const keys = Object.keys(features);
    expect(keys.length).toBe(LTR_FEATURE_NAMES.length);
    for (const name of LTR_FEATURE_NAMES) {
      expect(features).toHaveProperty(name);
    }
  });

  it('numeric features default to 0 when missing', () => {
    const f = extractLTRFeatures({
      query: 'q',
      normalizedQuery: 'q',
      candidate: minimalCandidate,
      hardConstraints: [],
      softConstraints: [],
      degradationFlags: noDegradation,
    });
    expect(f.bm25_score).toBe(0);
    expect(f.dense_score).toBe(0);
    expect(f.critic_score_normalized).toBe(0);
  });

  it('Korean query sets query_has_korean=1', () => {
    const f = extractLTRFeatures({
      query: '보르도 와인',
      normalizedQuery: 'bordeaux wine',
      candidate: minimalCandidate,
      hardConstraints: [],
      softConstraints: [],
      degradationFlags: noDegradation,
    });
    expect(f.query_has_korean).toBe(1);
  });

  it('degradation flags propagate', () => {
    const f = extractLTRFeatures({
      query: 'q',
      normalizedQuery: 'q',
      candidate: minimalCandidate,
      hardConstraints: [],
      softConstraints: [],
      degradationFlags: { dense: true, sparse: false, anchor: true },
    });
    expect(f.is_dense_degraded).toBe(1);
    expect(f.is_anchor_degraded).toBe(1);
    expect(f.is_sparse_degraded).toBe(0);
    expect(f.degraded_channel_count).toBe(2);
  });

  it('constraint match ratios are 0..1', () => {
    const candidateWithMatch = {
      ...minimalCandidate,
      matchedConstraints: ['region', 'wine_type'],
    } as HybridCandidate;
    const hard: NormalizedConstraint[] = [
      { attribute: 'region', operator: '=', value: 'Bordeaux', source_phrase: '보르도', confidence: 1, mapping_version: 'v1' },
      { attribute: 'wine_type', operator: '=', value: 'red', source_phrase: '레드', confidence: 1, mapping_version: 'v1' },
    ];
    const f = extractLTRFeatures({
      query: 'q',
      normalizedQuery: 'q',
      candidate: candidateWithMatch,
      hardConstraints: hard,
      softConstraints: [],
      degradationFlags: noDegradation,
    });
    expect(f.hard_constraint_match_ratio).toBe(1);
    expect(f.soft_constraint_match_ratio).toBe(0);
  });

  it('cross_channel_overlap counts active rank fields', () => {
    const multi = {
      ...minimalCandidate,
      sparseRank: 1,
      denseRank: 2,
      anchorRank: 3,
    } as HybridCandidate;
    const f = extractLTRFeatures({
      query: 'q',
      normalizedQuery: 'q',
      candidate: multi,
      hardConstraints: [],
      softConstraints: [],
      degradationFlags: noDegradation,
    });
    expect(f.cross_channel_overlap).toBe(3);
  });
});

describe('feature-parity-hash', () => {
  it('hash is deterministic across calls', () => {
    expect(getCurrentFeatureSchemaHash()).toBe(getCurrentFeatureSchemaHash());
  });

  it('hash is invariant to feature ordering', () => {
    const a = hashFeatureSchema(['x', 'y', 'z']);
    const b = hashFeatureSchema(['z', 'y', 'x']);
    expect(a).toBe(b);
  });

  it('renaming a feature changes the hash', () => {
    const a = hashFeatureSchema(['x', 'y', 'z']);
    const b = hashFeatureSchema(['x', 'y', 'w']);
    expect(a).not.toBe(b);
  });

  it('hash length is 16 chars', () => {
    expect(getCurrentFeatureSchemaHash()).toHaveLength(16);
  });
});
