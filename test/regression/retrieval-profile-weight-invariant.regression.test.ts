/**
 * Regression: every {@link RetrievalProfile} defined in
 * `src/domain/retrieval/service/retrieval-profile.ts` MUST satisfy the
 * lane-weight invariant — sparseWeight + denseWeight + anchorWeight +
 * (learnedSparseWeight ?? 0) === 1.0 ± RETRIEVAL_PROFILE_WEIGHT_SUM_EPSILON,
 * and every lane weight MUST be a finite non-negative number.
 *
 * Why this is a regression test:
 *   - Pre-fix: LEARNED_SPARSE_HYBRID summed to 0.80 (sparse 0.35 + dense 0.45
 *     + anchor 0, no learnedSparseWeight field). Fusion silently allocated
 *     the missing 0.20 to whichever channel happened to hit first, masking
 *     SPLADE under-weighting as "noisy ranking".
 *   - Post-fix: the profile carries an explicit `learnedSparseWeight: 0.20`
 *     and `validateRetrievalProfile` runs at module load. Any future profile
 *     authored with a partial weight set will fail to import.
 *
 * Append-only per CLAUDE.md test-discipline §1 — do not delete cases.
 */

import { describe, it, expect } from 'vitest';
import {
  RETRIEVAL_PROFILE_WEIGHT_SUM_EPSILON,
  RetrievalProfileService,
  validateRetrievalProfile,
  type RetrievalProfile,
} from '../../src/domain/retrieval/service/retrieval-profile.js';
import { RRF_DEFAULT_K } from '../../src/domain/shared/utils/rrf.js';

/**
 * Constructs a profile shell with the supplied lane weights. Topology
 * (channelMix / topN / finalTopK) is fixed because only the weight invariant
 * is under test.
 */
function profileWith(
  overrides: Partial<Pick<RetrievalProfile,
    'sparseWeight' | 'denseWeight' | 'anchorWeight' | 'learnedSparseWeight'>>,
): RetrievalProfile {
  const base = {
    name: 'test_profile',
    channelMix: ['sparse_bm25', 'dense_semantic'] as const,
    sparseWeight: 0.5,
    denseWeight: 0.5,
    anchorWeight: 0,
    sparseTopN: 100,
    denseTopN: 100,
    fusionK: RRF_DEFAULT_K,
    finalTopK: 200,
  };
  // exactOptionalPropertyTypes: only attach learnedSparseWeight when set.
  const merged: RetrievalProfile = {
    ...base,
    ...(overrides.sparseWeight !== undefined ? { sparseWeight: overrides.sparseWeight } : {}),
    ...(overrides.denseWeight !== undefined ? { denseWeight: overrides.denseWeight } : {}),
    ...(overrides.anchorWeight !== undefined ? { anchorWeight: overrides.anchorWeight } : {}),
    ...(overrides.learnedSparseWeight !== undefined
      ? { learnedSparseWeight: overrides.learnedSparseWeight }
      : {}),
  };
  return merged;
}

