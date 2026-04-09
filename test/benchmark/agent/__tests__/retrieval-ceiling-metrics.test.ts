/**
 * Unit tests for Epic-13 SOTA++ retrieval ceiling metrics and ranking
 * metric utilities.
 *
 * Coverage:
 *   Part A — retrieval-ceiling-metrics.ts
 *     1. Empty relevant set
 *     2. Empty retrieved set
 *     3. Perfect retrieval @20 (all relevant in top-20)
 *     4. Partial retrieval (half the relevant docs missing)
 *     5. Oracle NDCG when retrieval is perfect
 *     6. Oracle NDCG when retrieval missed some
 *     7. diagnoseRankingGap — retrieval_bottleneck
 *     8. diagnoseRankingGap — ranking_bottleneck
 *
 *   Part B — ranking-metrics.ts
 *     9.  ndcg_at_k monotonic / perfect ranking = 1.0
 *     10. mrr returns reciprocal rank of first hit
 *     11. map_at_k on interleaved ranking
 *     12. alpha_ndcg_at_k rewards diversity over redundancy
 *     13. alpha_ndcg_at_k returns 0 on empty aspect map
 */

import { describe, it, expect } from 'vitest';
import {
  computeRetrievalCeiling,
  diagnoseRankingGap,
} from '../retrieval-ceiling-metrics.js';
import {
  ndcg_at_k,
  mrr,
  map_at_k,
  alpha_ndcg_at_k,
  DEFAULT_ALPHA,
} from '../ranking-metrics.js';

// ─────────────────────────────────────────────────────────────────────
// Part A — retrieval ceiling diagnostics
// ─────────────────────────────────────────────────────────────────────

describe('computeRetrievalCeiling', () => {
  it('returns all-zero metrics when relevant set is empty', () => {
    const metrics = computeRetrievalCeiling(['a', 'b', 'c'], ['a', 'b'], new Set<string>());
    expect(metrics.recall_at_20).toBe(0);
    expect(metrics.recall_at_50).toBe(0);
    expect(metrics.recall_at_100).toBe(0);
    expect(metrics.oracle_ndcg_at_10).toBe(0);
    expect(metrics.oracle_mrr).toBe(0);
    expect(metrics.relevant_count).toBe(0);
    expect(metrics.retrieved_count).toBe(3);
    expect(metrics.ranked_count).toBe(2);
  });

  it('returns all-zero metrics when retrieved set is empty', () => {
    const metrics = computeRetrievalCeiling([], [], new Set(['x', 'y']));
    expect(metrics.recall_at_20).toBe(0);
    expect(metrics.oracle_ndcg_at_10).toBe(0);
    expect(metrics.oracle_mrr).toBe(0);
    expect(metrics.retrieved_count).toBe(0);
  });

  it('reports recall@20 = 1.0 when all relevant docs are inside top-20', () => {
    // 5 relevant docs, all present in positions 1..10 of retrieved pool.
    const retrieved = Array.from({ length: 30 }, (_, i) => `d${i}`);
    const relevant = new Set(['d0', 'd2', 'd4', 'd6', 'd8']);
    const metrics = computeRetrievalCeiling(retrieved, retrieved.slice(0, 10), relevant);
    expect(metrics.recall_at_20).toBe(1);
    expect(metrics.recall_at_50).toBe(1);
    expect(metrics.recall_at_100).toBe(1);
    expect(metrics.oracle_mrr).toBe(1);
  });

  it('reports recall@20 ≈ 0.5 when only half the relevant docs are retrieved', () => {
    const retrieved = ['d0', 'd1', 'd2', 'd3'];
    const relevant = new Set(['d0', 'd1', 'd99', 'd100']);
    const metrics = computeRetrievalCeiling(retrieved, retrieved, relevant);
    expect(metrics.recall_at_20).toBeCloseTo(0.5, 10);
    expect(metrics.recall_at_50).toBeCloseTo(0.5, 10);
    expect(metrics.recall_at_100).toBeCloseTo(0.5, 10);
  });

  it('oracle_ndcg@10 = 1.0 when retrieval covers all relevant docs', () => {
    // Relevant docs scattered across the pool, but all present.
    const retrieved = ['noise1', 'g1', 'noise2', 'g2', 'noise3', 'g3'];
    const relevant = new Set(['g1', 'g2', 'g3']);
    const metrics = computeRetrievalCeiling(retrieved, retrieved, relevant);
    expect(metrics.oracle_ndcg_at_10).toBeCloseTo(1, 10);
  });

  it('oracle_ndcg@10 is penalized when retrieval misses some relevant docs', () => {
    // Only 2 of 4 relevant docs are in the pool.
    const retrieved = ['g1', 'noise1', 'g2', 'noise2'];
    const relevant = new Set(['g1', 'g2', 'g3', 'g4']);
    const metrics = computeRetrievalCeiling(retrieved, retrieved, relevant);
    // IDCG for 4 hits = 1 + 1/log2(3) + 1/log2(4) + 1/log2(5)
    // DCG_oracle for 2 hits at ranks 1,2 = 1 + 1/log2(3)
    const idcg = 1 / Math.log2(2) + 1 / Math.log2(3) + 1 / Math.log2(4) + 1 / Math.log2(5);
    const dcg = 1 / Math.log2(2) + 1 / Math.log2(3);
    const expected = dcg / idcg;
    expect(metrics.oracle_ndcg_at_10).toBeCloseTo(expected, 10);
    expect(metrics.oracle_ndcg_at_10).toBeLessThan(1);
  });
});

