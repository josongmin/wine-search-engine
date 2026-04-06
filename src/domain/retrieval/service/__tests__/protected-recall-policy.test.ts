import { describe, it, expect } from 'vitest';
import {
  DefaultProtectedRecallPolicy,
  applyProtectedRecallPolicy,
} from '../protected-recall-policy.js';
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
      channelScores: [{ channel: 'sparse_bm25', rawScore: 0.5, rank: 3, rrfContribution: 0.5 }],
      queryViewMatches: [],
      anchorConditioned: false,
      matchedFilterConstraints: [],
      fusionProfile: 'default',
      fusionScore: 0.5,
      ...overrides,
    },
    legacyCandidate: {
      entityId,
      bm25Score: 0.5,
      semanticScore: 0,
      fusedScore: 0.5,
      retrievalTrace: { channels: ['sparse'], queryViews: [] },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DefaultProtectedRecallPolicy', () => {
  const policy = new DefaultProtectedRecallPolicy();

  // 1. known_item_lookup: sparse_bm25 rank === 1
  it('classifies sparse_bm25 rank-1 as known_item_lookup', () => {
    const c = makeCandidate('e1', {
      channelScores: [{ channel: 'sparse_bm25', rawScore: 0.9, rank: 1, rrfContribution: 0.9 }],
    });
    const result = policy.classify(c);
    expect(result.protect).toBe(true);
    expect(result.reason).toBe('known_item_lookup');
  });

  // 2. anchor_conditioned
  it('classifies anchor-conditioned candidates as anchor_conditioned', () => {
    const c = makeCandidate('e2', {
      anchorConditioned: true,
      channelScores: [{ channel: 'dense_anchor', rawScore: 0.8, rank: 2, rrfContribution: 0.8 }],
    });
    const result = policy.classify(c);
    expect(result.protect).toBe(true);
    expect(result.reason).toBe('anchor_conditioned');
  });

  // 3. known_item_lookup takes priority over anchor_conditioned
  it('prefers known_item_lookup over anchor_conditioned', () => {
    const c = makeCandidate('e3', {
      anchorConditioned: true,
      channelScores: [{ channel: 'sparse_bm25', rawScore: 0.95, rank: 1, rrfContribution: 0.95 }],
    });
    const result = policy.classify(c);
    expect(result.reason).toBe('known_item_lookup');
  });

  // 4. exact_alias_match from protectedInclusionReason
  it('classifies exact_alias_match flag as exact_alias_match', () => {
    const c = makeCandidate('e4', {
      protectedInclusionReason: 'exact_alias_match',
    });
    const result = policy.classify(c);
    expect(result.protect).toBe(true);
    expect(result.reason).toBe('exact_alias_match');
  });

  // 5. hard_constraint_compatible: passes hard constraints with matched constraints
  it('classifies hard-constraint-compatible candidates', () => {
    const c = makeCandidate('e5', {
      matchedFilterConstraints: ['vintage:2020'],
      failedHardConstraints: [],
    });
    const result = policy.classify(c);
    expect(result.protect).toBe(true);
    expect(result.reason).toBe('hard_constraint_compatible');
  });

  // 6. no protection for low-quality candidate
  it('does not protect a plain low-quality candidate', () => {
    const c = makeCandidate('e6', {
      channelScores: [{ channel: 'dense_semantic', rawScore: 0.3, rank: 15, rrfContribution: 0.3 }],
      matchedFilterConstraints: [],
    });
    const result = policy.classify(c);
    expect(result.protect).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  // 7. failedHardConstraints with entries → no hard_constraint_compatible
  it('does not protect candidate with failed hard constraints', () => {
    const c = makeCandidate('e7', {
      matchedFilterConstraints: ['vintage:2020'],
      failedHardConstraints: ['region:bordeaux'],
    });
    const result = policy.classify(c);
    expect(result.protect).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyProtectedRecallPolicy
// ---------------------------------------------------------------------------

describe('applyProtectedRecallPolicy', () => {
  it('adds protectedInclusionReason to candidates that should be protected', () => {
    const candidates = [
      makeCandidate('e1', {
        channelScores: [{ channel: 'sparse_bm25', rawScore: 0.9, rank: 1, rrfContribution: 0.9 }],
      }),
      makeCandidate('e2'),
    ];
    const result = applyProtectedRecallPolicy(candidates);
    expect(result[0]!.provenance.protectedInclusionReason).toBe('known_item_lookup');
    expect(result[1]!.provenance.protectedInclusionReason).toBeUndefined();
  });

  it('does not overwrite existing protectedInclusionReason', () => {
    const c = makeCandidate('e1', {
      protectedInclusionReason: 'diversity_slot',
    });
    const result = applyProtectedRecallPolicy([c]);
    // diversity_slot was already set, should NOT be overwritten
    expect(result[0]!.provenance.protectedInclusionReason).toBe('diversity_slot');
  });

  it('returns same array length', () => {
    const candidates = [makeCandidate('e1'), makeCandidate('e2'), makeCandidate('e3')];
    const result = applyProtectedRecallPolicy(candidates);
    expect(result).toHaveLength(3);
  });
});
