/**
 * Regression: rerank blend EPIC-5 restore is GATED behind a feature flag.
 *
 * Guards the gated production-risk fix introduced 2026-05-26:
 *
 *  - `src/domain/ranking/service/rerank-blend.ts` was 76% / 83% detuned vs
 *    RFC-017 §6.3 (`0.18 / 0.12` vs `0.75 / 0.70`). The detuned values
 *    were intentional pending LTR calibration (Epic 5) but the gap is
 *    large enough that the cross-encoder reranker's contribution is
 *    effectively suppressed.
 *
 *  - The fix introduces TWO weight maps + an env feature flag so the
 *    DETUNED behaviour remains the production default while the EPIC-5
 *    RFC-017 §6.3 target weights can be activated in bench / staging via
 *    `RERANK_BLEND_EPIC5_RESTORE=1`. Activating in production requires
 *    LTR calibration eval to confirm no regression.
 *
 * Append-only per CLAUDE.md regression discipline. These tests guard:
 *   (a) DETUNED remains the default (production parity, no silent change)
 *   (b) the EPIC-5 map matches RFC-017 §6.3 exactly
 *   (c) both maps cover the same QueryClass key set (drift prevention)
 *   (d) the env flag flips `getRerankBlendWeights()` deterministically
 *   (e) `effectiveRerankBlendWeight` honours the flag via the same path
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QueryClass } from '../../src/domain/shared/types/query-class.js';
import {
  effectiveRerankBlendWeight,
  getRerankBlendWeights,
  isRerankBlendEpic5RestoreEnabled,
  __RERANK_BLEND_DETUNED,
  __RERANK_BLEND_EPIC5,
} from '../../src/domain/ranking/service/rerank-blend.js';

describe('rerank-blend Epic-5 gated feature flag (regression)', () => {
  let originalFlag: string | undefined;

  beforeEach(() => {
    originalFlag = process.env.RERANK_BLEND_EPIC5_RESTORE;
    delete process.env.RERANK_BLEND_EPIC5_RESTORE;
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.RERANK_BLEND_EPIC5_RESTORE;
    } else {
      process.env.RERANK_BLEND_EPIC5_RESTORE = originalFlag;
    }
  });

  describe('(a) production default: DETUNED', () => {
    it('default (no env) → returns DETUNED map', () => {
      expect(isRerankBlendEpic5RestoreEnabled()).toBe(false);
      expect(getRerankBlendWeights()).toBe(__RERANK_BLEND_DETUNED);
    });

    it('default → semantic_preference is 0.18 (pre-fix production value)', () => {
      expect(getRerankBlendWeights().semantic_preference).toBe(0.18);
    });

    it('default → pure_constraint is 0.12 (pre-fix production value)', () => {
      expect(getRerankBlendWeights().pure_constraint).toBe(0.12);
    });

    it('flag set to empty string → still OFF (only 1/true activates)', () => {
      process.env.RERANK_BLEND_EPIC5_RESTORE = '';
      expect(isRerankBlendEpic5RestoreEnabled()).toBe(false);
      expect(getRerankBlendWeights()).toBe(__RERANK_BLEND_DETUNED);
    });

    it('flag set to 0 → OFF', () => {
      process.env.RERANK_BLEND_EPIC5_RESTORE = '0';
      expect(isRerankBlendEpic5RestoreEnabled()).toBe(false);
      expect(getRerankBlendWeights()).toBe(__RERANK_BLEND_DETUNED);
    });

    it('flag set to "false" → OFF (only literal 1 / true activates)', () => {
      process.env.RERANK_BLEND_EPIC5_RESTORE = 'false';
      expect(isRerankBlendEpic5RestoreEnabled()).toBe(false);
      expect(getRerankBlendWeights()).toBe(__RERANK_BLEND_DETUNED);
    });
  });

  describe('(b) EPIC-5 map matches RFC-017 §6.3', () => {
    it('semantic_preference === 0.75', () => {
      expect(__RERANK_BLEND_EPIC5.semantic_preference).toBe(0.75);
    });

    it('pure_constraint === 0.70', () => {
      expect(__RERANK_BLEND_EPIC5.pure_constraint).toBe(0.70);
    });

    it('comparison_query === 0.65', () => {
      expect(__RERANK_BLEND_EPIC5.comparison_query).toBe(0.65);
    });

    it('ambiguous_short_form === 0.65', () => {
      expect(__RERANK_BLEND_EPIC5.ambiguous_short_form).toBe(0.65);
    });

    it('anchored_similarity === 0.60', () => {
      expect(__RERANK_BLEND_EPIC5.anchored_similarity).toBe(0.60);
    });

    it('short_entity === 0.40', () => {
      expect(__RERANK_BLEND_EPIC5.short_entity).toBe(0.40);
    });

    it('exact_entity and unknown remain at DETUNED (RFC-017 §6.3 unspecified)', () => {
      // RFC-017 §6.3 does NOT specify exact_entity / unknown; we hold them
      // at DETUNED intentionally rather than guessing a scale-up factor.
      expect(__RERANK_BLEND_EPIC5.exact_entity).toBe(__RERANK_BLEND_DETUNED.exact_entity);
      expect(__RERANK_BLEND_EPIC5.unknown).toBe(__RERANK_BLEND_DETUNED.unknown);
    });
  });

  describe('(c) drift prevention: maps cover identical QueryClass key sets', () => {
    it('DETUNED and EPIC-5 expose exactly the same keys', () => {
      const detunedKeys = new Set(Object.keys(__RERANK_BLEND_DETUNED));
      const epic5Keys = new Set(Object.keys(__RERANK_BLEND_EPIC5));
      expect(epic5Keys).toEqual(detunedKeys);
    });

    it('all values in DETUNED are finite numbers in [0, 1]', () => {
      for (const v of Object.values(__RERANK_BLEND_DETUNED)) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    });

    it('all values in EPIC-5 are finite numbers in [0, 1]', () => {
      for (const v of Object.values(__RERANK_BLEND_EPIC5)) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    });

    it('EPIC-5 weights are ≥ DETUNED weights for every class (restore = raise or hold)', () => {
      // The restore must never DECREASE a weight; otherwise the flag would
      // suppress, not restore, the reranker. This catches accidental swaps.
      const classes = Object.keys(__RERANK_BLEND_DETUNED) as ReadonlyArray<QueryClass>;
      for (const qc of classes) {
        expect(__RERANK_BLEND_EPIC5[qc]).toBeGreaterThanOrEqual(__RERANK_BLEND_DETUNED[qc]);
      }
    });
  });

  describe('(d) env flag flips getRerankBlendWeights() deterministically', () => {
    it('RERANK_BLEND_EPIC5_RESTORE=1 → EPIC-5 map active', () => {
      process.env.RERANK_BLEND_EPIC5_RESTORE = '1';
      expect(isRerankBlendEpic5RestoreEnabled()).toBe(true);
      expect(getRerankBlendWeights()).toBe(__RERANK_BLEND_EPIC5);
      expect(getRerankBlendWeights().semantic_preference).toBe(0.75);
      expect(getRerankBlendWeights().pure_constraint).toBe(0.70);
    });

    it('RERANK_BLEND_EPIC5_RESTORE=true → EPIC-5 map active', () => {
      process.env.RERANK_BLEND_EPIC5_RESTORE = 'true';
      expect(isRerankBlendEpic5RestoreEnabled()).toBe(true);
      expect(getRerankBlendWeights()).toBe(__RERANK_BLEND_EPIC5);
    });

    it('toggling flag between calls returns the matching map each time', () => {
      // No memoization / stale snapshot: tests can rely on per-call resolution.
      delete process.env.RERANK_BLEND_EPIC5_RESTORE;
      expect(getRerankBlendWeights()).toBe(__RERANK_BLEND_DETUNED);
      process.env.RERANK_BLEND_EPIC5_RESTORE = '1';
      expect(getRerankBlendWeights()).toBe(__RERANK_BLEND_EPIC5);
      delete process.env.RERANK_BLEND_EPIC5_RESTORE;
      expect(getRerankBlendWeights()).toBe(__RERANK_BLEND_DETUNED);
    });
  });

  describe('(e) effectiveRerankBlendWeight honours the flag', () => {
    it('default (flag off) + scale=1 → DETUNED weight passes through', () => {
      delete process.env.RERANK_BLEND_EPIC5_RESTORE;
      expect(effectiveRerankBlendWeight('semantic_preference', 1)).toBeCloseTo(0.18, 10);
      expect(effectiveRerankBlendWeight('pure_constraint', 1)).toBeCloseTo(0.12, 10);
    });

    it('flag on + scale=1 → EPIC-5 weight passes through', () => {
      process.env.RERANK_BLEND_EPIC5_RESTORE = '1';
      expect(effectiveRerankBlendWeight('semantic_preference', 1)).toBeCloseTo(0.75, 10);
      expect(effectiveRerankBlendWeight('pure_constraint', 1)).toBeCloseTo(0.70, 10);
    });

    it('global scale still multiplies under both regimes', () => {
      delete process.env.RERANK_BLEND_EPIC5_RESTORE;
      expect(effectiveRerankBlendWeight('semantic_preference', 0.5)).toBeCloseTo(0.09, 10);
      process.env.RERANK_BLEND_EPIC5_RESTORE = '1';
      expect(effectiveRerankBlendWeight('semantic_preference', 0.5)).toBeCloseTo(0.375, 10);
    });

    it('non-finite global scale falls back to 1.0 under both regimes', () => {
      delete process.env.RERANK_BLEND_EPIC5_RESTORE;
      expect(effectiveRerankBlendWeight('semantic_preference', Number.NaN)).toBeCloseTo(0.18, 10);
      process.env.RERANK_BLEND_EPIC5_RESTORE = '1';
      expect(effectiveRerankBlendWeight('semantic_preference', Number.NaN)).toBeCloseTo(0.75, 10);
    });
  });
});