describe('diagnoseRankingGap', () => {
  it('classifies as retrieval_bottleneck when retrieved misses ≥50% relevant', () => {
    // 4 relevant, retrieved only has 2 → coverage = 0.5 < 0.8.
    const retrieved = ['g1', 'g2', 'noise1', 'noise2'];
    const ranked = ['g1', 'g2', 'noise1', 'noise2'];
    const relevant = new Set(['g1', 'g2', 'g3', 'g4']);
    const analysis = diagnoseRankingGap(retrieved, ranked, relevant);
    expect(analysis.retrievalCoverage).toBeCloseTo(0.5, 10);
    expect(analysis.rankingEfficiency).toBeGreaterThanOrEqual(0.8);
    expect(analysis.gap).toBe('retrieval_bottleneck');
  });

  it('classifies as ranking_bottleneck when pool is complete but order is bad', () => {
    // All 3 relevant docs in the pool but placed at the bottom of the ranking.
    const retrieved = ['g1', 'g2', 'g3', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'];
    const relevant = new Set(['g1', 'g2', 'g3']);
    // Ranker puts noise first, gold at ranks 8,9,10.
    const ranked = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'g1', 'g2', 'g3'];
    const analysis = diagnoseRankingGap(retrieved, ranked, relevant);
    expect(analysis.retrievalCoverage).toBe(1);
    expect(analysis.rankingEfficiency).toBeLessThan(0.8);
    expect(analysis.gap).toBe('ranking_bottleneck');
  });

  it('classifies as neither when retrieval and ranking are both strong', () => {
    const retrieved = ['g1', 'g2', 'g3', 'n1', 'n2'];
    const relevant = new Set(['g1', 'g2', 'g3']);
    const ranked = ['g1', 'g2', 'g3', 'n1', 'n2'];
    const analysis = diagnoseRankingGap(retrieved, ranked, relevant);
    expect(analysis.gap).toBe('neither');
    expect(analysis.rankingEfficiency).toBeCloseTo(1, 10);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Part B — ranking metric utilities
// ─────────────────────────────────────────────────────────────────────

describe('ndcg_at_k', () => {
  it('returns 1.0 for a perfect ranking', () => {
    const ranked = ['g1', 'g2', 'g3', 'n1', 'n2'];
    const relevant = new Set(['g1', 'g2', 'g3']);
    expect(ndcg_at_k(ranked, relevant, 10)).toBeCloseTo(1, 10);
  });

  it('returns 0 when ranked list has no relevant docs', () => {
    expect(ndcg_at_k(['a', 'b', 'c'], new Set(['x', 'y']), 10)).toBe(0);
  });
});

describe('mrr', () => {
  it('returns 1/rank of the first relevant doc', () => {
    // First hit at rank 3 → 1/3.
    expect(mrr(['n1', 'n2', 'g1', 'n3', 'g2'], new Set(['g1', 'g2']))).toBeCloseTo(1 / 3, 10);
    expect(mrr(['g1', 'n1'], new Set(['g1']))).toBe(1);
    expect(mrr(['n1', 'n2'], new Set(['g1']))).toBe(0);
  });
});

describe('map_at_k', () => {
  it('computes average precision on an interleaved ranking', () => {
    // Ranked: g n g n g, relevant = {g@1, g@3, g@5}
    // Precisions at hits: 1/1, 2/3, 3/5 → sum = 1 + 2/3 + 3/5 = 34/15
    // Denominator = min(5, 3) = 3 → AP = 34/45
    const ranked = ['a', 'x', 'b', 'y', 'c'];
    const relevant = new Set(['a', 'b', 'c']);
    const expected = (1 + 2 / 3 + 3 / 5) / 3;
    expect(map_at_k(ranked, relevant, 5)).toBeCloseTo(expected, 10);
  });
});

describe('alpha_ndcg_at_k', () => {
  it('rewards a diverse ranking over a redundant one', () => {
    // Three docs, each covering a distinct aspect (diverse set), vs three
    // docs all covering the same single aspect (redundant set).
    const diverseRanking = ['d1', 'd2', 'd3'];
    const redundantRanking = ['r1', 'r2', 'r3'];
    const aspects = new Map<string, ReadonlySet<string>>([
      ['d1', new Set(['A'])],
      ['d2', new Set(['B'])],
      ['d3', new Set(['C'])],
      ['r1', new Set(['A'])],
      ['r2', new Set(['A'])],
      ['r3', new Set(['A'])],
    ]);
    const diverse = alpha_ndcg_at_k(diverseRanking, aspects, 3, DEFAULT_ALPHA);
    const redundant = alpha_ndcg_at_k(redundantRanking, aspects, 3, DEFAULT_ALPHA);
    expect(diverse).toBeGreaterThan(redundant);
    expect(diverse).toBeCloseTo(1, 10);
  });

  it('returns 0 for an empty aspect map', () => {
    expect(alpha_ndcg_at_k(['a', 'b'], new Map(), 10, DEFAULT_ALPHA)).toBe(0);
  });
});
