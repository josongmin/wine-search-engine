import { describe, it, expect } from 'vitest';
import {
  traceToEvalSlice,
  validateTraceVocab,
  candidatesToEvalSlices,
} from '../trace-vocab-aligner.js';
import type { CandidateEnvelope } from '../../model/candidate-envelope.js';

// ---------------------------------------------------------------------------
// Fixture factory
// ---------------------------------------------------------------------------

function makeCandidate(
  entityId: string,
  overrides: Partial<CandidateEnvelope['provenance']> = {},
): CandidateEnvelope {
  return {
    entityId,
    provenance: {
      channels: ['sparse_bm25'],
      channelScores: [{ channel: 'sparse_bm25', rawScore: 0.8, rank: 1, rrfContribution: 0.8 }],
      queryViewMatches: [],
      anchorConditioned: false,
      matchedFilterConstraints: [],
      fusionProfile: 'default',
      fusionScore: 0.8,
      ...overrides,
    },
    legacyCandidate: {
      entityId,
      bm25Score: 0.8,
      semanticScore: 0,
      fusedScore: 0.8,
      retrievalTrace: { channels: ['sparse'], queryViews: [] },
    },
  };
}

// ---------------------------------------------------------------------------
// traceToEvalSlice
// ---------------------------------------------------------------------------

describe('traceToEvalSlice', () => {
  it('maps a sparse_bm25 candidate to a correct eval slice', () => {
    const c = makeCandidate('e1');
    const slice = traceToEvalSlice('q123', 1, c);
    expect(slice).not.toBeNull();
    expect(slice!.queryId).toBe('q123');
    expect(slice!.candidateEntityId).toBe('e1');
    expect(slice!.channels).toContain('sparse_bm25');
    expect(slice!.topChannel).toBe('sparse_bm25');
    expect(slice!.rank).toBe(1);
    expect(slice!.fusionScore).toBe(0.8);
    expect(slice!.protected).toBe(false);
    expect(slice!.anchorConditioned).toBe(false);
  });

  it('picks top channel by highest rrfContribution', () => {
    const c = makeCandidate('e1', {
      channels: ['sparse_bm25', 'dense_semantic'],
      channelScores: [
        { channel: 'sparse_bm25', rawScore: 0.5, rank: 3, rrfContribution: 0.3 },
        { channel: 'dense_semantic', rawScore: 0.9, rank: 1, rrfContribution: 0.7 },
      ],
    });
    const slice = traceToEvalSlice('q1', 1, c);
    expect(slice!.topChannel).toBe('dense_semantic');
  });

  it('sets protected=true when protectedInclusionReason is set', () => {
    const c = makeCandidate('e1', {
      protectedInclusionReason: 'exact_alias_match',
    });
    const slice = traceToEvalSlice('q1', 1, c);
    expect(slice!.protected).toBe(true);
    expect(slice!.protectedReason).toBe('exact_alias_match');
  });

  it('sets anchorConditioned=true when candidate is anchor-conditioned', () => {
    const c = makeCandidate('e1', {
      anchorConditioned: true,
      channels: ['dense_anchor'],
      channelScores: [{ channel: 'dense_anchor', rawScore: 0.8, rank: 1, rrfContribution: 0.8 }],
    });
    const slice = traceToEvalSlice('q1', 2, c);
    expect(slice!.anchorConditioned).toBe(true);
    expect(slice!.rank).toBe(2);
  });

  it('returns null if candidate has no recognized channels', () => {
    // Simulate a candidate with an unknown channel not in PROVENANCE_CHANNELS
    const c = makeCandidate('e1', {
      channels: ['unknown_channel' as never],
      channelScores: [{ channel: 'unknown_channel' as never, rawScore: 0.5, rank: 1, rrfContribution: 0.5 }],
    });
    const slice = traceToEvalSlice('q1', 1, c);
    expect(slice).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateTraceVocab
// ---------------------------------------------------------------------------

describe('validateTraceVocab', () => {
  it('returns empty array for candidate with valid channels', () => {
    const c = makeCandidate('e1', { channels: ['sparse_bm25', 'dense_semantic'] });
    expect(validateTraceVocab(c)).toHaveLength(0);
  });

  it('returns unrecognized channel names', () => {
    const c = makeCandidate('e1', {
      channels: ['sparse_bm25', 'invalid_channel' as never],
    });
    const errors = validateTraceVocab(c);
    expect(errors).toContain('invalid_channel');
  });
});

// ---------------------------------------------------------------------------
// candidatesToEvalSlices
// ---------------------------------------------------------------------------

describe('candidatesToEvalSlices', () => {
  it('converts a list to slices with correct ranks', () => {
    const candidates = [
      makeCandidate('e1'),
      makeCandidate('e2'),
      makeCandidate('e3'),
    ];
    const slices = candidatesToEvalSlices('q1', candidates);
    expect(slices).toHaveLength(3);
    expect(slices[0]!.rank).toBe(1);
    expect(slices[1]!.rank).toBe(2);
    expect(slices[2]!.rank).toBe(3);
  });

  it('filters out candidates with no recognized channels', () => {
    const candidates = [
      makeCandidate('e1'),
      makeCandidate('e2', { channels: ['bad_channel' as never], channelScores: [{ channel: 'bad_channel' as never, rawScore: 0.5, rank: 1, rrfContribution: 0.5 }] }),
      makeCandidate('e3'),
    ];
    const slices = candidatesToEvalSlices('q1', candidates);
    expect(slices).toHaveLength(2);
    const ids = slices.map((s) => s.candidateEntityId);
    expect(ids).toContain('e1');
    expect(ids).toContain('e3');
    expect(ids).not.toContain('e2');
  });
});
