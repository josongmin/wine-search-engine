import { describe, it, expect } from 'vitest';
import type {
  CandidateProvenance,
  CandidateEnvelope,
  ChannelScoreEvidence,
} from '../candidate-envelope.js';
import type { HybridCandidate } from '../hybrid-candidate.js';
import type { RetrievalTrace } from '../retrieval-trace.js';
import { isProvenanceChannel, isProvenanceQueryView } from '../provenance.js';
import { createEntityId } from '../../../shared/types/entity-id.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTrace(): RetrievalTrace {
  return {
    retrievalProfile: 'fusion',
    lexicalQueriesUsed: [],
    semanticQueriesUsed: [],
    filtersApplied: [],
    candidateSources: ['sparse'],
  };
}

function makeHybridCandidate(entityId: string): HybridCandidate {
  return {
    entityId: createEntityId(entityId),
    fusionRrfTotal: 0.5,
    matchedConstraints: [],
    retrievalTrace: makeTrace(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CandidateProvenance', () => {
  it('correctly represents a single-channel candidate (sparse only)', () => {
    const provenance: CandidateProvenance = {
      channels: ['sparse_bm25'],
      channelScores: [
        {
          channel: 'sparse_bm25',
          rawScore: 12.4,
          rank: 1,
          rrfContribution: 0.016393,
        },
      ],
      queryViewMatches: [
        {
          viewName: 'strict',
          matchedText: 'Opus One 2018',
          channel: 'sparse_bm25',
        },
      ],
      anchorConditioned: false,
      matchedFilterConstraints: [],
      fusionProfile: 'hybrid-default',
      fusionScore: 0.016393,
    };

    expect(provenance.channels).toHaveLength(1);
    expect(provenance.channels[0]).toBe('sparse_bm25');
    expect(provenance.anchorConditioned).toBe(false);
    expect(provenance.channelScores[0]?.channel).toBe('sparse_bm25');
    expect(provenance.channelScores[0]?.rrfContribution).toBeCloseTo(0.016393);
    expect(provenance.fusionScore).toBeCloseTo(0.016393);
    // optional fields should be absent
    expect(provenance.failedHardConstraints).toBeUndefined();
    expect(provenance.protectedInclusionReason).toBeUndefined();
  });

  it('correctly represents a multi-channel candidate (sparse + dense + anchor)', () => {
    const sparseEvidence: ChannelScoreEvidence = {
      channel: 'sparse_bm25',
      rawScore: 10.2,
      rank: 3,
      rrfContribution: 0.015873,
    };
    const denseEvidence: ChannelScoreEvidence = {
      channel: 'dense_semantic',
      rawScore: 0.92,
      rank: 1,
      rrfContribution: 0.016393,
    };
    const anchorEvidence: ChannelScoreEvidence = {
      channel: 'anchor_similarity',
      rawScore: 0.88,
      rank: 2,
      rrfContribution: 0.016129,
    };

    const provenance: CandidateProvenance = {
      channels: ['sparse_bm25', 'dense_semantic', 'anchor_similarity'],
      channelScores: [sparseEvidence, denseEvidence, anchorEvidence],
      queryViewMatches: [
        { viewName: 'strict', matchedText: 'Penfolds Grange', channel: 'sparse_bm25' },
        { viewName: 'accentless', matchedText: 'Penfolds Grange', channel: 'dense_semantic' },
      ],
      anchorConditioned: true,
      matchedFilterConstraints: ['region:barossa_valley'],
      fusionProfile: 'hybrid-anchor',
      fusionScore: sparseEvidence.rrfContribution + denseEvidence.rrfContribution + anchorEvidence.rrfContribution,
    };

    expect(provenance.channels).toHaveLength(3);
    expect(provenance.channels).toContain('sparse_bm25');
    expect(provenance.channels).toContain('dense_semantic');
    expect(provenance.channels).toContain('anchor_similarity');
    expect(provenance.anchorConditioned).toBe(true);
    expect(provenance.matchedFilterConstraints).toContain('region:barossa_valley');
    expect(provenance.queryViewMatches).toHaveLength(2);
  });

  it('wraps a HybridCandidate in a CandidateEnvelope with provenance', () => {
    const entityId = 'wine-001';
    const legacy = makeHybridCandidate(entityId);

    const provenance: CandidateProvenance = {
      channels: ['sparse_bm25'],
      channelScores: [
        { channel: 'sparse_bm25', rawScore: 8.0, rank: 5, rrfContribution: 0.015385 },
      ],
      queryViewMatches: [],
      anchorConditioned: false,
      matchedFilterConstraints: [],
      fusionProfile: 'hybrid-default',
      fusionScore: 0.015385,
    };

    const envelope: CandidateEnvelope = {
      entityId,
      provenance,
      legacyCandidate: legacy,
    };

    expect(envelope.entityId).toBe(entityId);
    expect(envelope.provenance).toBe(provenance);
    expect(envelope.legacyCandidate).toBe(legacy);
    expect(envelope.legacyCandidate.fusionRrfTotal).toBe(0.5);
  });

  it('protected candidates have a protectedInclusionReason', () => {
    const provenance: CandidateProvenance = {
      channels: ['sparse_bm25'],
      channelScores: [
        { channel: 'sparse_bm25', rawScore: 20.0, rank: 1, rrfContribution: 0.016393 },
      ],
      queryViewMatches: [
        { viewName: 'strict', matchedText: 'Chateau Margaux', channel: 'sparse_bm25' },
      ],
      anchorConditioned: false,
      matchedFilterConstraints: [],
      protectedInclusionReason: 'exact_alias_match',
      fusionProfile: 'hybrid-default',
      fusionScore: 0.016393,
    };

    expect(provenance.protectedInclusionReason).toBe('exact_alias_match');
  });

  it('isProvenanceChannel type guard returns true for valid channels', () => {
    expect(isProvenanceChannel('sparse_bm25')).toBe(true);
    expect(isProvenanceChannel('dense_semantic')).toBe(true);
    expect(isProvenanceChannel('browse_producer')).toBe(true);
  });

  it('isProvenanceChannel type guard returns false for invalid strings', () => {
    expect(isProvenanceChannel('bm25')).toBe(false);
    expect(isProvenanceChannel('')).toBe(false);
    expect(isProvenanceChannel('unknown_channel')).toBe(false);
  });

  it('isProvenanceQueryView type guard returns true for valid views', () => {
    expect(isProvenanceQueryView('strict')).toBe(true);
    expect(isProvenanceQueryView('accentless')).toBe(true);
    expect(isProvenanceQueryView('transliterated')).toBe(true);
  });

  it('isProvenanceQueryView type guard returns false for invalid strings', () => {
    expect(isProvenanceQueryView('fuzzy')).toBe(false);
    expect(isProvenanceQueryView('')).toBe(false);
    expect(isProvenanceQueryView('STRICT')).toBe(false);
  });

  it('ChannelScoreEvidence.rrfContribution values sum to approximately fusionScore', () => {
    const channelScores: ChannelScoreEvidence[] = [
      { channel: 'sparse_bm25', rawScore: 9.1, rank: 2, rrfContribution: 0.015873 },
      { channel: 'dense_semantic', rawScore: 0.91, rank: 1, rrfContribution: 0.016393 },
      { channel: 'anchor_similarity', rawScore: 0.85, rank: 4, rrfContribution: 0.015625 },
    ];

    const computedFusionScore = channelScores.reduce((sum, ev) => sum + ev.rrfContribution, 0);

    const provenance: CandidateProvenance = {
      channels: ['sparse_bm25', 'dense_semantic', 'anchor_similarity'],
      channelScores,
      queryViewMatches: [],
      anchorConditioned: false,
      matchedFilterConstraints: [],
      fusionProfile: 'hybrid-default',
      fusionScore: computedFusionScore,
    };

    const sumOfContributions = provenance.channelScores.reduce(
      (acc, ev) => acc + ev.rrfContribution,
      0,
    );

    expect(sumOfContributions).toBeCloseTo(provenance.fusionScore, 10);
  });
});
