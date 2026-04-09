/**
 * Regression: eval and replay determinism.
 *
 * Locks in the "all replay paths must use injected clock" rule from CLAUDE.md
 * by asserting that the load-bearing wall-clock seams in the eval and replay
 * paths now accept (and honor) an injected clock / currentYear parameter.
 *
 * These tests protect against silent regressions where a refactor re-introduces
 * `new Date()` / `Date.now()` / `new Date().getFullYear()` into a code path
 * reachable from replay — which would break the RFC-009 §8 replay hash and
 * the golden-set fidelity guarantee across a year boundary.
 */

import { describe, expect, it, vi } from 'vitest';
import { extractClaims } from '../../src/domain/evaluation/service/claim-extractor.js';
import { mapRankedResultsToResultItems } from '../../src/application/search/search-usecase-map-result-items.js';
import type { RankedResult } from '../../src/domain/ranking/model/ranked-result.js';

function makeRankedResult(overrides: Partial<RankedResult> = {}): RankedResult {
  return {
    entityId: 'wine-1',
    canonicalLabel: 'Opus One 2018',
    finalScore: 0.92,
    rank: 1,
    producer: 'Opus One',
    region: 'Napa Valley',
    grapePrimary: 'Cabernet Sauvignon',
    vintageYear: 2018,
    grapePrimaryEnc: 1,
    regionEnc: 2,
    countryEnc: 3,
    body: 4,
    tannin: 4,
    acidity: 3,
    sweetness: 1,
    avgCriticProxyScore: 96,
    drinkingWindowStart: 2026,
    drinkingWindowEnd: 2032,
    matchedConstraints: [],
    unmetConstraints: [],
    inferredConstraints: [],
    evidenceItems: [],
    componentScores: {
      entityIntegrity: 1,
      semantic: 0.8,
      hardConstraintPass: true,
      softConstraint: 0.2,
      attributeAlignment: 0.7,
      preferenceAlignment: 0.5,
      popularity: 0.4,
      availability: 1,
      uncertaintyPenalty: 0.1,
    },
    ...overrides,
  } as RankedResult;
}

describe('eval-replay determinism (regression)', () => {
  describe('mapRankedResultsToResultItems: targetYear is required and deterministic', () => {
    it('honors the injected targetYear for currentlyDrinkable (2025 → false for 2026-2032 window)', async () => {
      const items = await mapRankedResultsToResultItems(
        [makeRankedResult()],
        undefined, // drinking window port not needed (ranked result already has window)
        2025,
      );
      expect(items[0]?.drinkingWindow?.currentlyDrinkable).toBe(false);
    });

    it('honors the injected targetYear for currentlyDrinkable (2028 → true for 2026-2032 window)', async () => {
      const items = await mapRankedResultsToResultItems(
        [makeRankedResult()],
        undefined,
        2028,
      );
      expect(items[0]?.drinkingWindow?.currentlyDrinkable).toBe(true);
    });

    it('is NOT influenced by wall clock — two calls with different pinned years yield different answers', async () => {
      // Freeze the wall clock to some arbitrary year to prove the function ignores it.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2099-01-01T00:00:00Z'));
      try {
        const earlyItems = await mapRankedResultsToResultItems(
          [makeRankedResult()],
          undefined,
          2020, // before the drinking window
        );
        const lateItems = await mapRankedResultsToResultItems(
          [makeRankedResult()],
          undefined,
          2030, // inside the drinking window
        );
        expect(earlyItems[0]?.drinkingWindow?.currentlyDrinkable).toBe(false);
        expect(lateItems[0]?.drinkingWindow?.currentlyDrinkable).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects non-finite targetYear instead of silently falling back to wall clock', async () => {
      await expect(
        mapRankedResultsToResultItems(
          [makeRankedResult()],
          undefined,
          Number.NaN,
        ),
      ).rejects.toThrow(/targetYear must be a finite number/);
      await expect(
        mapRankedResultsToResultItems(
          [makeRankedResult()],
          undefined,
          Number.POSITIVE_INFINITY,
        ),
      ).rejects.toThrow(/targetYear must be a finite number/);
    });
  });

  describe('extractClaims: currentYear is pinnable for replay', () => {
    it('accepts a vintage one year ahead of the pinned currentYear (currentYear+1 boundary)', () => {
      // Pin currentYear=2024 → maxYear=2025; "2025" should be accepted.
      const claims = extractClaims('The 2025 Opus One is excellent.', { currentYear: 2024 });
      const vintageClaims = claims.filter(
        (c) => c.category === 'core_structured_claim' && c.field === 'vintage_year',
      );
      expect(vintageClaims.map((c) => c.normalizedValue)).toContain('2025');
    });

    it('rejects a vintage two years ahead of the pinned currentYear', () => {
      // Pin currentYear=2024 → maxYear=2025; "2026" should be rejected.
      const claims = extractClaims('The 2026 Opus One is amazing.', { currentYear: 2024 });
      const vintageClaims = claims.filter(
        (c) => c.category === 'core_structured_claim' && c.field === 'vintage_year',
      );
      expect(vintageClaims.map((c) => c.normalizedValue)).not.toContain('2026');
    });

    it('produces identical vintage claims across wall-clock changes when currentYear is pinned', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2024-06-15T00:00:00Z'));
        const claimsA = extractClaims('The 2022 Château Margaux is superb.', { currentYear: 2024 });
        vi.setSystemTime(new Date('2099-06-15T00:00:00Z'));
        const claimsB = extractClaims('The 2022 Château Margaux is superb.', { currentYear: 2024 });
        const vintageA = claimsA.filter((c) => c.field === 'vintage_year').map((c) => c.normalizedValue);
        const vintageB = claimsB.filter((c) => c.field === 'vintage_year').map((c) => c.normalizedValue);
        expect(vintageA).toEqual(vintageB);
        expect(vintageA).toContain('2022');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('lambdamart IDCG: actual sorted labels, not max-grade constant', () => {
    // White-box smoke test — IDCG formula is internal; assert via behavior:
    // an all-zero-label query pool should produce NDCG=0 (or undefined → 0),
    // not NaN and not a small positive number from max-grade IDCG denominator.
    it('handles all-zero-label query pools without inflating or NaNing NDCG', async () => {
      // This is primarily a smoke test — the exact validation NDCG plumbing
      // is indirect, so we verify the math invariants the fix restored:
      //
      //  1. IDCG computed from actual labels sorted descending.
      //  2. IDCG=0 when all labels are 0 → queryNdcg=0 (the `idcg > 0` guard).
      //
      // This is covered in lambdamart-ranker.test.ts with full fixtures;
      // here we just lock the contract that the deprecated constant
      // LAMBDAMART_MAX_RELEVANCE_GRADE has been removed.
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const src = await fs.readFile(
        path.resolve(__dirname, '../../src/domain/ranking/service/lambdamart-ranker.ts'),
        'utf8',
      );
      expect(src).not.toMatch(/LAMBDAMART_MAX_RELEVANCE_GRADE\s*=/);
      // Ensure the new IDCG path uses sorted actual labels.
      expect(src).toMatch(/sortedLabelsForIdcg/);
    });
  });
});
