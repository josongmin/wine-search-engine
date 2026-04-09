/**
 * Regression: dedupeSparseHitsByEntity must be deterministic under input
 * permutation, NaN scores, and tied scores.
 *
 * Prior bug:
 *  - `h.score > cur.score` kept first-seen on ties (leaks input order).
 *  - Output `.sort((a,b) => b.score - a.score)` had no entityId tiebreaker,
 *    so map iteration order (= first-seen order) leaked into the output when
 *    scores tied.
 *  - NaN scores could silently "stick" as the winner because NaN comparisons
 *    are always false, so a finite competitor never replaced them.
 */

import { describe, it, expect } from 'vitest';
import { dedupeSparseHitsByEntity } from '../../src/domain/retrieval/service/browse-diversity.js';
import type { SparseHit } from '../../src/domain/retrieval/port/search-index.port.js';
import { createEntityId } from '../../src/domain/shared/types/index.js';

function mkHit(id: string, score: number, rank: number): SparseHit {
  return {
    entityId: createEntityId(id),
    score,
    rank,
    matchedFields: [],
  };
}

describe('dedupeSparseHitsByEntity — determinism', () => {
  it('produces the same output regardless of input ordering when scores tie', () => {
    const a = mkHit('wine:alpha', 1.0, 1);
    const b = mkHit('wine:beta', 1.0, 2);
    const c = mkHit('wine:gamma', 1.0, 3);

    const forward = dedupeSparseHitsByEntity([a, b, c]).map((h) => String(h.entityId));
    const reverse = dedupeSparseHitsByEntity([c, b, a]).map((h) => String(h.entityId));
    const mixed = dedupeSparseHitsByEntity([b, a, c]).map((h) => String(h.entityId));

    // Lexicographic tiebreak: alpha, beta, gamma for every permutation.
    expect(forward).toEqual(['wine:alpha', 'wine:beta', 'wine:gamma']);
    expect(reverse).toEqual(['wine:alpha', 'wine:beta', 'wine:gamma']);
    expect(mixed).toEqual(['wine:alpha', 'wine:beta', 'wine:gamma']);
  });

  it('deduplicates repeated entities by keeping the strongest score', () => {
    const weak = mkHit('wine:x', 0.4, 10);
    const strong = mkHit('wine:x', 0.9, 2);

    expect(dedupeSparseHitsByEntity([weak, strong])[0]?.score).toBe(0.9);
    expect(dedupeSparseHitsByEntity([strong, weak])[0]?.score).toBe(0.9);
  });

  it('NaN scores never beat a finite score, in either order', () => {
    const nanHit = mkHit('wine:x', Number.NaN, 1);
    const finiteHit = mkHit('wine:x', 0.5, 2);

    const a = dedupeSparseHitsByEntity([nanHit, finiteHit]);
    const b = dedupeSparseHitsByEntity([finiteHit, nanHit]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]?.score).toBe(0.5);
    expect(b[0]?.score).toBe(0.5);
  });

  it('falls back to rank then entityId when scores tie for the same entity', () => {
    const earlier = mkHit('wine:x', 0.7, 3);
    const later = mkHit('wine:x', 0.7, 9);

    // Lower rank wins the tie.
    expect(dedupeSparseHitsByEntity([later, earlier])[0]?.rank).toBe(3);
    expect(dedupeSparseHitsByEntity([earlier, later])[0]?.rank).toBe(3);
  });

  it('output is sorted descending by score with entityId tiebreak', () => {
    const hits: SparseHit[] = [
      mkHit('wine:c', 0.5, 5),
      mkHit('wine:a', 0.9, 1),
      mkHit('wine:b', 0.5, 4),
    ];
    const result = dedupeSparseHitsByEntity(hits).map((h) => String(h.entityId));
    expect(result).toEqual(['wine:a', 'wine:b', 'wine:c']);
  });
});
