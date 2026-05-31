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
 *  - The fix introduces TWO weight maps + a feature flag so the
 *    DETUNED behaviour remains the production default while the EPIC-5
 *    RFC-017 §6.3 target weights can be activated in bench / staging via
 *    `RERANK_BLEND_EPIC5_RESTORE=1`. Activating in production requires
 *    LTR calibration eval to confirm no regression.
 *
 * Layer refactor (2026-06): the domain blend table no longer reads
 * `process.env` directly. The flag is now validated by the retrieval env
 * schema (`RERANK_BLEND_EPIC5_RESTORE`) and INJECTED into the domain
 * functions as a plain boolean. Behaviour is unchanged — only the seam
 * moved from ambient env to an explicit argument. This suite is updated to
 * drive the injected boolean directly (no env mutation), plus a new case
 * (f) that pins the env-schema coercion to the exact legacy truthiness so
 * the `'1' | 'true'`-only contract is still guarded at the boundary.
 *
 * Append-only per CLAUDE.md regression discipline. These tests guard:
 *   (a) DETUNED remains the default (production parity, no silent change)
 *   (b) the EPIC-5 map matches RFC-017 §6.3 exactly
 *   (c) both maps cover the same QueryClass key set (drift prevention)
 *   (d) the injected flag flips `getRerankBlendWeights()` deterministically
 *   (e) `effectiveRerankBlendWeight` honours the flag via the same path
 *   (f) the env schema coerces ONLY '1'/'true' to true (legacy parity)
 */

import { describe, expect, it } from 'vitest';
import type { QueryClass } from '../../src/domain/shared/types/query-class.js';
import {
  effectiveRerankBlendWeight,
  getRerankBlendWeights,
  __RERANK_BLEND_DETUNED,
  __RERANK_BLEND_EPIC5,
} from '../../src/domain/ranking/service/rerank-blend.js';
import { RetrievalEnvSchema } from '../../src/config/env-schemas/retrieval.schema.js';

/** Parse only the Epic-5 flag through the real env schema and read its boolean. */
function coerceEpic5Flag(raw: string | undefined): boolean {
  const env: Record<string, string> = {};
  if (raw !== undefined) {
    env.RERANK_BLEND_EPIC5_RESTORE = raw;
  }
  return RetrievalEnvSchema.parse(env).RERANK_BLEND_EPIC5_RESTORE;
}

describe('rerank-blend Epic-5 gated feature flag (regression)', () => {
  describe('(a) production default: DETUNED', () => {
    it('flag off → returns DETUNED map', () => {
      expect(getRerankBlendWeights(false)).toBe(__RERANK_BLEND_DETUNED);
    });

    it('flag off → semantic_preference is 0.18 (pre-fix production value)', () => {
      expect(getRerankBlendWeights(false).semantic_preference).toBe(0.18);
    });

    it('flag off → pure_constraint is 0.12 (pre-fix production value)', () => {
      expect(getRerankBlendWeights(false).pure_constraint).toBe(0.12);
    });

    it('env empty string → coerces OFF (only 1/true activates)', () => {
      expect(coerceEpic5Flag('')).toBe(false);
      expect(getRerankBlendWeights(coerceEpic5Flag(''))).toBe(__RERANK_BLEND_DETUNED);
    });

    it('env "0" → coerces OFF', () => {
      expect(coerceEpic5Flag('0')).toBe(false);
      expect(getRerankBlendWeights(coerceEpic5Flag('0'))).toBe(__RERANK_BLEND_DETUNED);
    });

    it('env "false" → coerces OFF (only literal 1 / true activates)', () => {
      expect(coerceEpic5Flag('false')).toBe(false);
      expect(getRerankBlendWeights(coerceEpic5Flag('false'))).toBe(__RERANK_BLEND_DETUNED);
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

  describe('(d) injected flag flips getRerankBlendWeights() deterministically', () => {
    it('epic5Restore=true → EPIC-5 map active', () => {
      expect(getRerankBlendWeights(true)).toBe(__RERANK_BLEND_EPIC5);
      expect(getRerankBlendWeights(true).semantic_preference).toBe(0.75);
      expect(getRerankBlendWeights(true).pure_constraint).toBe(0.70);
    });

    it('env "1" coerces true → EPIC-5 map active', () => {
      expect(coerceEpic5Flag('1')).toBe(true);
      expect(getRerankBlendWeights(coerceEpic5Flag('1'))).toBe(__RERANK_BLEND_EPIC5);
    });

    it('env "true" coerces true → EPIC-5 map active', () => {
      expect(coerceEpic5Flag('true')).toBe(true);
      expect(getRerankBlendWeights(coerceEpic5Flag('true'))).toBe(__RERANK_BLEND_EPIC5);
    });

    it('toggling the injected flag returns the matching map each time', () => {
      // No memoization / stale snapshot: per-call resolution from the argument.
      expect(getRerankBlendWeights(false)).toBe(__RERANK_BLEND_DETUNED);
      expect(getRerankBlendWeights(true)).toBe(__RERANK_BLEND_EPIC5);
      expect(getRerankBlendWeights(false)).toBe(__RERANK_BLEND_DETUNED);
    });
  });

  describe('(e) effectiveRerankBlendWeight honours the flag', () => {
    it('flag off + scale=1 → DETUNED weight passes through', () => {
      expect(effectiveRerankBlendWeight('semantic_preference', 1, false)).toBeCloseTo(0.18, 10);
      expect(effectiveRerankBlendWeight('pure_constraint', 1, false)).toBeCloseTo(0.12, 10);
    });

    it('flag on + scale=1 → EPIC-5 weight passes through', () => {
      expect(effectiveRerankBlendWeight('semantic_preference', 1, true)).toBeCloseTo(0.75, 10);
      expect(effectiveRerankBlendWeight('pure_constraint', 1, true)).toBeCloseTo(0.70, 10);
    });

    it('global scale still multiplies under both regimes', () => {
      expect(effectiveRerankBlendWeight('semantic_preference', 0.5, false)).toBeCloseTo(0.09, 10);
      expect(effectiveRerankBlendWeight('semantic_preference', 0.5, true)).toBeCloseTo(0.375, 10);
    });

    it('non-finite global scale falls back to 1.0 under both regimes', () => {
      expect(effectiveRerankBlendWeight('semantic_preference', Number.NaN, false)).toBeCloseTo(0.18, 10);
      expect(effectiveRerankBlendWeight('semantic_preference', Number.NaN, true)).toBeCloseTo(0.75, 10);
    });
  });

  describe('(f) env schema coerces ONLY 1/true (legacy truthiness parity)', () => {
    it('unset → defaults to false', () => {
      expect(coerceEpic5Flag(undefined)).toBe(false);
    });

    it('"1" and "true" → true; everything else → false', () => {
      expect(coerceEpic5Flag('1')).toBe(true);
      expect(coerceEpic5Flag('true')).toBe(true);
      // Legacy reader matched neither of these — schema must agree.
      expect(coerceEpic5Flag('0')).toBe(false);
      expect(coerceEpic5Flag('false')).toBe(false);
      expect(coerceEpic5Flag('')).toBe(false);
      expect(coerceEpic5Flag('yes')).toBe(false);
      expect(coerceEpic5Flag('TRUE')).toBe(false);
      expect(coerceEpic5Flag('2')).toBe(false);
    });
  });
});
