import { describe, expect, it } from 'vitest';
import { applyLookupV2PolicyFamilyReviewPacket } from '../../../scripts/eval/apply-lookup-v2-policy-family-review-packet.js';

describe('applyLookupV2PolicyFamilyReviewPacket', () => {
  it('projects family decisions down to row-level policy packet rows', () => {
    const rows = applyLookupV2PolicyFamilyReviewPacket({
      familyRows: [
        {
          semanticConflictKey: 'ko::short_form_collision::라뚜르',
          policyConflictSurface: '라뚜르',
          locale: 'ko',
          policyConflictType: 'short_form_collision',
          authorityStatus: 'resolved',
          stretchExpectedStatus: 'ambiguous',
          benchmarkGoldEntityId: 'wine-ce-latour',
          benchmarkGoldEntityIdSources: ['hint_resolution'],
          proposalStatus: 'approved_exact_safe',
          reviewTarget: 'lookup_policy_conflict_registry_v1',
          benchmarkGoldHints: ['latour'],
          sampleSurfaces: ['라뚜르 2009', '샤또 라뚜르'],
          holeClasses: ['realworld_exact_vintage'],
          suggestedAliasTypes: ['canonical'],
          rowCount: 2,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['coverage hole'],
          proposedAt: '2026-06-05T00:00:00.000Z',
          reviewedAt: '2026-06-06T00:00:00.000Z',
          reviewedBy: 'op',
          decisionReason: 'accept authority',
        },
      ],
      policyFamilyDecisionMap: new Map([
        ['ko::short_form_collision::라뚜르::wine-ce-latour', {
          semanticConflictKey: 'ko::short_form_collision::라뚜르',
          conflictClass: 'short_form_collision',
          policyConflictSurface: '라뚜르',
          entityId: 'wine-ce-latour',
          decision: 'promote_exact_safe',
          reviewedBy: 'registry',
          reviewedAt: '2026-06-06T01:00:00.000Z',
          decisionReason: 'approved in registry',
        }],
      ]),
      rowPacketRows: [
        {
          surface: '라뚜르 2009',
          locale: 'ko',
          semanticConflictKey: 'ko::short_form_collision::라뚜르',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'failed',
          benchmarkGoldHint: 'latour',
          benchmarkGoldEntityId: 'wine-ce-latour',
          benchmarkGoldEntityIdSource: 'hint_resolution',
          policyConflictSurface: '라뚜르',
          policyConflictType: 'short_form_collision',
          authorityStatus: 'resolved',
          stretchExpectedStatus: 'ambiguous',
          proposalStatus: 'needs_policy_review',
          reviewTarget: 'lookup_policy_conflict_registry_v1',
          sourceArtifact: '/tmp/a.json',
          sourceEvidence: 'coverage hole',
          proposedAt: '2026-06-05T00:00:00.000Z',
        },
        {
          surface: '샤또 라뚜르',
          locale: 'ko',
          semanticConflictKey: 'ko::short_form_collision::라뚜르',
          suggestedAliasType: 'translation',
          holeClass: 'realworld_producer_prefixed',
          observedStatus: 'failed',
          benchmarkGoldHint: 'latour',
          benchmarkGoldEntityId: 'wine-ce-latour',
          benchmarkGoldEntityIdSource: 'hint_resolution',
          policyConflictSurface: '라뚜르',
          policyConflictType: 'short_form_collision',
          authorityStatus: 'resolved',
          stretchExpectedStatus: 'ambiguous',
          proposalStatus: 'needs_policy_review',
          reviewTarget: 'lookup_policy_conflict_registry_v1',
          sourceArtifact: '/tmp/a.json',
          sourceEvidence: 'coverage hole',
          proposedAt: '2026-06-05T00:00:00.000Z',
        },
      ],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        surface: '라뚜르 2009',
        proposalStatus: 'approved_exact_safe',
        reviewedBy: 'registry',
        decisionReason: 'approved in registry',
      }),
      expect.objectContaining({
        surface: '샤또 라뚜르',
        proposalStatus: 'approved_exact_safe',
        reviewedBy: 'registry',
        decisionReason: 'approved in registry',
      }),
    ]);
  });

  it('fails closed when a row has no family review owner', () => {
    expect(() => applyLookupV2PolicyFamilyReviewPacket({
      familyRows: [],
      policyFamilyDecisionMap: new Map(),
      rowPacketRows: [
        {
          surface: '라뚜르 2009',
          locale: 'ko',
          semanticConflictKey: 'ko::short_form_collision::라뚜르',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'failed',
          benchmarkGoldHint: 'latour',
          benchmarkGoldEntityId: 'wine-ce-latour',
          benchmarkGoldEntityIdSource: 'hint_resolution',
          policyConflictSurface: '라뚜르',
          policyConflictType: 'short_form_collision',
          authorityStatus: 'resolved',
          stretchExpectedStatus: 'ambiguous',
          proposalStatus: 'needs_policy_review',
          reviewTarget: 'lookup_policy_conflict_registry_v1',
          sourceArtifact: '/tmp/a.json',
          sourceEvidence: 'coverage hole',
          proposedAt: '2026-06-05T00:00:00.000Z',
        },
      ],
    })).toThrow(/no family review row/);
  });
});
