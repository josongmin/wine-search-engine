import { describe, expect, it } from 'vitest';
import { applyLookupV2ManualTargetFamilyReviewPacket } from '../../../scripts/eval/apply-lookup-v2-manual-target-family-review-packet.js';

describe('applyLookupV2ManualTargetFamilyReviewPacket', () => {
  it('projects target-assigned manual families into exact-safe proposal rows', () => {
    const result = applyLookupV2ManualTargetFamilyReviewPacket({
      familyRows: [
        {
          benchmarkGoldHint: 'calon segur',
          normalizedBenchmarkGoldHint: 'calonsegur',
          benchmarkGoldHintVariants: ['calon segur'],
          proposalStatus: 'target_assigned',
          reviewTarget: 'lookup_manual_target_resolution_v1',
          locales: ['ko'],
          surfaces: ['칼롱 세귀르', '칼롱세귀르'],
          holeClasses: ['realworld_compact_alias', 'realworld_korean_orthography'],
          suggestedAliasTypes: ['canonical', 'translation'],
          rowCount: 2,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['coverage hole'],
          proposedAt: '2026-06-06T00:00:00.000Z',
          targetEntityId: 'wine-ce-calon-segur',
          reviewedAt: '2026-06-06T01:00:00.000Z',
          reviewedBy: 'op',
          decisionReason: 'single iconic target family',
        },
        {
          benchmarkGoldHint: 'salon',
          normalizedBenchmarkGoldHint: 'salon',
          benchmarkGoldHintVariants: ['salon'],
          proposalStatus: 'needs_target_review',
          reviewTarget: 'lookup_manual_target_resolution_v1',
          locales: ['ko'],
          surfaces: ['살롱 2012'],
          holeClasses: ['realworld_exact_vintage'],
          suggestedAliasTypes: ['canonical'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/b.json'],
          sourceEvidenceSamples: ['coverage hole'],
          proposedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
      draftRows: [
        {
          surface: '칼롱 세귀르',
          locale: 'ko',
          suggestedAliasType: 'translation',
          holeClass: 'realworld_korean_orthography',
          observedStatus: 'failed',
          benchmarkGoldHint: 'Calon Segur',
          triageBucket: 'manual_target',
          sourceArtifact: '/tmp/a.json',
          sourceEvidence: 'coverage hole A',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
        {
          surface: '칼롱세귀르',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_compact_alias',
          observedStatus: 'failed',
          benchmarkGoldHint: 'calon segur',
          triageBucket: 'manual_target',
          sourceArtifact: '/tmp/a.json',
          sourceEvidence: 'coverage hole B',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
        {
          surface: '살롱 2012',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'failed',
          benchmarkGoldHint: 'salon',
          triageBucket: 'manual_target',
          sourceArtifact: '/tmp/b.json',
          sourceEvidence: 'coverage hole C',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
      packetPath: '/tmp/manual-family-reviewed.jsonl',
      existingRegistryRows: [],
    });

    expect(result.targetAssignedFamilies).toBe(1);
    expect(result.rejectedFamilies).toBe(0);
    expect(result.pendingFamilies).toBe(1);
    expect(result.exactSafePacketRows).toEqual([
      expect.objectContaining({
        surface: '칼롱 세귀르',
        entityId: 'wine-ce-calon-segur',
        benchmarkGoldEntityIdSource: 'manual_family_review_target',
      }),
      expect.objectContaining({
        surface: '칼롱세귀르',
        entityId: 'wine-ce-calon-segur',
        benchmarkGoldEntityIdSource: 'manual_family_review_target',
      }),
    ]);
  });
});
