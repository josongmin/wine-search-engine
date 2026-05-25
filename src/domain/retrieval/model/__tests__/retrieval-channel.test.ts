import { describe, it, expect } from 'vitest';
import {
  RETRIEVAL_CHANNEL_CONSTANTS,
  RETRIEVAL_CHANNELS,
  isRetrievalChannel,
  toRetrievalChannel,
  preferCanonicalRetrievalChannelLabel,
  preferCanonicalRetrievalChannelLabels,
} from '../retrieval-channel.js';
import { PHASE_TO_CHANNEL as CASCADE_PHASE_TO_CHANNEL } from '../../service/cascade-router.js';

describe('RetrievalChannel vocabulary', () => {
  it('RETRIEVAL_CHANNEL_CONSTANTS mirrors RETRIEVAL_CHANNELS', () => {
    expect([...RETRIEVAL_CHANNEL_CONSTANTS]).toEqual([...RETRIEVAL_CHANNELS]);
  });

  it('contains all expected channels', () => {
    expect(RETRIEVAL_CHANNELS).toContain('sparse_bm25');
    expect(RETRIEVAL_CHANNELS).toContain('learned_sparse');
    expect(RETRIEVAL_CHANNELS).toContain('dense_semantic');
    expect(RETRIEVAL_CHANNELS).toContain('anchor_similarity');
    expect(RETRIEVAL_CHANNELS).toContain('relative_filter');
    expect(RETRIEVAL_CHANNELS).toContain('browse_producer');
    expect(RETRIEVAL_CHANNELS).toContain('browse_region');
    expect(RETRIEVAL_CHANNELS).toContain('compare_anchor');
  });

  it('isRetrievalChannel returns true for valid channels', () => {
    expect(isRetrievalChannel('sparse_bm25')).toBe(true);
    expect(isRetrievalChannel('dense_semantic')).toBe(true);
    expect(isRetrievalChannel('anchor_similarity')).toBe(true);
  });

  it('isRetrievalChannel returns false for unknown strings', () => {
    expect(isRetrievalChannel('sparse')).toBe(false);
    expect(isRetrievalChannel('dense')).toBe(false);
    expect(isRetrievalChannel('unknown')).toBe(false);
  });

  it('toRetrievalChannel coerces legacy sparse → sparse_bm25', () => {
    expect(toRetrievalChannel('sparse')).toBe('sparse_bm25');
  });

  it('toRetrievalChannel coerces legacy dense → dense_semantic', () => {
    expect(toRetrievalChannel('dense')).toBe('dense_semantic');
  });

  it('toRetrievalChannel coerces legacy anchor → anchor_similarity', () => {
    expect(toRetrievalChannel('anchor')).toBe('anchor_similarity');
  });

  it('toRetrievalChannel passes through valid channel unchanged', () => {
    expect(toRetrievalChannel('sparse_bm25')).toBe('sparse_bm25');
    expect(toRetrievalChannel('learned_sparse')).toBe('learned_sparse');
  });

  it('toRetrievalChannel rejects truly unknown strings', () => {
    expect(() => toRetrievalChannel('completely_unknown')).toThrow('Unknown retrieval channel');
  });

  it('preferCanonicalRetrievalChannelLabel preserves already-canonical channels', () => {
    expect(preferCanonicalRetrievalChannelLabel('anchor_similarity')).toBe('anchor_similarity');
    expect(preferCanonicalRetrievalChannelLabel('compare_anchor')).toBe('compare_anchor');
  });

  it('preferCanonicalRetrievalChannelLabel does not coerce unknown strings', () => {
    expect(preferCanonicalRetrievalChannelLabel('mystery_channel')).toBe('mystery_channel');
  });

  it('preferCanonicalRetrievalChannelLabels deduplicates repeated canonical values in order', () => {
    expect(
      preferCanonicalRetrievalChannelLabels([
        'anchor_similarity',
        'anchor_similarity',
        'dense_semantic',
      ]),
    ).toEqual(['anchor_similarity', 'dense_semantic']);
  });
});

describe('PHASE_TO_CHANNEL mapping', () => {
  it('maps each cascade phase to the canonical retrieval channel', () => {
    expect(CASCADE_PHASE_TO_CHANNEL.sparse).toBe('sparse_bm25');
    expect(CASCADE_PHASE_TO_CHANNEL.learned_sparse).toBe('learned_sparse');
    expect(CASCADE_PHASE_TO_CHANNEL.dense).toBe('dense_semantic');
    expect(CASCADE_PHASE_TO_CHANNEL.anchor_neighborhood).toBe('anchor_similarity');
    expect(CASCADE_PHASE_TO_CHANNEL.relative).toBe('relative_filter');
  });
});
