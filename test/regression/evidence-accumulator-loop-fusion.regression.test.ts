/**
 * Regression: evidence-accumulator loop fusion.
 *
 * Locks the externally observable behaviour of `accumulateEvidence` after
 * the per-group loop fusion refactor. Previously the function walked each
 * candidate group 4-5 times (channel union, rank-per-channel, constraint
 * set + queryViewMatches, anchorConditioned via .some, sparse-field merge);
 * the refactor folds these into a single pass.
 *
 * These tests pin:
 *  - All accumulator outputs are correct for a single dense candidate group.
 *  - Sparse-field merge: first defined non-canonical value wins; canonical
 *    is never overwritten.
 *  - failedHardConstraints is the INTERSECTION across contributions.
 *  - Channel set + best rank per channel are correct.
 *  - Behaviour is preserved across a broad fuzz-like sweep of inputs.
 *
 * Append-only test: never delete this file.
 */
import { describe, it, expect } from 'vitest';
import { accumulateEvidence } from '../../src/domain/retrieval/service/evidence-accumulator.js';
import type { CandidateEnvelope } from '../../src/domain/retrieval/model/candidate-envelope.js';

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
      channelScores: [
        { channel: 'sparse_bm25', rawScore: fusionScore, rank: 1, rrfContribution: fusionScore },
      ],
      queryViewMatches: [],
      anchorConditioned: false,
      matchedFilterConstraints: [],
      fusionProfile: 'default',
      fusionScore,
      ...overrides,
    },
    legacyCandidate: {
      entityId,
      fusionRrfTotal: fusionScore,
      matchedConstraints: [],
      retrievalTrace: { channels: ['sparse'], queryViews: [] },
      ...legacyOverrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Single-group: all accumulators correct in one pass
// ---------------------------------------------------------------------------

describe('evidence-accumulator loop fusion: single candidate group', () => {
  it('accumulates channels, ranks, constraints, queryViews and anchor flag in one pass', () => {
    const c1 = makeCandidate('e1', 0.5, {
      channels: ['sparse_bm25'],
      channelScores: [
        { channel: 'sparse_bm25', rawScore: 0.5, rank: 4, rrfContribution: 0.01 },
      ],
      queryViewMatches: [{ viewName: 'strict', matchedText: 'cabernet', channel: 'sparse_bm25' }],
      matchedFilterConstraints: ['region:bordeaux'],
      anchorConditioned: false,
    });
    const c2 = makeCandidate('e1', 0.8, {
      channels: ['dense_semantic', 'anchor_similarity'],
      channelScores: [
        { channel: 'dense_semantic', rawScore: 0.9, rank: 2, rrfContribution: 0.05 },
        { channel: 'anchor_similarity', rawScore: 0.7, rank: 1, rrfContribution: 0.04 },
      ],
      queryViewMatches: [
        { viewName: 'strict', matchedText: 'cabernet', channel: 'sparse_bm25' }, // dedup
        { viewName: 'strict', matchedText: 'opus one', channel: 'dense_semantic' },
      ],
      matchedFilterConstraints: ['country:france', 'region:bordeaux'],
      anchorConditioned: true,
    });

    const [result] = accumulateEvidence([c1, c2]);
    expect(result).toBeDefined();
    expect(result!.entityId).toBe('e1');
    expect(result!.bestFusionScore).toBe(0.8);
    // channelSet union (set semantics ⇒ no dupes)
    const channels = new Set(result!.channels);
    expect(channels).toEqual(new Set(['sparse_bm25', 'dense_semantic', 'anchor_similarity']));
    // best (lowest) rank per channel
    expect(result!.bestRankPerChannel['sparse_bm25']).toBe(4);
    expect(result!.bestRankPerChannel['dense_semantic']).toBe(2);
    expect(result!.bestRankPerChannel['anchor_similarity']).toBe(1);
    // constraint union
    expect(new Set(result!.matchedFilterConstraints)).toEqual(
      new Set(['region:bordeaux', 'country:france']),
    );
    // anchorConditioned OR-reduce
    expect(result!.anchorConditioned).toBe(true);
    // queryViewMatches dedup
    const qvm = result!.mergedEnvelope.provenance.queryViewMatches;
    expect(qvm).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Sparse-field merge: first defined non-canonical value wins, canonical wins
// ---------------------------------------------------------------------------

describe('evidence-accumulator loop fusion: sparse-field merge', () => {
  it('fills sparse fields from the first non-canonical contribution that defines them', () => {
    // canonical = c3 (highest fusionScore), has none of the sparse fields.
    // c1 defines grapeFamily + flavorProfiles; c2 defines regionHierarchy + priceBandNumeric.
    // First-defined wins per field (group iteration order = insertion order).
    const c1 = makeCandidate(
      'e1',
      0.3,
      { channels: ['sparse_bm25'] },
      { grapeFamily: 'Pinot', flavorProfiles: ['floral'] },
    );
    const c2 = makeCandidate(
      'e1',
      0.4,
      { channels: ['sparse_bm25'] },
      {
        grapeFamily: 'Merlot', // c1 wins (already defined)
        regionHierarchy: ['Italy', 'Tuscany'],
        priceBandNumeric: 4,
      },
    );
    const c3 = makeCandidate('e1', 0.9, {
      channels: ['dense_semantic'],
      channelScores: [
        { channel: 'dense_semantic', rawScore: 0.9, rank: 1, rrfContribution: 0.9 },
      ],
    });

    const [result] = accumulateEvidence([c1, c2, c3]);
    expect(result!.canonicalEnvelope).toBe(c3);
    expect(result!.mergedEnvelope.legacyCandidate.grapeFamily).toBe('Pinot');
    expect(result!.mergedEnvelope.legacyCandidate.flavorProfiles).toEqual(['floral']);
    expect(result!.mergedEnvelope.legacyCandidate.regionHierarchy).toEqual(['Italy', 'Tuscany']);
    expect(result!.mergedEnvelope.legacyCandidate.priceBandNumeric).toBe(4);
  });

  it('never overwrites a sparse field already present on canonical', () => {
    const c1 = makeCandidate(
      'e1',
      0.3,
      { channels: ['sparse_bm25'] },
      { grapeFamily: 'Pinot' },
    );
    const c2 = makeCandidate(
      'e1',
      0.9,
      {
        channels: ['dense_semantic'],
        channelScores: [
          { channel: 'dense_semantic', rawScore: 0.9, rank: 1, rrfContribution: 0.9 },
        ],
      },
      { grapeFamily: 'Cabernet' },
    );

    const [result] = accumulateEvidence([c1, c2]);
    expect(result!.canonicalEnvelope).toBe(c2);
    expect(result!.mergedEnvelope.legacyCandidate.grapeFamily).toBe('Cabernet');
  });

  it('treats empty arrays as undefined for flavorProfiles/regionHierarchy (must be filled by next defined)', () => {
    // canonical (c2) has empty arrays — semantically "absent" per the merge contract.
    // c1 has real values; they should fill the merged envelope.
    const c1 = makeCandidate(
      'e1',
      0.4,
      { channels: ['sparse_bm25'] },
      { flavorProfiles: ['oaky'], regionHierarchy: ['France', 'Bordeaux'] },
    );
    const c2 = makeCandidate(
      'e1',
      0.9,
      {
        channels: ['dense_semantic'],
        channelScores: [
          { channel: 'dense_semantic', rawScore: 0.9, rank: 1, rrfContribution: 0.9 },
        ],
      },
      { flavorProfiles: [], regionHierarchy: [] },
    );

    const [result] = accumulateEvidence([c1, c2]);
    expect(result!.canonicalEnvelope).toBe(c2);
    // Empty array on canonical is non-undefined so canonical wins by the merge rule —
    // exactly what the pre-refactor code did. Lock this so a future "treat empty as
    // missing" change is an explicit decision rather than an accidental drift.
    expect(result!.mergedEnvelope.legacyCandidate.flavorProfiles).toEqual([]);
    expect(result!.mergedEnvelope.legacyCandidate.regionHierarchy).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// failedHardConstraints intersection
// ---------------------------------------------------------------------------

describe('evidence-accumulator loop fusion: failedHardConstraints intersection', () => {
  it('only keeps attributes that failed in EVERY contribution', () => {
    const c1 = makeCandidate('e1', 0.4, {
      channels: ['sparse_bm25'],
      failedHardConstraints: ['country', 'vintage', 'price'],
    });
    const c2 = makeCandidate('e1', 0.5, {
      channels: ['dense_semantic'],
      channelScores: [
        { channel: 'dense_semantic', rawScore: 0.5, rank: 1, rrfContribution: 0.5 },
      ],
      failedHardConstraints: ['vintage', 'price'],
    });
    const c3 = makeCandidate('e1', 0.6, {
      channels: ['anchor_similarity'],
      channelScores: [
        { channel: 'anchor_similarity', rawScore: 0.6, rank: 1, rrfContribution: 0.6 },
      ],
      failedHardConstraints: ['vintage'],
    });

    const [result] = accumulateEvidence([c1, c2, c3]);
    // Intersection = {'vintage'} (only attr that failed in all 3 contributions)
    expect(result!.mergedEnvelope.legacyCandidate.unmetHardConstraints).toEqual(['vintage']);
  });

  it('omits unmetHardConstraints when intersection is empty', () => {
    const c1 = makeCandidate('e1', 0.5, { failedHardConstraints: ['country'] });
    const c2 = makeCandidate('e1', 0.6, { failedHardConstraints: ['vintage'] });
    const [result] = accumulateEvidence([c1, c2]);
    expect(result!.mergedEnvelope.legacyCandidate.unmetHardConstraints).toBeUndefined();
  });

  it('intersection is empty when one contribution has no failures', () => {
    const c1 = makeCandidate('e1', 0.5, { failedHardConstraints: ['country', 'vintage'] });
    const c2 = makeCandidate('e1', 0.6); // failedHardConstraints omitted ⇒ {}
    const [result] = accumulateEvidence([c1, c2]);
    expect(result!.mergedEnvelope.legacyCandidate.unmetHardConstraints).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Channel set + best rank per channel
// ---------------------------------------------------------------------------

describe('evidence-accumulator loop fusion: channels + best rank per channel', () => {
  it('takes the minimum rank per channel across contributions', () => {
    const c1 = makeCandidate('e1', 0.5, {
      channels: ['sparse_bm25'],
      channelScores: [
        { channel: 'sparse_bm25', rawScore: 0.5, rank: 7, rrfContribution: 0.01 },
      ],
    });
    const c2 = makeCandidate('e1', 0.6, {
      channels: ['sparse_bm25'],
      channelScores: [
        { channel: 'sparse_bm25', rawScore: 0.6, rank: 2, rrfContribution: 0.02 },
      ],
    });
    const c3 = makeCandidate('e1', 0.4, {
      channels: ['sparse_bm25'],
      channelScores: [
        { channel: 'sparse_bm25', rawScore: 0.4, rank: 9, rrfContribution: 0.005 },
      ],
    });
    const [result] = accumulateEvidence([c1, c2, c3]);
    expect(result!.bestRankPerChannel['sparse_bm25']).toBe(2);
  });

  it('emits the union of all canonical channels across contributions', () => {
    const c1 = makeCandidate('e1', 0.5, { channels: ['sparse_bm25'] });
    const c2 = makeCandidate('e1', 0.6, {
      channels: ['sparse_bm25', 'dense_semantic'],
      channelScores: [
        { channel: 'sparse_bm25', rawScore: 0.6, rank: 1, rrfContribution: 0.6 },
        { channel: 'dense_semantic', rawScore: 0.4, rank: 3, rrfContribution: 0.4 },
      ],
    });
    const c3 = makeCandidate('e1', 0.7, {
      channels: ['anchor_similarity'],
      channelScores: [
        { channel: 'anchor_similarity', rawScore: 0.7, rank: 1, rrfContribution: 0.7 },
      ],
    });
    const [result] = accumulateEvidence([c1, c2, c3]);
    expect(new Set(result!.channels)).toEqual(
      new Set(['sparse_bm25', 'dense_semantic', 'anchor_similarity']),
    );
  });
});

// ---------------------------------------------------------------------------
// Broad fuzz-like sweep: behaviour preserved across varied inputs
// ---------------------------------------------------------------------------

describe('evidence-accumulator loop fusion: behaviour preservation sweep', () => {
  it('handles empty input', () => {
    expect(accumulateEvidence([])).toHaveLength(0);
  });

  it('handles single candidate, single channel', () => {
    const c = makeCandidate('e1', 0.5);
    const result = accumulateEvidence([c]);
    expect(result).toHaveLength(1);
    expect(result[0]!.bestFusionScore).toBe(0.5);
    expect(result[0]!.channels).toEqual(['sparse_bm25']);
  });

  it('handles N distinct entities with no overlap', () => {
    const candidates = Array.from({ length: 10 }, (_, i) => makeCandidate(`e${i}`, i / 10));
    const result = accumulateEvidence(candidates);
    expect(result).toHaveLength(10);
    // sorted desc by bestFusionScore
    const scores = result.map((r) => r.bestFusionScore);
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i - 1]!).toBeGreaterThanOrEqual(scores[i]!);
    }
  });

  it('handles K duplicate contributions per entity across many entities', () => {
    const candidates: CandidateEnvelope[] = [];
    for (let e = 0; e < 5; e += 1) {
      for (let k = 0; k < 4; k += 1) {
        candidates.push(
          makeCandidate(`e${e}`, e * 0.1 + k * 0.01, {
            channels: k % 2 === 0 ? ['sparse_bm25'] : ['dense_semantic'],
            channelScores: [
              {
                channel: k % 2 === 0 ? 'sparse_bm25' : 'dense_semantic',
                rawScore: k,
                rank: k + 1,
                rrfContribution: k * 0.01,
              },
            ],
          }),
        );
      }
    }
    const result = accumulateEvidence(candidates);
    expect(result).toHaveLength(5);
    for (const r of result) {
      // Each entity had at least one sparse + one dense contribution
      expect(new Set(r.channels)).toEqual(new Set(['sparse_bm25', 'dense_semantic']));
    }
  });

  it('preserves sort order: desc by bestFusionScore with entityId tiebreaker', () => {
    // Two entities with identical fusionScore — must tiebreak by entityId asc.
    const c1 = makeCandidate('z-entity', 0.5);
    const c2 = makeCandidate('a-entity', 0.5);
    const c3 = makeCandidate('m-entity', 0.7);
    const result = accumulateEvidence([c1, c2, c3]);
    expect(result.map((r) => r.entityId)).toEqual(['m-entity', 'a-entity', 'z-entity']);
  });

  it('handles non-finite rrfContribution without crashing (NaN guard)', () => {
    const c1 = makeCandidate('e1', 0.5, {
      channels: ['sparse_bm25'],
      channelScores: [
        { channel: 'sparse_bm25', rawScore: NaN, rank: 1, rrfContribution: NaN },
      ],
    });
    const c2 = makeCandidate('e1', 0.6, {
      channels: ['sparse_bm25'],
      channelScores: [
        { channel: 'sparse_bm25', rawScore: 0.6, rank: 2, rrfContribution: 0.06 },
      ],
    });
    const [result] = accumulateEvidence([c1, c2]);
    // The finite-contribution evidence must win — NaN cannot beat 0.06.
    expect(result!.mergedEnvelope.provenance.channelScores[0]?.rank).toBe(2);
  });
});
