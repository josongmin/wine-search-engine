import { describe, expect, it } from 'vitest';
import { applyLookupV2ExactSafeFamilyReviewDecisions } from '../../../scripts/eval/review-lookup-v2-exact-safe-family-review-packet.js';

describe('applyLookupV2ExactSafeFamilyReviewDecisions', () => {
  it('applies scope-level review decisions deterministically', () => {
    const rows = applyLookupV2ExactSafeFamilyReviewDecisions({
      packetRows: [
        {
          reviewScopeKey: 'wine-ce-cheval-blanc::canonical::realworld_exact_vintage',
          entityId: 'wine-ce-cheval-blanc',
          locale: 'ko',
          candidatePromotionClass: 'exact_safe',
          benchmarkGoldEntityIdSources: ['hint_resolution'],
          proposalStatus: 'needs_review',
          reviewTarget: 'lookup_exact_safe_registry_v1',
          scopeHoleClass: 'realworld_exact_vintage',
          scopeSuggestedAliasType: 'canonical',
          surfaces: ['슈발 블랑 2010'],
          benchmarkGoldHints: ['cheval blanc'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['coverage hole'],
          proposedAt: '2026-06-05T00:00:00.000Z',
        },
      ],
      decisionRows: [
        {
          reviewScopeKey: 'wine-ce-cheval-blanc::canonical::realworld_exact_vintage',
          decision: 'approve',
          reviewedBy: 'op',
          decisionReason: 'verified family packet',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        proposalStatus: 'approved',
        reviewedBy: 'op',
        decisionReason: 'verified family packet',
      }),
    ]);
  });

  it('fails closed on duplicate or unknown entity decisions', () => {
    expect(() => applyLookupV2ExactSafeFamilyReviewDecisions({
      packetRows: [
        {
          reviewScopeKey: 'wine-ce-cheval-blanc::canonical::realworld_exact_vintage',
          entityId: 'wine-ce-cheval-blanc',
          locale: 'ko',
          candidatePromotionClass: 'exact_safe',
          benchmarkGoldEntityIdSources: ['hint_resolution'],
          proposalStatus: 'needs_review',
          reviewTarget: 'lookup_exact_safe_registry_v1',
          scopeHoleClass: 'realworld_exact_vintage',
          scopeSuggestedAliasType: 'canonical',
          surfaces: ['슈발 블랑 2010'],
          benchmarkGoldHints: ['cheval blanc'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['coverage hole'],
          proposedAt: '2026-06-05T00:00:00.000Z',
        },
      ],
      decisionRows: [
        {
          reviewScopeKey: 'wine-ce-pol-roger::canonical::realworld_brand_suffix',
          decision: 'approve',
          reviewedBy: 'op',
          decisionReason: 'unknown',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
    })).not.toThrow();

    expect(applyLookupV2ExactSafeFamilyReviewDecisions({
      packetRows: [
        {
          reviewScopeKey: 'wine-ce-cheval-blanc::canonical::realworld_exact_vintage',
          entityId: 'wine-ce-cheval-blanc',
          locale: 'ko',
          candidatePromotionClass: 'exact_safe',
          benchmarkGoldEntityIdSources: ['hint_resolution'],
          proposalStatus: 'needs_review',
          reviewTarget: 'lookup_exact_safe_registry_v1',
          scopeHoleClass: 'realworld_exact_vintage',
          scopeSuggestedAliasType: 'canonical',
          surfaces: ['슈발 블랑 2010'],
          benchmarkGoldHints: ['cheval blanc'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['coverage hole'],
          proposedAt: '2026-06-05T00:00:00.000Z',
        },
      ],
      decisionRows: [
        {
          reviewScopeKey: 'wine-ce-pol-roger::canonical::realworld_brand_suffix',
          decision: 'approve',
          reviewedBy: 'op',
          decisionReason: 'unknown',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
    })).toEqual([
      expect.objectContaining({
        proposalStatus: 'needs_review',
      }),
    ]);
  });
});
