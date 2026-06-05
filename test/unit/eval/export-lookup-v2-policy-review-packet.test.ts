import { describe, expect, it } from 'vitest';
import {
  buildLookupV2PolicyReviewPacketRows,
} from '../../../scripts/eval/export-lookup-v2-policy-review-packet.js';

describe('buildLookupV2PolicyReviewPacketRows', () => {
  it('projects policy_review draft rows into a reviewed policy packet', () => {
    const rows = buildLookupV2PolicyReviewPacketRows({
      draftRows: [
        {
          surface: '라뚜르 2009',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'failed',
          benchmarkGoldHint: 'Latour',
          benchmarkGoldEntityId: 'wine-ce-latour',
          benchmarkGoldEntityIdSource: 'hint_resolution',
          triageBucket: 'policy_review',
          policyConflictHint: 'Latour',
          sourceArtifact: '/tmp/sample.json',
          sourceEvidence: 'coverage hole',
          reviewedAt: '2026-06-05T00:00:00.000Z',
        },
        {
          surface: '베가 시실리아 우니코 2010',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'failed',
          benchmarkGoldHint: 'vega sicilia unico',
          benchmarkGoldEntityId: 'wine-ce-vega-unico',
          benchmarkGoldEntityIdSource: 'policy_registry_authority',
          triageBucket: 'policy_review',
          policyConflictHint: 'vega sicilia unico',
          sourceArtifact: '/tmp/sample.json',
          sourceEvidence: 'coverage hole',
          reviewedAt: '2026-06-05T00:00:00.000Z',
        },
        {
          surface: '샤또 무통 로쉴드',
          locale: 'ko',
          suggestedAliasType: 'translation',
          holeClass: 'realworld_korean_orthography',
          observedStatus: 'failed',
          benchmarkGoldHint: 'mouton',
          benchmarkGoldEntityId: 'wine-ce-mouton',
          benchmarkGoldEntityIdSource: 'hint_resolution',
          triageBucket: 'auto_targetable',
          sourceArtifact: '/tmp/sample.json',
          sourceEvidence: 'coverage hole',
          reviewedAt: '2026-06-05T00:00:00.000Z',
        },
      ],
      policyConflictOwners: new Map([
        ['latour', {
          surface: '라뚜르',
          locale: 'ko',
          stretchExpectedStatus: 'ambiguous',
          authorityStatus: 'resolved',
          authorityEntityId: 'wine-ce-latour',
          conflictType: 'short_form_collision',
          conflictBenchmarkHints: ['latour'],
          sourceEvidence: 'seed',
          reviewedAt: '2026-06-05T00:00:00.000Z',
        }],
        ['vega sicilia unico', {
          surface: '베가 시실리아',
          locale: 'ko',
          stretchExpectedStatus: 'ambiguous',
          authorityStatus: 'resolved',
          authorityEntityId: 'wine-ce-vega-unico',
          conflictType: 'short_form_collision',
          conflictBenchmarkHints: ['vega sicilia unico'],
          sourceEvidence: 'seed',
          reviewedAt: '2026-06-05T00:00:00.000Z',
        }],
      ]),
    });

    expect(rows).toEqual([
      {
        surface: '라뚜르 2009',
        locale: 'ko',
        suggestedAliasType: 'canonical',
        holeClass: 'realworld_exact_vintage',
        observedStatus: 'failed',
        benchmarkGoldHint: 'Latour',
        benchmarkGoldEntityId: 'wine-ce-latour',
        benchmarkGoldEntityIdSource: 'hint_resolution',
        policyConflictSurface: '라뚜르',
        policyConflictType: 'short_form_collision',
        authorityStatus: 'resolved',
        stretchExpectedStatus: 'ambiguous',
        proposalStatus: 'needs_policy_review',
        reviewTarget: 'lookup_policy_conflict_registry_v1',
        sourceArtifact: '/tmp/sample.json',
        sourceEvidence: 'coverage hole',
        proposedAt: '2026-06-05T00:00:00.000Z',
      },
      {
        surface: '베가 시실리아 우니코 2010',
        locale: 'ko',
        suggestedAliasType: 'canonical',
        holeClass: 'realworld_exact_vintage',
        observedStatus: 'failed',
        benchmarkGoldHint: 'vega sicilia unico',
        benchmarkGoldEntityId: 'wine-ce-vega-unico',
        benchmarkGoldEntityIdSource: 'policy_registry_authority',
        policyConflictSurface: '베가 시실리아',
        policyConflictType: 'short_form_collision',
        authorityStatus: 'resolved',
        stretchExpectedStatus: 'ambiguous',
        proposalStatus: 'needs_policy_review',
        reviewTarget: 'lookup_policy_conflict_registry_v1',
        sourceArtifact: '/tmp/sample.json',
        sourceEvidence: 'coverage hole',
        proposedAt: '2026-06-05T00:00:00.000Z',
      },
    ]);
  });

  it('fails closed when a policy-review row has no reviewed owner', () => {
    expect(() => buildLookupV2PolicyReviewPacketRows({
      draftRows: [
        {
          surface: '라뚜르 2009',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'failed',
          benchmarkGoldHint: 'latour',
          triageBucket: 'policy_review',
          sourceArtifact: '/tmp/sample.json',
          sourceEvidence: 'coverage hole',
          reviewedAt: '2026-06-05T00:00:00.000Z',
        },
      ],
      policyConflictOwners: new Map(),
    })).toThrow(/no reviewed policy owner/);
  });
});