describe('RetrievalProfile weight invariant', () => {
  it('a well-formed 2-way profile (sparse 0.5 + dense 0.5) passes validation', () => {
    expect(() =>
      validateRetrievalProfile(profileWith({ sparseWeight: 0.5, denseWeight: 0.5, anchorWeight: 0 })),
    ).not.toThrow();
  });

  it('a 3-way sum of 0.80 (the LEARNED_SPARSE_HYBRID pre-fix shape) throws', () => {
    expect(() =>
      validateRetrievalProfile(
        profileWith({ sparseWeight: 0.35, denseWeight: 0.45, anchorWeight: 0 }),
        'learned_sparse_hybrid_pre_fix',
      ),
    ).toThrow(/lane weights must sum to 1\.0/);
  });

  it('the LEARNED_SPARSE_HYBRID 4-way shape (sparse 0.35 + dense 0.45 + anchor 0 + learnedSparse 0.20) passes', () => {
    expect(() =>
      validateRetrievalProfile(
        profileWith({
          sparseWeight: 0.35,
          denseWeight: 0.45,
          anchorWeight: 0,
          learnedSparseWeight: 0.20,
        }),
      ),
    ).not.toThrow();
  });

  it('NaN weight throws', () => {
    expect(() =>
      validateRetrievalProfile(
        profileWith({ sparseWeight: Number.NaN, denseWeight: 1.0, anchorWeight: 0 }),
      ),
    ).toThrow(/must be a finite non-negative number/);
  });

  it('Infinity weight throws', () => {
    expect(() =>
      validateRetrievalProfile(
        profileWith({ sparseWeight: Number.POSITIVE_INFINITY, denseWeight: 0, anchorWeight: 0 }),
      ),
    ).toThrow(/must be a finite non-negative number/);
  });

  it('negative weight throws', () => {
    expect(() =>
      validateRetrievalProfile(
        profileWith({ sparseWeight: -0.1, denseWeight: 1.1, anchorWeight: 0 }),
      ),
    ).toThrow(/must be a finite non-negative number/);
  });

  it('weight sum just outside epsilon throws (off-by-one boundary)', () => {
    // Construct a sum that exceeds epsilon by ~10x — guaranteed-out, not flaky.
    const outOfBand = 1.0 + RETRIEVAL_PROFILE_WEIGHT_SUM_EPSILON * 10;
    expect(() =>
      validateRetrievalProfile(
        profileWith({ sparseWeight: outOfBand, denseWeight: 0, anchorWeight: 0 }),
      ),
    ).toThrow(/lane weights must sum to 1\.0/);
  });

  it('weight sum just inside epsilon passes (off-by-one boundary)', () => {
    // 1 ULP below epsilon — should remain valid.
    const inBand = 1.0 + RETRIEVAL_PROFILE_WEIGHT_SUM_EPSILON * 0.1;
    expect(() =>
      validateRetrievalProfile(
        profileWith({ sparseWeight: inBand, denseWeight: 0, anchorWeight: 0 }),
      ),
    ).not.toThrow();
  });

  it('omitted learnedSparseWeight is treated as 0 (does not corrupt a 2-way 1.0 sum)', () => {
    // No learnedSparseWeight field, but sparse + dense already sum to 1.0.
    expect(() =>
      validateRetrievalProfile(
        profileWith({ sparseWeight: 0.6, denseWeight: 0.4, anchorWeight: 0 }),
      ),
    ).not.toThrow();
  });

  it('module-load IIFE: importing retrieval-profile does not throw — every defined profile is valid', async () => {
    // Re-import to confirm the module-load IIFE never tripped. If any profile
    // were miscalibrated, the static import at the top of this file would
    // have already thrown — this assertion makes the contract explicit.
    const mod = await import('../../src/domain/retrieval/service/retrieval-profile.js');
    expect(typeof mod.RetrievalProfileService).toBe('function');
  });

  it('every profile exposed via RetrievalProfileService passes validateRetrievalProfile', () => {
    // Smoke-resolve every retrieval mode/route combination we know about
    // and re-run validation on the resolved profile. This catches drift
    // where a new profile is added but skipped in ALL_DEFINED_PROFILES.
    const service = new RetrievalProfileService();
    const cases: ReadonlyArray<readonly [Parameters<typeof service.getProfile>[0], string, string | undefined]> = [
      ['pure_constraint', 'hybrid', undefined],
      ['anchored_similarity', 'mixed', undefined],
      ['short_entity', 'hybrid', undefined],
      ['exact_entity', 'hybrid', undefined],
      ['ambiguous_short_form', 'hybrid', undefined],
      ['semantic_preference', 'hybrid', undefined],
      ['pure_constraint', 'hybrid', 'producer_browse'],
      ['pure_constraint', 'hybrid', 'region_browse'],
      ['comparison_query', 'hybrid', 'compare_candidates'],
      ['semantic_preference', 'hybrid', 'recommendation'],
      ['anchored_similarity', 'mixed', 'similar_items'],
      ['pure_constraint', 'hybrid', 'relative'],
      ['exact_entity', 'hybrid', 'entity_anchor_first'],
      ['pure_constraint', 'hybrid', 'attribute_search'],
      ['pure_constraint', 'hybrid', 'constraint_filter'],
      ['exact_entity', 'hybrid', 'entity_lookup'],
      ['exact_entity', 'hybrid', 'entity_resolution'],
      ['pure_constraint', 'hybrid', 'no_match_detection'],
    ];
    for (const [qc, route, mode] of cases) {
      const profile = service.getProfile(qc, route, mode);
      expect(() => validateRetrievalProfile(profile)).not.toThrow();
    }
  });
});
