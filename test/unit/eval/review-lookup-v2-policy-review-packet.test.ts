import { describe, expect, it } from 'vitest';
import { applyLookupV2PolicyReviewDecisions } from '../../../scripts/eval/review-lookup-v2-policy-review-packet.js';

describe('applyLookupV2PolicyReviewDecisions', () => {
  it('applies policy decisions onto needs_policy_review rows', () => {
    const reviewed = applyLookupV2PolicyReviewDecisions({
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
          proposalStatus: 'needs_policy_review',
          reviewTarget: 'lookup_policy_conflict_registry_v1',
          sourceArtifact: '/tmp/sample.json',
          sourceEvidence: 'coverage hole',
          proposedAt: '2026-06-05T00:00:00.000Z',
        },
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
          proposalStatus: 'needs_policy_review',
          reviewTarget: 'lookup_policy_conflict_registry_v1',
          sourceArtifact: '/tmp/sample.json',
          sourceEvidence: 'coverage hole',
          proposedAt: '2026-06-05T00:00:00.000Z',
        },
      ],
      decisionRows: [
        {
          surface: '라뚜르 2009',
          benchmarkGoldHint: 'latour',
          decision: 'promote_exact_safe',
          reviewedBy: 'op',
          decisionReason: 'vintage-specific singleton',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
        {
          surface: 'Vega Sicilia 우니꼬',
          benchmarkGoldHint: 'vega sicilia unico',
          decision: 'needs_target',
          reviewedBy: 'op',
          decisionReason: 'missing reviewed entity id',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
    });

    expect(reviewed.map((row) => row.proposalStatus)).toEqual([
      'approved_exact_safe',
      'needs_target',
    ]);
    expect(reviewed[0]).toEqual(expect.objectContaining({
      reviewedBy: 'op',
      decisionReason: 'vintage-specific singleton',
      reviewedAt: '2026-06-06T00:00:00.000Z',
    }));
  });

  it('fails closed on duplicate or unknown decisions', () => {
    expect(() => applyLookupV2PolicyReviewDecisions({
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
          proposalStatus: 'needs_policy_review',
          reviewTarget: 'lookup_policy_conflict_registry_v1',
          sourceArtifact: '/tmp/sample.json',
          sourceEvidence: 'coverage hole',
          proposedAt: '2026-06-05T00:00:00.000Z',
        },
      ],
      decisionRows: [
        {
          surface: '라뚜르 2009',
          benchmarkGoldHint: 'latour',
          decision: 'promote_exact_safe',
          reviewedBy: 'op',
          decisionReason: 'a',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
        {
          surface: '라뚜르 2009',
          benchmarkGoldHint: 'latour',
          decision: 'keep_policy_conflict',
          reviewedBy: 'op',
          decisionReason: 'b',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
    })).toThrow(/duplicate policy-review decision/);

    expect(() => applyLookupV2PolicyReviewDecisions({
      packetRows: [],
      decisionRows: [
        {
          surface: '라뚜르 2009',
          benchmarkGoldHint: 'latour',
          decision: 'promote_exact_safe',
          reviewedBy: 'op',
          decisionReason: 'a',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
    })).toThrow(/unknown packet row/);
  });

  it('fails closed on re-reviewing terminal rows', () => {
    expect(() => applyLookupV2PolicyReviewDecisions({
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
          proposalStatus: 'kept_policy_conflict',
          reviewTarget: 'lookup_policy_conflict_registry_v1',
          sourceArtifact: '/tmp/sample.json',
          sourceEvidence: 'coverage hole',
          proposedAt: '2026-06-05T00:00:00.000Z',
          reviewedBy: 'prev',
          decisionReason: 'prev',
          reviewedAt: '2026-06-05T12:00:00.000Z',
        },
      ],
      decisionRows: [
        {
          surface: '라뚜르 2009',
          benchmarkGoldHint: 'latour',
          decision: 'promote_exact_safe',
          reviewedBy: 'op',
          decisionReason: 'retry',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
    })).toThrow(/cannot re-review/);
  });
});
