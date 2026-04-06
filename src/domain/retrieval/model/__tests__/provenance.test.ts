import { describe, it, expect } from 'vitest';
import {
  PROVENANCE_CHANNELS,
  PROVENANCE_QUERY_VIEWS,
  PROVENANCE_PROTECTED_REASONS,
  isProvenanceChannel,
  isProvenanceQueryView,
} from '../provenance.js';
import type { EvalProvenanceSlice, ProvenanceChannel } from '../provenance.js';

describe('PROVENANCE_CHANNELS', () => {
  it('contains all expected channels', () => {
    const expected: ProvenanceChannel[] = [
      'sparse_bm25',
      'dense_semantic',
      'dense_anchor',
      'learned_sparse',
      'anchor_similarity',
      'relative_filter',
      'browse_producer',
      'browse_region',
      'compare_anchor',
    ];

    expect(PROVENANCE_CHANNELS).toHaveLength(expected.length);
    for (const channel of expected) {
      expect(PROVENANCE_CHANNELS).toContain(channel);
    }
  });
});

describe('PROVENANCE_QUERY_VIEWS', () => {
  it('contains all expected views', () => {
    const expected = [
      'raw',
      'strict',
      'accentless',
      'compact',
      'phonetic_compact',
      'vintage_canonicalized',
      'vintage_stripped',
      'transliterated',
    ] as const;

    expect(PROVENANCE_QUERY_VIEWS).toHaveLength(expected.length);
    for (const view of expected) {
      expect(PROVENANCE_QUERY_VIEWS).toContain(view);
    }
  });
});

describe('isProvenanceChannel', () => {
  it('returns true for valid channel strings', () => {
    for (const channel of PROVENANCE_CHANNELS) {
      expect(isProvenanceChannel(channel)).toBe(true);
    }
  });

  it('returns false for invalid channel strings', () => {
    expect(isProvenanceChannel('bm25')).toBe(false);
    expect(isProvenanceChannel('dense')).toBe(false);
    expect(isProvenanceChannel('')).toBe(false);
    expect(isProvenanceChannel('SPARSE_BM25')).toBe(false);
    expect(isProvenanceChannel('unknown')).toBe(false);
  });
});

describe('isProvenanceQueryView', () => {
  it('returns true for valid query view strings', () => {
    for (const view of PROVENANCE_QUERY_VIEWS) {
      expect(isProvenanceQueryView(view)).toBe(true);
    }
  });

  it('returns false for invalid query view strings', () => {
    expect(isProvenanceQueryView('fuzzy')).toBe(false);
    expect(isProvenanceQueryView('')).toBe(false);
    expect(isProvenanceQueryView('STRICT')).toBe(false);
    expect(isProvenanceQueryView('normalized')).toBe(false);
  });
});

describe('EvalProvenanceSlice', () => {
  it('can be constructed with minimal required fields', () => {
    const slice: EvalProvenanceSlice = {
      queryId: 'q-001',
      candidateEntityId: 'wine-001',
      channels: ['sparse_bm25'],
      topChannel: 'sparse_bm25',
      anchorConditioned: false,
      protected: false,
      fusionScore: 0.016393,
      rank: 1,
    };

    expect(slice.queryId).toBe('q-001');
    expect(slice.candidateEntityId).toBe('wine-001');
    expect(slice.channels).toHaveLength(1);
    expect(slice.topChannel).toBe('sparse_bm25');
    expect(slice.anchorConditioned).toBe(false);
    expect(slice.protected).toBe(false);
    expect(slice.fusionScore).toBeCloseTo(0.016393);
    expect(slice.rank).toBe(1);
    // optional field should be absent when not provided
    expect(slice.protectedReason).toBeUndefined();
  });

  it('can be constructed with optional protectedReason', () => {
    const slice: EvalProvenanceSlice = {
      queryId: 'q-002',
      candidateEntityId: 'wine-002',
      channels: ['sparse_bm25', 'dense_semantic'],
      topChannel: 'dense_semantic',
      anchorConditioned: true,
      protected: true,
      protectedReason: 'exact_alias_match',
      fusionScore: 0.032786,
      rank: 1,
    };

    expect(slice.protected).toBe(true);
    expect(slice.protectedReason).toBe('exact_alias_match');
    expect(PROVENANCE_PROTECTED_REASONS).toContain(slice.protectedReason);
  });
});
