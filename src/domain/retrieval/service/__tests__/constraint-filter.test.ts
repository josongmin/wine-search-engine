/**
 * Tests for constraint-filter.ts (ConstraintFilter).
 *
 * Covers:
 *   - Basic compliant/non-compliant partitioning
 *   - minRecallFloor gate: drop non-compliant only when above floor
 *   - Protected candidates (sparseRank === 1 / anchorRank defined): never dropped
 *     even when compliant pool >= minRecallFloor (BUG regression)
 *   - Empty constraints: early return all candidates
 */

import { describe, it, expect } from 'vitest';
import { ConstraintFilter } from '../constraint-filter.js';
import type { HybridCandidate } from '../../model/hybrid-candidate.js';
import type { NormalizedConstraint } from '../../../shared/types/index.js';
import type { EntityId } from '../../../shared/types/index.js';

function makeCandidate(
  overrides: Partial<HybridCandidate> & { id?: string } = {},
): HybridCandidate {
  const { id = 'wine-001', ...rest } = overrides;
  return {
    entityId: id as EntityId,
    matchedConstraints: [],
    unmetHardConstraints: [],
    retrievalFusionScore: 0.5,
    country: undefined,
    region: undefined,
    appellation: undefined,
    wineType: undefined,
    style: undefined,
    grapePrimary: undefined,
    grapes: undefined,
    vintageYear: undefined,
    priceUsd: undefined,
    alcoholPct: undefined,
    criticScoreNormalized: undefined,
    producerPrestige: undefined,
    body: undefined,
    sweetness: undefined,
    acidity: undefined,
    tannin: undefined,
    finishLength: undefined,
    priceBand: undefined,
    pairing: undefined,
    occasion: undefined,
    classification: undefined,
    certifications: undefined,
    soilType: undefined,
    producerType: undefined,
    drinkingWindowStart: undefined,
    drinkingWindowEnd: undefined,
    sparseRank: undefined,
    anchorRank: undefined,
    ...rest,
  } as unknown as HybridCandidate;
}

function makeConstraint(attribute = 'wine_type'): NormalizedConstraint {
  return { attribute, operator: '=', value: 'red', source_phrase: attribute, confidence: 0.9 };
}

const filter = new ConstraintFilter();
const CONSTRAINTS = [makeConstraint()];

describe('ConstraintFilter — basic partitioning', () => {
  it('returns all candidates when constraints is empty (early exit)', () => {
    const candidates = [
      makeCandidate({ id: 'a', unmetHardConstraints: ['wine_type'] }),
      makeCandidate({ id: 'b', unmetHardConstraints: [] }),
    ];
    const result = filter.applyHardFilters(candidates, []);
    expect(result).toHaveLength(2);
  });

  it('returns empty array when no candidates', () => {
    const result = filter.applyHardFilters([], CONSTRAINTS);
    expect(result).toHaveLength(0);
  });

  it('returns all compliant candidates when well above floor', () => {
    const compliant = Array.from({ length: 12 }, (_, i) =>
      makeCandidate({ id: `c${i}`, unmetHardConstraints: [] }),
    );
    const nonCompliant = [makeCandidate({ id: 'nc', unmetHardConstraints: ['wine_type'] })];
    const result = filter.applyHardFilters([...compliant, ...nonCompliant], CONSTRAINTS);
    expect(result).toHaveLength(12);
    expect(result.every((c) => (c.unmetHardConstraints ?? []).length === 0)).toBe(true);
  });

  it('returns all candidates when below floor (compliant < minRecallFloor)', () => {
    const compliant = Array.from({ length: 5 }, (_, i) =>
      makeCandidate({ id: `c${i}`, unmetHardConstraints: [] }),
    );
    const nonCompliant = Array.from({ length: 5 }, (_, i) =>
      makeCandidate({ id: `nc${i}`, unmetHardConstraints: ['wine_type'] }),
    );
    // 5 compliant < default floor 10 → keep all
    const result = filter.applyHardFilters([...compliant, ...nonCompliant], CONSTRAINTS);
    expect(result).toHaveLength(10);
  });
});

