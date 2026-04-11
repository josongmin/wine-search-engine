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
  legacyOverrides: Partial<CandidateEnvelope['legacyCandidate']> = {},
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
      retrievalFusionScore: fusionScore,
      matchedConstraints: [],
      retrievalTrace: { channels: ['sparse'], queryViews: [] },
      ...legacyOverrides,
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
    expect(result[0]!.mergedEnvelope.provenance).toEqual(c.provenance);
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

  it('builds a merged envelope with accumulated provenance propagated downstream', () => {
    const c1 = makeCandidate('e1', 0.5, {
      channels: ['sparse_bm25'],
      channelScores: [{ channel: 'sparse_bm25', rawScore: 0.5, rank: 3, rrfContribution: 0.01 }],
      matchedFilterConstraints: ['vintage:2020'],
      queryViewMatches: [{ viewName: 'strict', matchedText: 'opus one', channel: 'sparse_bm25' }],
      protectedInclusionReason: 'hard_constraint_compatible',
    });
    const c2 = makeCandidate('e1', 0.9, {
      channels: ['dense_semantic'],
      channelScores: [{ channel: 'dense_semantic', rawScore: 0.9, rank: 1, rrfContribution: 0.03 }],
      matchedFilterConstraints: ['region:napa'],
      anchorConditioned: true,
      protectedInclusionReason: 'known_item_lookup',
    });
    const [result] = accumulateEvidence([c1, c2]);

    expect(result?.mergedEnvelope.provenance.channels).toEqual(['sparse_bm25', 'dense_semantic']);
    expect(result?.mergedEnvelope.provenance.matchedFilterConstraints).toEqual([
      'vintage:2020',
      'region:napa',
    ]);
    expect(result?.mergedEnvelope.provenance.anchorConditioned).toBe(true);
    expect(result?.mergedEnvelope.provenance.protectedInclusionReason).toBe('known_item_lookup');
    expect(result?.mergedEnvelope.provenance.channelScores).toEqual([
      expect.objectContaining({ channel: 'sparse_bm25', rank: 3 }),
      expect.objectContaining({ channel: 'dense_semantic', rank: 1 }),
    ]);
    expect(result?.mergedEnvelope.legacyCandidate.retrievalProvenance).toEqual(
      result?.mergedEnvelope.provenance,
    );
    expect(result?.mergedEnvelope.legacyCandidate.matchedConstraints).toEqual([
      'vintage:2020',
      'region:napa',
    ]);
  });

  it('deduplicates repeated anchor_similarity values when merging provenance and trace outputs', () => {
    const c1 = makeCandidate('e1', 0.7, {
      channels: ['anchor_similarity'],
      channelScores: [{ channel: 'anchor_similarity', rawScore: 0.7, rank: 2, rrfContribution: 0.02 }],
      queryViewMatches: [{ viewName: 'strict', matchedText: 'sassicaia', channel: 'anchor_similarity' }],
      anchorConditioned: true,
    });
    const c2 = makeCandidate('e1', 0.9, {
      channels: ['anchor_similarity', 'anchor_similarity', 'dense_semantic'],
      channelScores: [
        { channel: 'anchor_similarity', rawScore: 0.9, rank: 1, rrfContribution: 0.03 },
        { channel: 'dense_semantic', rawScore: 0.5, rank: 4, rrfContribution: 0.01 },
      ],
      queryViewMatches: [{ viewName: 'strict', matchedText: 'sassicaia', channel: 'anchor_similarity' }],
      anchorConditioned: true,
    });

    const [result] = accumulateEvidence([c1, c2]);

    expect(result?.channels).toEqual(['anchor_similarity', 'dense_semantic']);
    expect(result?.mergedEnvelope.provenance.channels).toEqual(['anchor_similarity', 'dense_semantic']);
    expect(result?.mergedEnvelope.provenance.channelScores).toEqual([
      expect.objectContaining({ channel: 'anchor_similarity', rank: 1 }),
      expect.objectContaining({ channel: 'dense_semantic', rank: 4 }),
    ]);
    expect(result?.mergedEnvelope.provenance.queryViewMatches).toEqual([
      expect.objectContaining({ channel: 'anchor_similarity', viewName: 'strict' }),
    ]);
    expect(result?.mergedEnvelope.legacyCandidate.retrievalTrace.candidateSources).toEqual([
      'anchor_similarity',
      'dense_semantic',
    ]);
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

  // -------------------------------------------------------------------------
  // Regression: sparse-field best-value merge (grapeFamily / flavorProfiles /
  // regionHierarchy / priceBandNumeric lost when canonical lacks them)
  // -------------------------------------------------------------------------

  it('merges grapeFamily from non-canonical envelope when canonical lacks it', () => {
    // c2 has higher fusionScore → canonical; c1 has grapeFamily, c2 does not
    const c1 = makeCandidate(
      'e1',
      0.6,
      { channels: ['sparse_bm25'] },
      { grapeFamily: 'Pinot' },
    );
    const c2 = makeCandidate('e1', 0.9, {
      channels: ['dense_semantic'],
      channelScores: [{ channel: 'dense_semantic', rawScore: 0.9, rank: 1, rrfContribution: 0.9 }],
    });
    const [result] = accumulateEvidence([c1, c2]);
    expect(result?.canonicalEnvelope).toBe(c2);
    expect(result?.mergedEnvelope.legacyCandidate.grapeFamily).toBe('Pinot');
  });

  it('does not overwrite grapeFamily already on canonical with non-canonical value', () => {
    // Both have grapeFamily; canonical's value must win
    const c1 = makeCandidate(
      'e1',
      0.6,
      { channels: ['sparse_bm25'] },
      { grapeFamily: 'Merlot' },
    );
    const c2 = makeCandidate(
      'e1',
      0.9,
      {
        channels: ['dense_semantic'],
        channelScores: [{ channel: 'dense_semantic', rawScore: 0.9, rank: 1, rrfContribution: 0.9 }],
      },
      { grapeFamily: 'Cabernet' },
    );
    const [result] = accumulateEvidence([c1, c2]);
    expect(result?.canonicalEnvelope).toBe(c2);
    expect(result?.mergedEnvelope.legacyCandidate.grapeFamily).toBe('Cabernet');
  });

  it('merges flavorProfiles, regionHierarchy, and priceBandNumeric from non-canonical envelope', () => {
    const c1 = makeCandidate(
      'e1',
      0.5,
      { channels: ['sparse_bm25'] },
      {
        flavorProfiles: ['fruity', 'oaky'],
        regionHierarchy: ['France', 'Burgundy'],
        priceBandNumeric: 3,
      },
    );
    const c2 = makeCandidate('e1', 0.95, {
      channels: ['dense_semantic'],
      channelScores: [{ channel: 'dense_semantic', rawScore: 0.95, rank: 1, rrfContribution: 0.95 }],
    });
    const [result] = accumulateEvidence([c1, c2]);
    expect(result?.canonicalEnvelope).toBe(c2);
    expect(result?.mergedEnvelope.legacyCandidate.flavorProfiles).toEqual(['fruity', 'oaky']);
    expect(result?.mergedEnvelope.legacyCandidate.regionHierarchy).toEqual(['France', 'Burgundy']);
    expect(result?.mergedEnvelope.legacyCandidate.priceBandNumeric).toBe(3);
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
