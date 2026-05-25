/**
 * SSoT regression: every RRF K smoothing constant lives in
 * `@shared/utils/rrf.ts` (`RRF_K` table). Rule 30 SSoT.
 *
 * History: `per-class-fusion-config.ts` previously defined private literal
 * `const RRF_K_TIGHT = 30`, `RRF_K_ENTITY_EXACT = 10`, `RRF_K_COMPARE = 40`,
 * `RRF_K_LOOSE = 80` alongside the imported `RRF_DEFAULT_K = 60` from
 * `rrf.ts`. That split risked silent drift — a sweep harness or calibration
 * pass that bumps the canonical K in `rrf.ts` (e.g. 60 → 50) would leave the
 * per-class variants stuck on the old offsets, breaking the ordering
 * relationship (ENTITY_EXACT < TIGHT < COMPARE < DEFAULT < LOOSE).
 *
 * Invariants locked here:
 *  - `RRF_K` exposes exactly the five named members the retrieval pipeline
 *    relies on (ENTITY_EXACT, TIGHT, COMPARE, DEFAULT, LOOSE) with the
 *    expected numeric values.
 *  - `RRF_DEFAULT_K === RRF_K.DEFAULT` (backward-compat alias preserved).
 *  - Strict monotonic ordering ENTITY_EXACT < TIGHT < COMPARE < DEFAULT < LOOSE.
 *  - Every `PER_CLASS_FUSION` entry's `rrfK` matches a value from `RRF_K` —
 *    i.e. per-class-fusion-config never reintroduces a private literal.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { RRF_DEFAULT_K, RRF_K } from '@shared/utils/rrf.js';
import {
  PER_CLASS_FUSION,
  type QueryClass,
} from '../../src/domain/retrieval/service/per-class-fusion-config.js';

describe('SSoT: RRF_K table shape and values', () => {
  it('exposes the five named members with expected values', () => {
    expect(RRF_K.ENTITY_EXACT).toBe(10);
    expect(RRF_K.TIGHT).toBe(30);
    expect(RRF_K.COMPARE).toBe(40);
    expect(RRF_K.DEFAULT).toBe(60);
    expect(RRF_K.LOOSE).toBe(80);
  });

  it('has exactly five members (no silent additions without a regression bump)', () => {
    expect(Object.keys(RRF_K).sort()).toEqual(
      ['COMPARE', 'DEFAULT', 'ENTITY_EXACT', 'LOOSE', 'TIGHT'].sort(),
    );
  });

  it('RRF_DEFAULT_K is backward-compatible alias of RRF_K.DEFAULT', () => {
    expect(RRF_DEFAULT_K).toBe(RRF_K.DEFAULT);
    expect(RRF_DEFAULT_K).toBe(60);
  });

  it('K values are strictly monotonic ENTITY_EXACT < TIGHT < COMPARE < DEFAULT < LOOSE', () => {
    expect(RRF_K.ENTITY_EXACT).toBeLessThan(RRF_K.TIGHT);
    expect(RRF_K.TIGHT).toBeLessThan(RRF_K.COMPARE);
    expect(RRF_K.COMPARE).toBeLessThan(RRF_K.DEFAULT);
    expect(RRF_K.DEFAULT).toBeLessThan(RRF_K.LOOSE);
  });
});

describe('SSoT: per-class-fusion-config uses RRF_K values', () => {
  it('every PER_CLASS_FUSION.rrfK matches a member of RRF_K (no private literals)', () => {
    const allowed = new Set<number>(Object.values(RRF_K));
    for (const [cls, cfg] of PER_CLASS_FUSION.entries()) {
      expect(
        allowed.has(cfg.rrfK),
        `class ${cls} has rrfK=${cfg.rrfK} which is not in RRF_K SSoT`,
      ).toBe(true);
    }
  });

  it('expected per-class K assignments are wired through RRF_K', () => {
    const expected: Record<QueryClass, number> = {
      specific_wine: RRF_K.TIGHT,
      entity_exact: RRF_K.ENTITY_EXACT,
      browse: RRF_K.DEFAULT,
      compare: RRF_K.COMPARE,
      pairing: RRF_K.LOOSE,
      fallback: RRF_K.DEFAULT,
    };
    for (const [cls, k] of Object.entries(expected) as Array<
      [QueryClass, number]
    >) {
      const cfg = PER_CLASS_FUSION.get(cls);
      expect(cfg, `missing config for ${cls}`).toBeDefined();
      expect(cfg!.rrfK, `class ${cls} rrfK`).toBe(k);
    }
  });
});
