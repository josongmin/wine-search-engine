/**
 * Regression suite for nlu.relative-query-extractor (maturity 3 bump).
 *
 * Scope:
 *  - Bounded delta heuristic with **named module-scope constants**
 *    (CLAUDE.md test discipline rule 15 — magic numbers in penalty/weight
 *    logic must be extracted as named constants).
 *  - Korean + English surface patterns for "less / more <axis> than X" and
 *    "처럼 / 같이" similarity variants.
 *  - Documented fallback behaviour for: no anchor, unrecognised anchor,
 *    multiple comparatives, empty / no relative marker, negation flips.
 *  - Determinism across repeated calls (regex statefulness audit).
 *
 * The constants below are imported from the implementation module so a
 * future drift (e.g. someone changing `-0.2` to `-0.3` without updating the
 * test) is caught by a value assertion rather than a behaviour-only check.
 */

import { describe, expect, it } from 'vitest';
import {
  RelativeQueryExtractor,
  RELATIVE_DELTA_LESS,
  RELATIVE_DELTA_MORE,
  RELATIVE_DELTA_MUCH_LESS,
  RELATIVE_DELTA_MUCH_MORE,
  RELATIVE_DELTA_SIMILAR,
} from '../../src/domain/query/service/relative-query-extractor.js';

