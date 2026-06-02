import { describe, expect, it } from 'vitest';
import {
  ambiguityClusterMembershipScore,
  extractLookupFeatures,
} from '../../../src/domain/resolver/v2/lookup-feature-extractor.js';
import type { LookupChannelHit } from '../../../src/domain/resolver/v2/lookup-v2-types.js';

/**
 * T-ELV2-06 Half A: ambiguity-cluster membership is no longer hardcoded 0 — it is
 * a parameter-free, bounded [0,1) signal derived from the persisted cluster size.
 */
describe('ambiguityClusterMembershipScore', () => {
  it('is parameter-free monotonic 1 - 1/N for members of a size-N cluster', () => {
    expect(ambiguityClusterMembershipScore(true, 2)).toBeCloseTo(0.5);
    expect(ambiguityClusterMembershipScore(true, 4)).toBeCloseTo(0.75);
    expect(ambiguityClusterMembershipScore(true, 10)).toBeCloseTo(0.9);
  });

  it('is 0 for non-members and for clusters smaller than 2 (not a cluster)', () => {
    expect(ambiguityClusterMembershipScore(false, 5)).toBe(0);
    expect(ambiguityClusterMembershipScore(true, 1)).toBe(0);
    expect(ambiguityClusterMembershipScore(true, 0)).toBe(0);
    expect(ambiguityClusterMembershipScore(true, Number.NaN)).toBe(0);
  });
});

describe('extractLookupFeatures — ambiguityClusterMembership wiring', () => {
  const hits: LookupChannelHit[] = [
    { channel: 'exact_alias', matchedView: 'opus one', channelScore: 0.9, channelRank: 1 },
  ];

  it('defaults ambiguityClusterMembership to 0 (no cluster signal supplied)', () => {
    expect(extractLookupFeatures(hits, 0.8).ambiguityClusterMembership).toBe(0);
  });

  it('carries the supplied cluster-membership signal (clamped to [0,1])', () => {
    expect(extractLookupFeatures(hits, 0.8, 0.75).ambiguityClusterMembership).toBeCloseTo(0.75);
    expect(extractLookupFeatures(hits, 0.8, 2).ambiguityClusterMembership).toBe(1);
    expect(extractLookupFeatures(hits, 0.8, -1).ambiguityClusterMembership).toBe(0);
  });
});
