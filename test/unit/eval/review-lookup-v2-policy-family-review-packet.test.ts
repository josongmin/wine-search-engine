import { describe, expect, it } from 'vitest';
import { applyLookupV2PolicyFamilyReviewDecisions } from '../../../scripts/eval/review-lookup-v2-policy-family-review-packet.js';

describe('applyLookupV2PolicyFamilyReviewDecisions', () => {
  it('applies family review decisions deterministically', () => {
    const rows = applyLookupV2PolicyFamilyReviewDecisions({
      packetRows: [
        {
          policyConflictSurface: '라뚜르',
          locale: 'ko',
          policyConflictType: 'short_form_collision',
          authorityStatus: 'resolved',
          stretchExpectedStatus: 'ambiguous',
          benchmarkGoldEntityId: 'wine-ce-latour',
          benchmarkGoldEntityIdSources: ['hint_resolution'],
          proposalStatus: 'needs_policy_review',
          reviewTarget: 'lookup_policy_conflict_registry_v1',
          benchmarkGoldHints: ['latour'],
          sampleSurfaces: ['라뚜르 2009', '샤또 라뚜르'],
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
          semanticConflictKey: '라뚜르',
          policyConflictSurface: '라뚜르',
          benchmarkGoldEntityId: 'wine-ce-latour',
          decision: 'keep_ambiguous',
          reviewedBy: 'op',
          decisionReason: 'broad iconic surface',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        proposalStatus: 'kept_ambiguous',
        reviewedBy: 'op',
        decisionReason: 'broad iconic surface',
      }),
    ]);
  });

  it('fails closed on duplicate or unknown decisions', () => {
    expect(() => applyLookupV2PolicyFamilyReviewDecisions({
      packetRows: [
        {
          policyConflictSurface: '라뚜르',
          locale: 'ko',
          policyConflictType: 'short_form_collision',
          authorityStatus: 'resolved',
          stretchExpectedStatus: 'ambiguous',
          benchmarkGoldEntityId: 'wine-ce-latour',
          benchmarkGoldEntityIdSources: ['hint_resolution'],
          proposalStatus: 'needs_policy_review',
          reviewTarget: 'lookup_policy_conflict_registry_v1',
          benchmarkGoldHints: ['latour'],
          sampleSurfaces: ['라뚜르 2009'],
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
          policyConflictSurface: '그랜지',
          benchmarkGoldEntityId: 'wine-ce-grange',
          decision: 'keep_ambiguous',
          reviewedBy: 'op',
          decisionReason: 'unknown',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
    })).not.toThrow();

    expect(applyLookupV2PolicyFamilyReviewDecisions({
      packetRows: [
        {
          policyConflictSurface: '라뚜르',
          locale: 'ko',
          policyConflictType: 'short_form_collision',
          authorityStatus: 'resolved',
          stretchExpectedStatus: 'ambiguous',
          benchmarkGoldEntityId: 'wine-ce-latour',
          benchmarkGoldEntityIdSources: ['hint_resolution'],
          proposalStatus: 'needs_policy_review',
          reviewTarget: 'lookup_policy_conflict_registry_v1',
          benchmarkGoldHints: ['latour'],
          sampleSurfaces: ['라뚜르 2009'],
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
          semanticConflictKey: '그랜지',
          policyConflictSurface: '그랜지',
          benchmarkGoldEntityId: 'wine-ce-grange',
          decision: 'keep_ambiguous',
          reviewedBy: 'op',
          decisionReason: 'unknown',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
    })).toEqual([
      expect.objectContaining({
        proposalStatus: 'needs_policy_review',
      }),
    ]);
  });
});
