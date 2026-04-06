import { describe, it, expect } from 'vitest';
import { FusionService } from '../service/fusion.js';
import type { SparseHit, DenseHit } from '../port/search-index.port.js';
import { createEntityId } from '../../shared/types/index.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeSparse(entityId: string, rank: number, score: number = 1.0): SparseHit {
  return {
    entityId: createEntityId(entityId),
    score,
    rank,
    matchedFields: ['name'],
  };
}

function makeDense(entityId: string, rank: number, score: number = 0.9): DenseHit {
  return {
    entityId: createEntityId(entityId),
    score,
    rank,
    similarity: score,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('FusionService', () => {
  const fusion = new FusionService();

  describe('basic fusion', () => {
    it('empty sparse and dense → empty result', () => {
      const candidates = fusion.fuse([], []);
      expect(candidates).toHaveLength(0);
    });

    it('sparse only → candidates returned', () => {
      const candidates = fusion.fuse([makeSparse('wine-a', 1)], []);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.entityId).toBe(createEntityId('wine-a'));
    });

    it('dense only → candidates returned', () => {
      const candidates = fusion.fuse([], [makeDense('wine-a', 1)]);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.entityId).toBe(createEntityId('wine-a'));
    });
  });

  describe('rank 1 in both sparse and dense → highest fused score', () => {
    it('entity rank 1 in both lists gets higher score than entity in one list', () => {
      const sparse = [makeSparse('wine-top', 1), makeSparse('wine-sparse-only', 2)];
      const dense = [makeDense('wine-top', 1), makeDense('wine-dense-only', 2)];

      const candidates = fusion.fuse(sparse, dense);

      const topScore = candidates.find((c) => c.entityId === createEntityId('wine-top'))?.retrievalFusionScore ?? 0;
      const sparseOnlyScore = candidates.find((c) => c.entityId === createEntityId('wine-sparse-only'))?.retrievalFusionScore ?? 0;
      const denseOnlyScore = candidates.find((c) => c.entityId === createEntityId('wine-dense-only'))?.retrievalFusionScore ?? 0;

      expect(topScore).toBeGreaterThan(sparseOnlyScore);
      expect(topScore).toBeGreaterThan(denseOnlyScore);
    });
  });

  describe('present in one list only', () => {
    it('entity in both lists has higher score than entity in only one', () => {
      const sparse = [
        makeSparse('wine-both', 1),
        makeSparse('wine-sparse-only', 2),
      ];
      const dense = [makeDense('wine-both', 1)];

      const candidates = fusion.fuse(sparse, dense);
      const bothScore = candidates.find((c) => c.entityId === createEntityId('wine-both'))?.retrievalFusionScore ?? 0;
      const sparseOnlyScore = candidates.find((c) => c.entityId === createEntityId('wine-sparse-only'))?.retrievalFusionScore ?? 0;

      expect(bothScore).toBeGreaterThan(sparseOnlyScore);
    });
  });

  describe('deduplication', () => {
    it('same entityId in both sparse and dense → appears once in result', () => {
      const sparse = [makeSparse('wine-a', 1)];
      const dense = [makeDense('wine-a', 1)];

      const candidates = fusion.fuse(sparse, dense);
      const wineACount = candidates.filter((c) => c.entityId === createEntityId('wine-a')).length;
      expect(wineACount).toBe(1);
    });

    it('no duplicate entities in result even with anchor hits', () => {
      const sparse = [makeSparse('wine-a', 1), makeSparse('wine-b', 2)];
      const dense = [makeDense('wine-a', 1), makeDense('wine-c', 2)];
      const anchor = [makeDense('wine-a', 1)];

      const candidates = fusion.fuse(sparse, dense, anchor);
      const wineACount = candidates.filter((c) => c.entityId === createEntityId('wine-a')).length;
      expect(wineACount).toBe(1);
    });
  });

  describe('sorted by fusion score descending', () => {
    it('result list is sorted descending by retrievalFusionScore', () => {
      const sparse = [
        makeSparse('wine-a', 1),
        makeSparse('wine-b', 2),
        makeSparse('wine-c', 3),
      ];
      const dense = [
        makeDense('wine-a', 1),
        makeDense('wine-b', 2),
        makeDense('wine-c', 3),
      ];

      const candidates = fusion.fuse(sparse, dense);
      for (let i = 1; i < candidates.length; i++) {
        expect(candidates[i - 1]!.retrievalFusionScore).toBeGreaterThanOrEqual(
          candidates[i]!.retrievalFusionScore,
        );
      }
    });
  });

  describe('retrievalTrace', () => {
    it('entity only in sparse has candidateSources = ["sparse_bm25"]', () => {
      const sparse = [makeSparse('wine-sparse', 1)];
      const dense = [makeDense('wine-dense', 1)];

      const candidates = fusion.fuse(sparse, dense);
      const sparseCandidate = candidates.find((c) => c.entityId === createEntityId('wine-sparse'));
      expect(sparseCandidate?.retrievalTrace.candidateSources).toContain('sparse_bm25');
      expect(sparseCandidate?.retrievalTrace.candidateSources).not.toContain('dense_semantic');
    });

    it('entity in both sparse and dense has both sources', () => {
      const sparse = [makeSparse('wine-both', 1)];
      const dense = [makeDense('wine-both', 1)];

      const candidates = fusion.fuse(sparse, dense);
      const bothCandidate = candidates[0];
      expect(bothCandidate?.retrievalTrace.candidateSources).toContain('sparse_bm25');
      expect(bothCandidate?.retrievalTrace.candidateSources).toContain('dense_semantic');
    });

    it('entity with anchor hit has "anchor_similarity" in sources', () => {
      const sparse: SparseHit[] = [];
      const dense: DenseHit[] = [];
      const anchor = [makeDense('wine-anchor', 1)];

      const candidates = fusion.fuse(sparse, dense, anchor);
      const anchorCandidate = candidates.find((c) => c.entityId === createEntityId('wine-anchor'));
      expect(anchorCandidate?.retrievalTrace.candidateSources).toContain('anchor_similarity');
    });
  });

  describe('sparseRank and denseRank fields', () => {
    it('entity in sparse has sparseRank set', () => {
      const sparse = [makeSparse('wine-a', 3)];
      const dense: DenseHit[] = [];

      const candidates = fusion.fuse(sparse, dense);
      expect(candidates[0]?.sparseRank).toBe(3);
      expect(candidates[0]?.denseRank).toBeUndefined();
    });

    it('entity in dense has denseRank set', () => {
      const sparse: SparseHit[] = [];
      const dense = [makeDense('wine-a', 2)];

      const candidates = fusion.fuse(sparse, dense);
      expect(candidates[0]?.denseRank).toBe(2);
      expect(candidates[0]?.sparseRank).toBeUndefined();
    });

    it('entity in both lists has both ranks set', () => {
      const sparse = [makeSparse('wine-a', 1)];
      const dense = [makeDense('wine-a', 2)];

      const candidates = fusion.fuse(sparse, dense);
      expect(candidates[0]?.sparseRank).toBe(1);
      expect(candidates[0]?.denseRank).toBe(2);
    });
  });

  describe('hit summary merge', () => {
    it('prefers sparse canonicalLabel over dense', () => {
      const sparse: SparseHit[] = [
        {
          ...makeSparse('wine-a', 1),
          summary: { canonicalLabel: 'From sparse' },
        },
      ];
      const dense: DenseHit[] = [
        {
          ...makeDense('wine-a', 1),
          summary: { canonicalLabel: 'From dense' },
        },
      ];

      const candidates = fusion.fuse(sparse, dense);
      expect(candidates[0]?.canonicalLabel).toBe('From sparse');
    });

    it('fills producer from dense when sparse summary omits it', () => {
      const sparse: SparseHit[] = [
        {
          ...makeSparse('wine-a', 1),
          summary: { canonicalLabel: 'Wine' },
        },
      ];
      const dense: DenseHit[] = [
        {
          ...makeDense('wine-a', 1),
          summary: { producer: 'Château X' },
        },
      ];

      const candidates = fusion.fuse(sparse, dense);
      expect(candidates[0]?.producer).toBe('Château X');
      expect(candidates[0]?.canonicalLabel).toBe('Wine');
    });

    it('propagates producerPrestige from hit summaries', () => {
      const sparse: SparseHit[] = [
        {
          ...makeSparse('wine-a', 1),
          summary: { canonicalLabel: 'Wine', producerPrestige: 0.82 },
        },
      ];

      const candidates = fusion.fuse(sparse, []);
      expect(candidates[0]?.producerPrestige).toBe(0.82);
    });

    it('merges drinkingWindowModelVersion from later passes when sparse omits it', () => {
      const sparse: SparseHit[] = [
        {
          ...makeSparse('wine-a', 1),
          summary: { canonicalLabel: 'Wine' },
        },
      ];
      const dense: DenseHit[] = [
        {
          ...makeDense('wine-a', 1),
          summary: {
            producerPrestige: 0.75,
            drinkingWindowModelVersion: 'dw-dense-v2',
          },
        },
      ];

      const candidates = fusion.fuse(sparse, dense);
      expect(candidates[0]).toMatchObject({
        canonicalLabel: 'Wine',
        producerPrestige: 0.75,
        drinkingWindowModelVersion: 'dw-dense-v2',
      });
    });

    it('prefers sparse grapePrimary over dense', () => {
      const sparse: SparseHit[] = [
        {
          ...makeSparse('wine-a', 1),
          summary: { grapePrimary: 'Pinot Noir' },
        },
      ];
      const dense: DenseHit[] = [
        {
          ...makeDense('wine-a', 1),
          summary: { grapePrimary: 'Merlot' },
        },
      ];

      const candidates = fusion.fuse(sparse, dense);
      expect(candidates[0]?.grapePrimary).toBe('Pinot Noir');
    });
  });

  describe('k parameter guard', () => {
    it('throws when k=0 is passed explicitly', () => {
      const sparse = [makeSparse('wine-a', 1)];
      const dense = [makeDense('wine-a', 1)];
      // k=0 passes through `??` (only catches null/undefined), so the guard
      // must be an explicit range check, not `k ?? 60`.
      expect(() => fusion.fuse(sparse, dense, undefined, 0)).toThrow('k must be ≥ 1');
    });

    it('throws when k is negative', () => {
      const sparse = [makeSparse('wine-a', 1)];
      expect(() => fusion.fuse(sparse, [], undefined, -10)).toThrow('k must be ≥ 1');
    });

    it('does not throw when k=undefined (uses default 60)', () => {
      const sparse = [makeSparse('wine-a', 1)];
      expect(() => fusion.fuse(sparse, [], undefined, undefined)).not.toThrow();
    });

    it('does not throw when k=1', () => {
      const sparse = [makeSparse('wine-a', 1)];
      expect(() => fusion.fuse(sparse, [], undefined, 1)).not.toThrow();
    });
  });

  describe('RRF formula correctness', () => {
    it('fusion score for rank 1 in both = 2 * (1/(60+1))', () => {
      const sparse = [makeSparse('wine-a', 1)];
      const dense = [makeDense('wine-a', 1)];

      const candidates = fusion.fuse(sparse, dense);
      expect(candidates[0]?.retrievalFusionScore).toBeCloseTo(2 / 61, 10);
    });

    it('fusion score for rank 1 in sparse only = 1/(60+1)', () => {
      const sparse = [makeSparse('wine-a', 1)];
      const dense: DenseHit[] = [];

      const candidates = fusion.fuse(sparse, dense);
      expect(candidates[0]?.retrievalFusionScore).toBeCloseTo(1 / 61, 10);
    });
  });
});
