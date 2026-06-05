import { describe, expect, it } from 'vitest';
import { applyLookupV2ExactSafeFamilyReviewDecisions } from '../../../scripts/eval/review-lookup-v2-exact-safe-family-review-packet.js';

describe('applyLookupV2ExactSafeFamilyReviewDecisions', () => {
  it('applies entity-level review decisions deterministically', () => {
    const rows = applyLookupV2ExactSafeFamilyReviewDecisions({
      packetRows: [
        {
          entityId: 'wine-ce-cheval-blanc',
          locale: 'ko',
          candidatePromotionClass: 'exact_safe',
          benchmarkGoldEntityIdSources: ['hint_resolution'],
          proposalStatus: 'needs_review',
          reviewTarget: 'lookup_exact_safe_registry_v1',
          surfaces: ['슈발 블랑 2010', '슈발블랑 생테밀리옹'],
          benchmarkGoldHints: ['cheval blanc'],
          holeClasses: ['realworld_exact_vintage'],
          suggestedAliasTypes: ['canonical'],
          rowCount: 2,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['coverage hole'],
          proposedAt: '2026-06-05T00:00:00.000Z',
        },
      ],
      decisionRows: [
        {
          entityId: 'wine-ce-cheval-blanc',
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
          entityId: 'wine-ce-cheval-blanc',
          locale: 'ko',
          candidatePromotionClass: 'exact_safe',
          benchmarkGoldEntityIdSources: ['hint_resolution'],
          proposalStatus: 'needs_review',
          reviewTarget: 'lookup_exact_safe_registry_v1',
          surfaces: ['슈발 블랑 2010'],
          benchmarkGoldHints: ['cheval blanc'],
          holeClasses: ['realworld_exact_vintage'],
          suggestedAliasTypes: ['canonical'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['coverage hole'],
          proposedAt: '2026-06-05T00:00:00.000Z',
        },
      ],
      decisionRows: [
        {
          entityId: 'wine-ce-pol-roger',
          decision: 'approve',
          reviewedBy: 'op',
          decisionReason: 'unknown',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
    })).toThrow(/unknown entityId/);
  });
});