describe('ConstraintFilter — protected candidates (BUG regression: was dropped when ≥ floor)', () => {
  // The JSDoc promises: "Protected candidates (sparse rank 1 / anchor-conditioned) are
  // NEVER removed regardless of hard constraint status." Previously the code did not check
  // sparseRank or anchorRank, so a rank-1 hit with an unmet constraint was silently dropped
  // when the compliant pool already reached the floor. This test locks in the fix.

  it('sparseRank=1 candidate is NEVER dropped even when compliant pool ≥ floor', () => {
    const compliant = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({ id: `c${i}`, unmetHardConstraints: [] }),
    );
    const protectedRank1 = makeCandidate({
      id: 'rank1-violator',
      unmetHardConstraints: ['wine_type'],
      sparseRank: 1,
    });
    // 10 compliant >= floor → would normally drop non-compliant, but protectedRank1 must survive
    const result = filter.applyHardFilters([...compliant, protectedRank1], CONSTRAINTS);
    expect(result).toHaveLength(11);
    expect(result.some((c) => (c as HybridCandidate & { entityId: string }).entityId === 'rank1-violator')).toBe(true);
  });

  it('anchorRank defined candidate is NEVER dropped even when compliant pool ≥ floor', () => {
    const compliant = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({ id: `c${i}`, unmetHardConstraints: [] }),
    );
    const protectedAnchor = makeCandidate({
      id: 'anchor-violator',
      unmetHardConstraints: ['wine_type'],
      anchorRank: 3,
    });
    const result = filter.applyHardFilters([...compliant, protectedAnchor], CONSTRAINTS);
    expect(result).toHaveLength(11);
    expect(result.some((c) => (c as HybridCandidate & { entityId: string }).entityId === 'anchor-violator')).toBe(true);
  });

  it('non-protected non-compliant candidate IS dropped when floor met', () => {
    const compliant = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({ id: `c${i}`, unmetHardConstraints: [] }),
    );
    const unprotected = makeCandidate({
      id: 'unprotected-violator',
      unmetHardConstraints: ['wine_type'],
      sparseRank: undefined,
      anchorRank: undefined,
    });
    const result = filter.applyHardFilters([...compliant, unprotected], CONSTRAINTS);
    expect(result).toHaveLength(10);
    expect(result.some((c) => (c as HybridCandidate & { entityId: string }).entityId === 'unprotected-violator')).toBe(false);
  });

  it('sparseRank=2 (not 1) non-compliant candidate IS dropped when floor met', () => {
    const compliant = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({ id: `c${i}`, unmetHardConstraints: [] }),
    );
    const rank2Violator = makeCandidate({
      id: 'rank2-violator',
      unmetHardConstraints: ['wine_type'],
      sparseRank: 2,
    });
    const result = filter.applyHardFilters([...compliant, rank2Violator], CONSTRAINTS);
    expect(result).toHaveLength(10);
    expect(result.some((c) => (c as HybridCandidate & { entityId: string }).entityId === 'rank2-violator')).toBe(false);
  });
});

describe('ConstraintFilter — custom minRecallFloor', () => {
  it('custom floor of 5: drops non-compliant when 5+ compliant exist', () => {
    const compliant = Array.from({ length: 5 }, (_, i) =>
      makeCandidate({ id: `c${i}`, unmetHardConstraints: [] }),
    );
    const nonCompliant = [makeCandidate({ id: 'nc', unmetHardConstraints: ['wine_type'] })];
    const result = filter.applyHardFilters([...compliant, ...nonCompliant], CONSTRAINTS, 5);
    expect(result).toHaveLength(5);
  });

  it('custom floor of 5: keeps non-compliant when only 4 compliant exist', () => {
    const compliant = Array.from({ length: 4 }, (_, i) =>
      makeCandidate({ id: `c${i}`, unmetHardConstraints: [] }),
    );
    const nonCompliant = [makeCandidate({ id: 'nc', unmetHardConstraints: ['wine_type'] })];
    const result = filter.applyHardFilters([...compliant, ...nonCompliant], CONSTRAINTS, 5);
    expect(result).toHaveLength(5);
  });
});
