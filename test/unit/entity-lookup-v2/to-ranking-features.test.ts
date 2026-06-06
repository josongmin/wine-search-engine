import { describe, expect, it } from 'vitest';
import { toRankingFeatures } from '../../../src/domain/resolver/v2/ltr-rerank-decider.js';
import type { LookupCandidateFeatures } from '../../../src/domain/resolver/v2/lookup-v2-types.js';

/**
 * T-06 Half A fix: the lookup→ranking projection must NOT drop the persisted
 * ambiguity-cluster-membership signal before the reranker scores. It rides the
 * (otherwise constant-0 in lookup) diversityScore slot; familyGraphProximity rides
 * laneCorroborationScore. This pins both so a refactor can't silently re-zero them.
 */
function features(over: Partial<LookupCandidateFeatures> = {}): LookupCandidateFeatures {
  return {
    exactAliasEvidence: 0,
    normalizedAliasEvidence: 0,
    transliterationConsistency: 0,
    editDistanceScore: 0,
    phoneticConsistency: 0,
    familyGraphProximity: 0,
    lineGraphProximity: 0,
    vintageGraphProximity: 0,
    scopeQualifierAgreement: 0,
    scopeAxisAgreement: 0,
    popularityPrior: 0,
    scriptLanguageConsistency: 0,
    ambiguityClusterMembership: 0,
    channelAgreement: 0,
    ...over,
  };
}

describe('toRankingFeatures — lookup features reach the RankingFeatures schema', () => {
  it('carries ambiguityClusterMembership into diversityScore (not dropped)', () => {
    expect(toRankingFeatures(features({ ambiguityClusterMembership: 0.75 })).diversityScore).toBeCloseTo(0.75);
  });

  it('carries familyGraphProximity into laneCorroborationScore', () => {
    expect(toRankingFeatures(features({ familyGraphProximity: 0.6 })).laneCorroborationScore).toBeCloseTo(0.6);
  });

  it('clamps the cluster signal to [0,1]', () => {
    expect(toRankingFeatures(features({ ambiguityClusterMembership: 2 })).diversityScore).toBe(1);
    expect(toRankingFeatures(features({ ambiguityClusterMembership: -1 })).diversityScore).toBe(0);
  });
});
