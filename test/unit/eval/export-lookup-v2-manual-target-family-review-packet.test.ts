import { describe, expect, it } from 'vitest';
import { buildLookupV2ManualTargetFamilyReviewPacketRows } from '../../../scripts/eval/export-lookup-v2-manual-target-family-review-packet.js';

describe('buildLookupV2ManualTargetFamilyReviewPacketRows', () => {
  it('groups manual_target rows by normalized benchmark gold hint', () => {
    const rows = buildLookupV2ManualTargetFamilyReviewPacketRows({
      draftRows: [
        {
          surface: '칼롱 세귀르',
          locale: 'ko',
          suggestedAliasType: 'translation',
          holeClass: 'realworld_korean_orthography',
          observedStatus: 'failed',
          benchmarkGoldHint: 'calon segur',
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
          benchmarkGoldHint: 'Calon Segur',
          triageBucket: 'manual_target',
          sourceArtifact: '/tmp/b.json',
          sourceEvidence: 'coverage hole B',
          reviewedAt: '2026-06-06T01:00:00.000Z',
        },
        {
          surface: '샤또 라뚜르',
          locale: 'ko',
          suggestedAliasType: 'translation',
          holeClass: 'realworld_producer_prefixed',
          observedStatus: 'failed',
          benchmarkGoldHint: 'latour',
          triageBucket: 'policy_review',
          sourceArtifact: '/tmp/c.json',
          sourceEvidence: 'coverage hole C',
          reviewedAt: '2026-06-06T02:00:00.000Z',
        },
      ],
      runtimeOwnerEvidence: {
        uniqueOwners: new Map([['calon segur', 'wine-ce-calon-segur']]),
        collidingOwners: new Map(),
        entityLabels: new Map([['wine-ce-calon-segur', 'Calon Segur 2010']]),
      },
    });

    expect(rows).toEqual([
      {
        benchmarkGoldHint: 'calon segur',
        normalizedBenchmarkGoldHint: 'calon segur',
        benchmarkGoldHintVariants: ['calon segur', 'Calon Segur'],
        proposalStatus: 'needs_target_review',
        reviewTarget: 'lookup_manual_target_resolution_v1',
        locales: ['ko'],
        surfaces: ['칼롱 세귀르', '칼롱세귀르'],
        holeClasses: ['realworld_compact_alias', 'realworld_korean_orthography'],
        suggestedAliasTypes: ['canonical', 'translation'],
        rowCount: 2,
        sourceArtifacts: ['/tmp/a.json', '/tmp/b.json'],
        sourceEvidenceSamples: ['coverage hole A', 'coverage hole B'],
        runtimeEvidenceStatus: 'candidate_unique_owner',
        runtimeEvidenceEntityId: 'wine-ce-calon-segur',
        runtimeEvidenceEntityLabel: 'Calon Segur 2010',
        proposedAt: '2026-06-06T01:00:00.000Z',
      },
    ]);
  });
});
