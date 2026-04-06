import { describe, it, expect } from 'vitest';
import { accumulateEvidence } from '../evidence-accumulator.js';
import type { CandidateEnvelope } from '../../model/candidate-envelope.js';

// ---------------------------------------------------------------------------
// Fixture factory
// ---------------------------------------------------------------------------

function makeCandidate(
  entityId: string,
  fusionScore: number,
  overrides: Partial<CandidateEnvelope['provenance']> = {},
): CandidateEnvelope {
  return {
    entityId,
    provenance: {
      channels: ['sparse_bm25'],
      channelScores: [{ channel: 'sparse_bm25', rawScore: fusionScore, rank: 1, rrfContribution: fusionScore }],
      queryViewMatches: [],
      anchorConditioned: false,
      matchedFilterConstraints: [],
      fusionProfile: 'default',
      fusionScore,
      ...overrides,
    },
    legacyCandidate: {
      entityId,
      bm25Score: fusionScore,
      semanticScore: 0,
      fusedScore: fusionScore,
      retrievalTrace: { channels: ['sparse'], queryViews: [] },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('accumulateEvidence', () => {
  it('returns empty for empty input', () => {
    expect(accumulateEvidence([])).toHaveLength(0);
  });

  it('passes through single candidate', () => {
    const c = makeCandidate('e1', 0.8);
    const result = accumulateEvidence([c]);
    expect(result).toHaveLength(1);
    expect(result[0]!.entityId).toBe('e1');
    expect(result[0]!.bestFusionScore).toBe(0.8);
    expect(result[0]!.canonicalEnvelope).toBe(c);
  });

  it('merges two contributions for same entity, picks best fusionScore', () => {
    const c1 = makeCandidate('e1', 0.6, { channels: ['sparse_bm25'] });
    const c2 = makeCandidate('e1', 0.9, {
      channels: ['dense_semantic'],
      channelScores: [{ channel: 'dense_semantic', rawScore: 0.9, rank: 2, rrfContribution: 0.9 }],
    });
    const result = accumulateEvidence([c1, c2]);
    expect(result).toHaveLength(1);
    expect(result[0]!.bestFusionScore).toBe(0.9);
    expect(result[0]!.channels).toContain('sparse_bm25');
    expect(result[0]!.channels).toContain('dense_semantic');
    expect(result[0]!.canonicalEnvelope).toBe(c2);
  });

  it('deduplicates channels in merged set', () => {
    const c1 = makeCandidate('e1', 0.5, { channels: ['sparse_bm25'] });
    const c2 = makeCandidate('e1', 0.7, { channels: ['sparse_bm25', 'dense_semantic'] });
    const result = accumulateEvidence([c1, c2]);
    const channels = result[0]!.channels;
    const sparseCount = channels.filter((ch) => ch === 'sparse_bm25').length;
    expect(sparseCount).toBe(1); // no duplicates
  });

  it('unions matched filter constraints across contributions', () => {
    const c1 = makeCandidate('e1', 0.5, { matchedFilterConstraints: ['vintage:2020'] });
    const c2 = makeCandidate('e1', 0.7, { matchedFilterConstraints: ['region:bordeaux'] });
    const result = accumulateEvidence([c1, c2]);
    expect(result[0]!.matchedFilterConstraints).toContain('vintage:2020');
    expect(result[0]!.matchedFilterConstraints).toContain('region:bordeaux');
  });

  it('sets anchorConditioned true if any contribution is conditioned', () => {
    const c1 = makeCandidate('e1', 0.5, { anchorConditioned: false });
    const c2 = makeCandidate('e1', 0.7, { anchorConditioned: true });
    const result = accumulateEvidence([c1, c2]);
    expect(result[0]!.anchorConditioned).toBe(true);
  });

  it('tracks best (lowest) rank per channel', () => {
    const c1 = makeCandidate('e1', 0.5, {
      channels: ['sparse_bm25'],
      channelScores: [{ channel: 'sparse_bm25', rawScore: 0.5, rank: 3, rrfContribution: 0.5 }],
    });
    const c2 = makeCandidate('e1', 0.7, {
      channels: ['sparse_bm25'],
      channelScores: [{ channel: 'sparse_bm25', rawScore: 0.7, rank: 1, rrfContribution: 0.7 }],
    });
    const result = accumulateEvidence([c1, c2]);
    expect(result[0]!.bestRankPerChannel['sparse_bm25']).toBe(1);
  });

  it('sorts output by bestFusionScore descending', () => {
    const candidates = [
      makeCandidate('e3', 0.3),
      makeCandidate('e1', 0.9),
      makeCandidate('e2', 0.6),
    ];
    const result = accumulateEvidence(candidates);
    const scores = result.map((r) => r.bestFusionScore);
    expect(scores).toEqual([0.9, 0.6, 0.3]);
  });

  it('handles multiple distinct entities', () => {
    const candidates = [
      makeCandidate('e1', 0.9),
      makeCandidate('e2', 0.8),
      makeCandidate('e1', 0.5), // duplicate e1
      makeCandidate('e3', 0.7),
    ];
    const result = accumulateEvidence(candidates);
    expect(result).toHaveLength(3);
    const ids = result.map((r) => r.entityId);
    expect(ids).toContain('e1');
    expect(ids).toContain('e2');
    expect(ids).toContain('e3');
  });
});
