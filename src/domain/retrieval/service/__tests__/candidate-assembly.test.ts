import { describe, it, expect } from 'vitest';
import { CandidateAssembler } from '../candidate-assembly.js';
import type { AssemblyPolicy } from '../candidate-assembly.js';
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

const defaultPolicy: AssemblyPolicy = {
  maxTotal: 10,
  protectExactMatches: true,
  protectAnchorConditioned: true,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CandidateAssembler', () => {
  const assembler = new CandidateAssembler();

  it('returns empty set for empty input', () => {
    const result = assembler.assemble([], defaultPolicy);
    expect(result.candidates).toHaveLength(0);
    expect(result.trace.inputCount).toBe(0);
    expect(result.trace.outputCount).toBe(0);
  });

  it('deduplicates by entityId keeping highest fusionScore', () => {
    const candidates = [
      makeCandidate('e1', 0.9),
      makeCandidate('e1', 0.5), // duplicate, lower score
      makeCandidate('e2', 0.7),
    ];
    const result = assembler.assemble(candidates, defaultPolicy);
    expect(result.candidates).toHaveLength(2);
    expect(result.trace.afterDedup).toBe(2);
    const e1 = result.candidates.find((c) => c.entityId === 'e1');
    expect(e1?.provenance.fusionScore).toBe(0.9);
  });

  it('removes candidates with failed hard constraints', () => {
    const candidates = [
      makeCandidate('e1', 0.9),
      makeCandidate('e2', 0.8, { failedHardConstraints: ['vintage:2020'] }),
      makeCandidate('e3', 0.7),
    ];
    const result = assembler.assemble(candidates, defaultPolicy);
    expect(result.candidates).toHaveLength(2);
    expect(result.trace.afterHardFilter).toBe(2);
    expect(result.candidates.map((c) => c.entityId)).not.toContain('e2');
  });

  it('keeps a valid lower-scoring duplicate when the higher-scoring duplicate fails hard constraints', () => {
    const candidates = [
      makeCandidate('e1', 0.95, { failedHardConstraints: ['region:napa'] }),
      makeCandidate('e1', 0.6),
      makeCandidate('e2', 0.5),
    ];
    const result = assembler.assemble(candidates, defaultPolicy);
    expect(result.candidates.map((c) => c.entityId)).toContain('e1');
    expect(result.candidates.find((c) => c.entityId === 'e1')?.provenance.fusionScore).toBe(0.6);
    expect(result.trace.afterHardFilter).toBe(2);
    expect(result.trace.afterDedup).toBe(2);
  });

  it('sorts output by fusionScore descending', () => {
    const candidates = [
      makeCandidate('e1', 0.3),
      makeCandidate('e2', 0.9),
      makeCandidate('e3', 0.6),
    ];
    const result = assembler.assemble(candidates, defaultPolicy);
    const scores = result.candidates.map((c) => c.provenance.fusionScore);
    expect(scores).toEqual([0.9, 0.6, 0.3]);
  });

  it('caps output at maxTotal', () => {
    const candidates = Array.from({ length: 15 }, (_, i) =>
      makeCandidate(`e${i}`, 1 - i * 0.05),
    );
    const result = assembler.assemble(candidates, { ...defaultPolicy, maxTotal: 5 });
    expect(result.candidates).toHaveLength(5);
    expect(result.trace.cappedBy).toBe('maxTotal');
  });

  it('protects exact-match candidates even when over budget', () => {
    // maxTotal = 2, but 3 protected candidates
    const candidates = [
      makeCandidate('e1', 0.9, { protectedInclusionReason: 'exact_alias_match' }),
      makeCandidate('e2', 0.8, { protectedInclusionReason: 'exact_alias_match' }),
      makeCandidate('e3', 0.7, { protectedInclusionReason: 'exact_alias_match' }),
      makeCandidate('e4', 0.6),
      makeCandidate('e5', 0.5),
    ];
    const result = assembler.assemble(candidates, {
      maxTotal: 2,
      protectExactMatches: true,
      protectAnchorConditioned: false,
    });
    // All 3 protected should survive
    expect(result.trace.protectedCount).toBe(3);
    const ids = result.candidates.map((c) => c.entityId);
    expect(ids).toContain('e1');
    expect(ids).toContain('e2');
    expect(ids).toContain('e3');
  });

  it('protects anchor-conditioned candidates', () => {
    const candidates = [
      makeCandidate('e1', 0.3),
      makeCandidate('e2', 0.2, { anchorConditioned: true }),
    ];
    const result = assembler.assemble(candidates, {
      maxTotal: 1,
      protectExactMatches: false,
      protectAnchorConditioned: true,
    });
    expect(result.trace.protectedCount).toBe(1);
    const ids = result.candidates.map((c) => c.entityId);
    expect(ids).toContain('e2');
  });

  it('applies channel quotas', () => {
    const candidates = [
      makeCandidate('e1', 0.9, { channels: ['sparse_bm25'] }),
      makeCandidate('e2', 0.8, { channels: ['sparse_bm25'] }),
      makeCandidate('e3', 0.7, { channels: ['sparse_bm25'] }),
      makeCandidate('e4', 0.6, { channels: ['dense_semantic'] }),
    ];
    const result = assembler.assemble(candidates, {
      maxTotal: 10,
      channelQuotas: [{ channel: 'sparse_bm25', maxSlots: 2 }],
      protectExactMatches: false,
      protectAnchorConditioned: false,
    });
    // Only 2 from sparse_bm25 + 1 dense_semantic = 3
    expect(result.candidates).toHaveLength(3);
  });

  it('returns trace with all expected fields', () => {
    const candidates = [makeCandidate('e1', 0.9), makeCandidate('e2', 0.7)];
    const result = assembler.assemble(candidates, defaultPolicy);
    expect(result.trace.inputCount).toBe(2);
    expect(result.trace.afterDedup).toBe(2);
    expect(result.trace.afterHardFilter).toBe(2);
    expect(result.trace.outputCount).toBe(2);
    expect(result.trace.protectedCount).toBe(0);
    expect(result.trace.cappedBy).toBeUndefined();
  });
});
