/**
 * Regression: fusionRrfTotal / sparseRawScore semantic split (bugbash 2026-04-09, Group C).
 *
 * Guards the invariant that RRF total and per-channel BM25 scores are never
 * confused. Before this split, `retrievalFusionScore` held BOTH the RRF total
 * (fusion path) and the raw BM25 score (browse/compare path), making it
 * impossible for consumers to know which semantic they were reading.
 *
 * Append-only — never delete these tests.
 */
import { describe, it, expect } from 'vitest';
import { FusionService } from '../../src/domain/retrieval/service/fusion.js';
import { sparseHitToCandidate } from '../../src/domain/retrieval/service/sparse-hit-to-candidate.js';
import type { EntityId } from '../../src/domain/shared/types/index.js';
import type { SparseHit, DenseHit } from '../../src/domain/retrieval/port/search-index.port.js';

function sparseHit(entityId: string, rank: number, score: number): SparseHit {
  return { entityId: entityId as EntityId, rank, score, matchedFields: [] };
}

function denseHit(entityId: string, rank: number, score: number): DenseHit {
  return { entityId: entityId as EntityId, rank, score, similarity: score };
}

describe('Regression: fusion score semantic split', () => {
  const fusion = new FusionService();

  it('FusionService candidates have fusionRrfTotal set; retrievalFusionScore is undefined (migration step 3 complete)', () => {
    // Migration step 3 (2026-04-12): FusionService no longer dual-writes
    // retrievalFusionScore. fusionRrfTotal is the sole canonical RRF score.
    const candidates = fusion.fuse(
      [sparseHit('w-1', 1, 10)],
      [denseHit('w-1', 1, 0.9)],
    );
    const c = candidates[0]!;
    expect(c.fusionRrfTotal).toBeTypeOf('number');
    expect(Number.isFinite(c.fusionRrfTotal)).toBe(true);
    // retrievalFusionScore is deprecated/optional — FusionService no longer writes it
    expect(c.retrievalFusionScore).toBeUndefined();
  });

  it('FusionService candidates carry per-channel sparseRawScore distinct from fusionRrfTotal', () => {
    const candidates = fusion.fuse(
      [sparseHit('w-2', 1, 25.3)],
      [denseHit('w-2', 1, 0.88)],
    );
    const c = candidates[0]!;
    expect(c.sparseRawScore).toBe(25.3);
    expect(c.fusionRrfTotal).not.toBe(c.sparseRawScore);
  });

  it('Browse/Compare candidates have sparseRawScore but NOT fusionRrfTotal or retrievalFusionScore', () => {
    // Migration step 3: sparseHitToCandidate no longer writes retrievalFusionScore
    const candidate = sparseHitToCandidate(
      sparseHit('w-browse', 1, 14.7),
      1,
      {
        retrievalProfile: 'browse',
        lexicalQueries: ['merlot'],
        filtersApplied: [],
        candidateSources: ['sparse_bm25'],
      },
    );
    expect(candidate.sparseRawScore).toBe(14.7);
    expect(candidate).not.toHaveProperty('fusionRrfTotal');
    expect(candidate.retrievalFusionScore).toBeUndefined();
  });

  it('Sort order of fused candidates is by fusionRrfTotal descending', () => {
    const candidates = fusion.fuse(
      [sparseHit('w-a', 1, 20), sparseHit('w-b', 2, 5)],
      [denseHit('w-b', 1, 0.99), denseHit('w-a', 2, 0.6)],
    );
    // Candidates should be sorted by fusionRrfTotal desc
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i - 1]!.fusionRrfTotal).toBeGreaterThanOrEqual(
        candidates[i]!.fusionRrfTotal!,
      );
    }
  });
});
