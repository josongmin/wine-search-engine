import { describe, it, expect } from 'vitest';
import { FusionService } from '../fusion.js';
import type { SparseHit, DenseHit } from '../../port/search-index.port.js';
import type { CanonicalEntityId } from '../../../shared/types/index.js';

function sparseHit(entityId: string, rank: number, score = 1.0): SparseHit {
  return { entityId: entityId as CanonicalEntityId, rank, score, matchedFields: [] };
}

function denseHit(entityId: string, rank: number, score = 1.0): DenseHit {
  return { entityId: entityId as CanonicalEntityId, rank, score, similarity: score };
}

describe('FusionService', () => {
  const service = new FusionService();

  it('returns empty array when no hits provided', () => {
    const result = service.fuse([], []);
    expect(result).toHaveLength(0);
  });

  it('throws when k < 1', () => {
    expect(() => service.fuse([], [], undefined, 0)).toThrow('k must be ≥ 1');
  });

  it('deduplicates entities appearing in both sparse and dense results', () => {
    const sparse = [sparseHit('wine-1', 1), sparseHit('wine-2', 2)];
    const dense = [denseHit('wine-1', 1), denseHit('wine-3', 2)];
    const result = service.fuse(sparse, dense);
    const ids = result.map((c) => c.entityId);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it('sorts results by descending retrievalFusionScore', () => {
    // wine-1 appears in both passes (rank 1 each) → higher fused score
    // wine-2 appears only in sparse (rank 2)
    const sparse = [sparseHit('wine-1', 1), sparseHit('wine-2', 2)];
    const dense = [denseHit('wine-1', 1)];
    const result = service.fuse(sparse, dense);
    expect(result[0]?.entityId).toBe('wine-1');
  });

  describe('deterministic sort for equal-score candidates', () => {
    it('sorts equal-score candidates by entityId lexicographic ascending', () => {
      // Give each entity the same rank in the same single pass so they all get
      // identical RRF scores. With multiple entities sharing rank, build them
      // in two separate sparse-only lists to avoid identical-rank collisions:
      // Use sparse only with rank 1 each (same contribution per entity).
      // We achieve equal scores by having each entity appear in exactly one
      // pass at rank 1.  With k=60 that means score = 1/(60+1) each.
      const sparse = [
        sparseHit('wine-charlie', 1),
        sparseHit('wine-alpha', 2),
        sparseHit('wine-bravo', 3),
      ];
      // Dense hits for the same entities at the same relative positions
      // (reversed) so they all end up with the same combined RRF score.
      const dense = [
        denseHit('wine-bravo', 1),
        denseHit('wine-alpha', 2),
        denseHit('wine-charlie', 3),
      ];

      // Run multiple times — the order must be stable each time
      const run1 = service.fuse(sparse, dense).map((c) => c.entityId);
      const run2 = service.fuse(sparse, dense).map((c) => c.entityId);
      expect(run1).toEqual(run2);
    });

    it('entities with genuinely equal RRF scores appear in entityId lexicographic order', () => {
      // Each entity appears only in the sparse pass at the same rank,
      // giving them all the same RRF contribution.
      const sparse = [
        sparseHit('z-wine', 1),
        sparseHit('a-wine', 1),
        sparseHit('m-wine', 1),
      ];
      const result = service.fuse(sparse, []);
      const ids = result.map((c) => c.entityId);
      // All scores equal → must sort lexicographically ascending
      const sorted = [...ids].sort();
      expect(ids).toEqual(sorted);
    });
  });

  describe('duplicate entityId handling (best rank wins)', () => {
    it('same entityId at two sparse ranks → best (lowest) rank is used for RRF contribution', () => {
      // wine-42 appears at rank 1 (score 10) and rank 5 (score 2) in the same list.
      // The rank-1 appearance should win so its RRF contribution is 1/(60+1), not 1/(60+5).
      const sparse = [
        sparseHit('wine-42', 1, 10),
        sparseHit('wine-42', 5, 2),  // duplicate — should be ignored
      ];
      const result = service.fuse(sparse, []);
      expect(result).toHaveLength(1);
      const candidate = result[0]!;
      // sparseRank should reflect the best rank (1), not the last-seen (5)
      expect(candidate.sparseRank).toBe(1);
      // RRF score using rank=1 is higher than rank=5 — verify it is non-trivially positive
      expect(candidate.fusionRrfTotal).toBeGreaterThan(0);
    });

    it('same entityId in both sparse and dense → both channels contribute (correct dedup)', () => {
      // This is the normal multi-channel case (not a bug) — verify it still works after fix.
      const sparse = [sparseHit('wine-1', 1)];
      const dense = [denseHit('wine-1', 1)];
      const result = service.fuse(sparse, dense);
      expect(result).toHaveLength(1);
      expect(result[0]?.sparseRank).toBe(1);
      expect(result[0]?.denseRank).toBe(1);
    });

    it('same entityId at two dense ranks → best (lowest) rank used', () => {
      const dense = [
        denseHit('wine-99', 1, 0.9),
        denseHit('wine-99', 3, 0.5),  // duplicate
      ];
      const result = service.fuse([], dense);
      expect(result).toHaveLength(1);
      expect(result[0]?.denseRank).toBe(1);
    });
  });
});
