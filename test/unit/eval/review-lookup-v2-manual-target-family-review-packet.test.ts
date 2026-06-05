import { describe, expect, it } from 'vitest';
import { applyLookupV2ManualTargetFamilyReviewDecisions } from '../../../scripts/eval/review-lookup-v2-manual-target-family-review-packet.js';

describe('applyLookupV2ManualTargetFamilyReviewDecisions', () => {
  it('applies target assignment decisions deterministically', () => {
    const rows = applyLookupV2ManualTargetFamilyReviewDecisions({
      packetRows: [
        {
          benchmarkGoldHint: 'calon segur',
          normalizedBenchmarkGoldHint: 'calonsegur',
          benchmarkGoldHintVariants: ['calon segur'],
          proposalStatus: 'needs_target_review',
          reviewTarget: 'lookup_manual_target_resolution_v1',
          locales: ['ko'],
          surfaces: ['칼롱 세귀르', '칼롱세귀르'],
          holeClasses: ['realworld_compact_alias', 'realworld_korean_orthography'],
          suggestedAliasTypes: ['canonical', 'translation'],
          rowCount: 2,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['coverage hole'],
          proposedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
      decisionRows: [
        {
          benchmarkGoldHint: 'Calon Segur',
          decision: 'assign_target',
          entityId: 'wine-ce-calon-segur',
          reviewedBy: 'op',
          decisionReason: 'single iconic target family',
          reviewedAt: '2026-06-06T01:00:00.000Z',
        },
      ],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        proposalStatus: 'target_assigned',
        targetEntityId: 'wine-ce-calon-segur',
        reviewedBy: 'op',
      }),
    ]);
  });

  it('fails closed on unknown rows or missing entity ids', () => {
    expect(() => applyLookupV2ManualTargetFamilyReviewDecisions({
      packetRows: [
        {
          benchmarkGoldHint: 'calon segur',
          normalizedBenchmarkGoldHint: 'calonsegur',
          benchmarkGoldHintVariants: ['calon segur'],
          proposalStatus: 'needs_target_review',
          reviewTarget: 'lookup_manual_target_resolution_v1',
          locales: ['ko'],
          surfaces: ['칼롱 세귀르'],
          holeClasses: ['realworld_korean_orthography'],
          suggestedAliasTypes: ['translation'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['coverage hole'],
          proposedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
      decisionRows: [
        {
          benchmarkGoldHint: 'salon',
          decision: 'assign_target',
          entityId: 'wine-ce-salon',
          reviewedBy: 'op',
          decisionReason: 'unknown',
          reviewedAt: '2026-06-06T01:00:00.000Z',
        },
      ],
    })).toThrow(/unknown packet row/);

    expect(() => applyLookupV2ManualTargetFamilyReviewDecisions({
      packetRows: [
        {
          benchmarkGoldHint: 'calon segur',
          normalizedBenchmarkGoldHint: 'calonsegur',
          benchmarkGoldHintVariants: ['calon segur'],
          proposalStatus: 'needs_target_review',
          reviewTarget: 'lookup_manual_target_resolution_v1',
          locales: ['ko'],
          surfaces: ['칼롱 세귀르'],
          holeClasses: ['realworld_korean_orthography'],
          suggestedAliasTypes: ['translation'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['coverage hole'],
          proposedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
      decisionRows: [
        {
          benchmarkGoldHint: 'calon segur',
          decision: 'assign_target',
          reviewedBy: 'op',
          decisionReason: 'missing target',
          reviewedAt: '2026-06-06T01:00:00.000Z',
        },
      ],
    } as never)).toThrow(/missing entityId/);
  });
});