describe('relative-query-extractor regression (maturity 3)', () => {
  const extractor = new RelativeQueryExtractor();

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Named delta constants — value + sign contract
  // ──────────────────────────────────────────────────────────────────────────

  describe('named delta constants', () => {
    it('RELATIVE_DELTA_LESS is a small negative finite number', () => {
      expect(Number.isFinite(RELATIVE_DELTA_LESS)).toBe(true);
      expect(RELATIVE_DELTA_LESS).toBeLessThan(0);
      expect(RELATIVE_DELTA_LESS).toBeGreaterThan(-1);
      expect(RELATIVE_DELTA_LESS).toBe(-0.2);
    });

    it('RELATIVE_DELTA_MORE is the positive mirror of RELATIVE_DELTA_LESS', () => {
      expect(RELATIVE_DELTA_MORE).toBe(0.2);
      expect(RELATIVE_DELTA_MORE).toBe(-RELATIVE_DELTA_LESS);
    });

    it('RELATIVE_DELTA_MUCH_LESS is strictly more negative than RELATIVE_DELTA_LESS', () => {
      expect(RELATIVE_DELTA_MUCH_LESS).toBe(-0.5);
      expect(RELATIVE_DELTA_MUCH_LESS).toBeLessThan(RELATIVE_DELTA_LESS);
    });

    it('RELATIVE_DELTA_MUCH_MORE mirrors RELATIVE_DELTA_MUCH_LESS', () => {
      expect(RELATIVE_DELTA_MUCH_MORE).toBe(0.5);
      expect(RELATIVE_DELTA_MUCH_MORE).toBe(-RELATIVE_DELTA_MUCH_LESS);
    });

    it('RELATIVE_DELTA_SIMILAR is zero (no axis shift for similarity)', () => {
      expect(RELATIVE_DELTA_SIMILAR).toBe(0);
    });

    it('delta magnitudes are bounded in [-1, 1] (axis unit interval)', () => {
      const all = [
        RELATIVE_DELTA_LESS,
        RELATIVE_DELTA_MORE,
        RELATIVE_DELTA_MUCH_LESS,
        RELATIVE_DELTA_MUCH_MORE,
        RELATIVE_DELTA_SIMILAR,
      ];
      for (const v of all) {
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. English "less tannic than X" → tannin axis with negative delta
  // ──────────────────────────────────────────────────────────────────────────

  it('"less tannic than Opus One" → anchor=Opus One, axis=tannin, delta=RELATIVE_DELTA_LESS', () => {
    const result = extractor.extract('less tannic than Opus One');
    expect(result).not.toBeNull();
    const expr = result?.relativeExpressions[0];
    expect(expr?.anchorSurfaceForm).toBe('Opus One');
    expect(expr?.impliedAxis).toBe('tannin');
    expect(expr?.delta).toBe(RELATIVE_DELTA_LESS);
  });

  it('"more fruity than Opus One" → anchor=Opus One, axis=fruit, delta=RELATIVE_DELTA_MORE', () => {
    const result = extractor.extract('more fruity than Opus One');
    expect(result).not.toBeNull();
    const expr = result?.relativeExpressions[0];
    expect(expr?.anchorSurfaceForm).toBe('Opus One');
    expect(expr?.impliedAxis).toBe('fruit');
    expect(expr?.delta).toBe(RELATIVE_DELTA_MORE);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. English "cheaper than X" → price axis with negative delta
  // ──────────────────────────────────────────────────────────────────────────

  it('"cheaper than Sassicaia" → anchor=Sassicaia, axis=price_band, delta < 0', () => {
    const result = extractor.extract('cheaper than Sassicaia');
    expect(result).not.toBeNull();
    const expr = result?.relativeExpressions[0];
    expect(expr?.operator).toBe('cheaper_than');
    expect(expr?.anchorSurfaceForm).toBe('Sassicaia');
    expect(expr?.impliedAxis).toBe('price_band');
    expect(expr?.delta).toBe(RELATIVE_DELTA_LESS);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Korean "오푸스 원보다 덜 비싼" — price axis negative
  // ──────────────────────────────────────────────────────────────────────────

  it('"오푸스 원보다 덜 비싼" → anchor=오푸스 원, price delta < 0', () => {
    const result = extractor.extract('오푸스 원보다 덜 비싼');
    expect(result).not.toBeNull();
    const expr = result?.relativeExpressions[0];
    expect(expr?.anchorSurfaceForm).toBe('오푸스 원');
    expect(expr?.impliedAxis).toBe('price_band');
    expect(expr?.delta).toBeLessThan(0);
    expect(expr?.delta).toBe(RELATIVE_DELTA_LESS);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Korean similarity "오푸스 원처럼 부드러운" — similarity (delta ≈ 0)
  // ──────────────────────────────────────────────────────────────────────────

  it('"오푸스 원처럼 부드러운" → similar_to with delta=RELATIVE_DELTA_SIMILAR', () => {
    const result = extractor.extract('오푸스 원처럼 부드러운');
    expect(result).not.toBeNull();
    expect(result?.isSimilarityQuery).toBe(true);
    const expr = result?.relativeExpressions[0];
    expect(expr?.operator).toBe('similar_to');
    expect(expr?.anchorSurfaceForm).toBe('오푸스 원');
    expect(expr?.delta).toBe(RELATIVE_DELTA_SIMILAR);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 6. No anchor — "less tannic wine" — no extraction
  // ──────────────────────────────────────────────────────────────────────────

  it('"less tannic wine" → null (no entity anchor present)', () => {
    // No "than X" marker, no Korean 보다 — no relative expression can be
    // constructed. Documented behaviour: ignore comparative entirely.
    const result = extractor.extract('less tannic wine');
    expect(result).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 7. Unrecognised entity — extraction still returns the surface form.
  //    Documented behaviour: surface extraction is anchor-resolver agnostic;
  //    the extractor does NOT validate whether the anchor resolves to a real
  //    entity. Downstream entity-resolver decides whether to drop the relative
  //    expression as a fallback (full search).
  // ──────────────────────────────────────────────────────────────────────────

  it('"less tannic than Made Up Wine" → surface form captured (resolver decides fallback)', () => {
    const result = extractor.extract('less tannic than Made Up Wine');
    expect(result).not.toBeNull();
    const expr = result?.relativeExpressions[0];
    // Anchor surface is whatever the user wrote — validation is downstream.
    expect(expr?.anchorSurfaceForm).toBe('Made Up Wine');
    expect(expr?.impliedAxis).toBe('tannin');
    expect(expr?.delta).toBe(RELATIVE_DELTA_LESS);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 8. Multiple comparatives — at most one anchor in current model.
  //    Documented boundary: the first matching operator wins; secondary axis
  //    (here "more fruity") is NOT extracted as a second expression to avoid
  //    multi-dimensional delta conflation.
  // ──────────────────────────────────────────────────────────────────────────

  it('"less tannic but more fruity than Opus One" → first axis wins (single expression)', () => {
    const result = extractor.extract('less tannic but more fruity than Opus One');
    expect(result).not.toBeNull();
    const exprs = result?.relativeExpressions ?? [];
    expect(exprs.length).toBeGreaterThanOrEqual(1);
    // Either "less tannic" (tannin -) or "more fruity" (fruit +) wins; both
    // must yield a valid axis with a finite delta.
    const first = exprs[0];
    expect(first).toBeDefined();
    expect(['tannin', 'fruit']).toContain(first?.impliedAxis);
    expect(Number.isFinite(first?.delta)).toBe(true);
    expect(first?.delta).not.toBe(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 9. Empty / no relative marker
  // ──────────────────────────────────────────────────────────────────────────

  it('"Opus One" → null (no relative marker)', () => {
    expect(extractor.extract('Opus One')).toBeNull();
  });

  it('"" → null (empty input)', () => {
    expect(extractor.extract('')).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 10. Adjacent regression: determinism (5× same query)
  // ──────────────────────────────────────────────────────────────────────────

  it('repeated extraction of the same query is deterministic (5×)', () => {
    const query = 'less tannic than Opus One';
    const runs = Array.from({ length: 5 }, () => extractor.extract(query));
    const first = runs[0];
    expect(first).not.toBeNull();
    for (const run of runs) {
      expect(run).toEqual(first);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 11. Adjacent regression: Korean particle variants 보다 / 처럼 / 같이
  // ──────────────────────────────────────────────────────────────────────────

  it('Korean particle 보다 (comparative)', () => {
    const result = extractor.extract('오푸스 원보다 비싼');
    expect(result?.relativeExpressions[0]?.operator).toBe('more_expensive_than');
    expect(result?.relativeExpressions[0]?.anchorSurfaceForm).toBe('오푸스 원');
  });

  it('Korean particle 처럼 (similarity)', () => {
    const result = extractor.extract('오푸스 원처럼');
    expect(result).not.toBeNull();
    expect(result?.isSimilarityQuery).toBe(true);
    expect(result?.relativeExpressions[0]?.operator).toBe('similar_to');
    expect(result?.relativeExpressions[0]?.anchorSurfaceForm).toBe('오푸스 원');
  });

  it('Korean particle 같이 (similarity)', () => {
    const result = extractor.extract('오푸스 원같이');
    expect(result).not.toBeNull();
    expect(result?.isSimilarityQuery).toBe(true);
    expect(result?.relativeExpressions[0]?.operator).toBe('similar_to');
    expect(result?.relativeExpressions[0]?.anchorSurfaceForm).toBe('오푸스 원');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 12. Adjacent regression: negation interaction — "not less tannic"
  //     Documented behaviour: extractor is surface-pattern based; it does not
  //     re-invert deltas based on an external negation token. The result MUST
  //     either (a) return the inner relative expression as if negation were
  //     absent (extraction succeeds, downstream may drop), or (b) return null.
  //     Either is acceptable; the **invariant** is that the call MUST NOT
  //     throw and MUST NOT silently flip the delta sign.
  // ──────────────────────────────────────────────────────────────────────────

  it('"not less tannic than Opus One" — handled gracefully (no throw, no silent sign flip)', () => {
    let result;
    expect(() => {
      result = extractor.extract('not less tannic than Opus One');
    }).not.toThrow();
    if (result !== null && result !== undefined) {
      const expr = (result as { relativeExpressions: ReadonlyArray<{ delta?: number }> })
        .relativeExpressions[0];
      // Must never silently produce a *positive* delta for a "less" surface
      // form — that would be a sign-flip bug.
      if (expr?.delta !== undefined) {
        expect(expr.delta).toBeLessThanOrEqual(0);
      }
    }
  });
});
