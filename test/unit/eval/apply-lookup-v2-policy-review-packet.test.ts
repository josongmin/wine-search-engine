import { describe, expect, it } from 'vitest';
import { applyLookupV2PolicyReviewPacket } from '../../../scripts/eval/apply-lookup-v2-policy-review-packet.js';

describe('applyLookupV2PolicyReviewPacket', () => {
  it('projects approved policy-review rows into approved exact-safe packet rows', () => {
    const result = applyLookupV2PolicyReviewPacket({
      packetPath: 'data/lookup-v2/drafts/policy-review.jsonl',
      packetRows: [
        {
          surface: '라뚜르 2009',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'ambiguous',
          benchmarkGoldHint: 'latour',
          benchmarkGoldEntityId: 'wine-ce-latour',
          benchmarkGoldEntityIdSource: 'hint_resolution',
          policyConflictSurface: '라뚜르',
          policyConflictType: 'short_form_collision',
          authorityStatus: 'resolved',
          stretchExpectedStatus: 'ambiguous',
          proposalStatus: 'approved_exact_safe',
          reviewTarget: 'lookup_policy_conflict_registry_v1',
          sourceArtifact: '/tmp/sample.json',
          sourceEvidence: 'coverage hole',
          proposedAt: '2026-06-05T00:00:00.000Z',
          reviewedAt: '2026-06-06T00:00:00.000Z',
          reviewedBy: 'op',
          decisionReason: 'vintage-specific singleton',
        },
        {
          surface: '그랜지 2012',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'ambiguous',
          benchmarkGoldHint: 'grange',
          benchmarkGoldEntityId: 'wine-ce-grange',
          benchmarkGoldEntityIdSource: 'hint_resolution',
          policyConflictSurface: '그랜지',
          policyConflictType: 'short_form_collision',
          authorityStatus: 'resolved',
          stretchExpectedStatus: 'ambiguous',
          proposalStatus: 'kept_policy_conflict',
          reviewTarget: 'lookup_policy_conflict_registry_v1',
          sourceArtifact: '/tmp/sample.json',
          sourceEvidence: 'coverage hole',
          proposedAt: '2026-06-05T00:00:00.000Z',
          reviewedAt: '2026-06-06T00:00:00.000Z',
          reviewedBy: 'op',
          decisionReason: 'keep broad family ambiguous',
        },
      ],
    });

    expect(result.approvedExactSafeRows).toBe(1);
    expect(result.keptPolicyConflictRows).toBe(1);
    expect(result.needsTargetRows).toBe(0);
    expect(result.pendingRows).toBe(0);
    expect(result.exactSafePacketRows).toEqual([
      expect.objectContaining({
        surface: '라뚜르 2009',
        entityId: 'wine-ce-latour',
        proposalStatus: 'approved',
        reviewTarget: 'lookup_exact_safe_registry_v1',
        reviewedBy: 'op',
        decisionReason: 'vintage-specific singleton',
      }),
    ]);
  });

  it('counts pending and needs-target rows without emitting exact-safe packet rows', () => {
    const result = applyLookupV2PolicyReviewPacket({
      packetPath: 'data/lookup-v2/drafts/policy-review.jsonl',
      packetRows: [
        {
          surface: 'Vega Sicilia 우니꼬',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_mixed_script_alias',
          observedStatus: 'failed',
          benchmarkGoldHint: 'vega sicilia unico',
          policyConflictSurface: '베가 시실리아',
          policyConflictType: 'broad_icon_collision',
          authorityStatus: 'resolved',
          stretchExpectedStatus: 'ambiguous',
          proposalStatus: 'needs_target',
          reviewTarget: 'lookup_policy_conflict_registry_v1',
          sourceArtifact: '/tmp/sample.json',
          sourceEvidence: 'coverage hole',
          proposedAt: '2026-06-05T00:00:00.000Z',
          reviewedAt: '2026-06-06T00:00:00.000Z',
          reviewedBy: 'op',
          decisionReason: 'missing target',
        },
        {
          surface: '무통 2018',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'ambiguous',
          benchmarkGoldHint: 'mouton',
          policyConflictSurface: '무통',
          policyConflictType: 'short_form_collision',
          authorityStatus: 'resolved',
          stretchExpectedStatus: 'ambiguous',
          proposalStatus: 'needs_policy_review',
          reviewTarget: 'lookup_policy_conflict_registry_v1',
          sourceArtifact: '/tmp/sample.json',
          sourceEvidence: 'coverage hole',
          proposedAt: '2026-06-05T00:00:00.000Z',
        },
      ],
    });

    expect(result.needsTargetRows).toBe(1);
    expect(result.pendingRows).toBe(1);
    expect(result.exactSafePacketRows).toEqual([]);
  });

  it('fails closed when approved rows are missing entity or review metadata', () => {
    expect(() => applyLookupV2PolicyReviewPacket({
      packetPath: 'data/lookup-v2/drafts/policy-review.jsonl',
      packetRows: [
        {
          surface: '라뚜르 2009',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'ambiguous',
          benchmarkGoldHint: 'latour',
          policyConflictSurface: '라뚜르',
          policyConflictType: 'short_form_collision',
          authorityStatus: 'resolved',
          stretchExpectedStatus: 'ambiguous',
          proposalStatus: 'approved_exact_safe',
          reviewTarget: 'lookup_policy_conflict_registry_v1',
          sourceArtifact: '/tmp/sample.json',
          sourceEvidence: 'coverage hole',
          proposedAt: '2026-06-05T00:00:00.000Z',
          reviewedAt: '2026-06-06T00:00:00.000Z',
          reviewedBy: 'op',
          decisionReason: 'x',
        },
      ],
    })).toThrow(/missing benchmarkGoldEntityId/);

    expect(() => applyLookupV2PolicyReviewPacket({
      packetPath: 'data/lookup-v2/drafts/policy-review.jsonl',
      packetRows: [
        {
          surface: '라뚜르 2009',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'ambiguous',
          benchmarkGoldHint: 'latour',
          benchmarkGoldEntityId: 'wine-ce-latour',
          benchmarkGoldEntityIdSource: 'hint_resolution',
          policyConflictSurface: '라뚜르',
          policyConflictType: 'short_form_collision',
          authorityStatus: 'resolved',
          stretchExpectedStatus: 'ambiguous',
          proposalStatus: 'approved_exact_safe',
          reviewTarget: 'lookup_policy_conflict_registry_v1',
          sourceArtifact: '/tmp/sample.json',
          sourceEvidence: 'coverage hole',
          proposedAt: '2026-06-05T00:00:00.000Z',
        },
      ],
    })).toThrow(/missing reviewedAt/);
  });
});
