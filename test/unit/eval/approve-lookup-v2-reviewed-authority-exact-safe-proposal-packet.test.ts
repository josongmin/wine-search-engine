import { describe, expect, it } from 'vitest';
import { approveLookupV2ReviewedAuthorityExactSafeProposalPacket } from '../../../scripts/eval/approve-lookup-v2-reviewed-authority-exact-safe-proposal-packet.js';

describe('approveLookupV2ReviewedAuthorityExactSafeProposalPacket', () => {
  it('auto-approves only registry-final exact authority sources', () => {
    const rows = approveLookupV2ReviewedAuthorityExactSafeProposalPacket({
      packetRows: [
        {
          surface: '샤또 라뚜르 2016',
          entityId: 'wine-ce-latour',
          candidatePromotionClass: 'exact_safe',
          locale: 'ko',
          proposalStatus: 'needs_review',
          reviewTarget: 'lookup_exact_safe_registry_v1',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_exact_vintage',
          benchmarkGoldHint: 'latour',
          benchmarkGoldEntityIdSource: 'semantic_policy_registry',
          sourceArtifact: '/tmp/a.json',
          sourceEvidence: 'coverage hole',
          proposedAt: '2026-06-06T00:00:00.000Z',
        },
        {
          surface: '페트뤼스',
          entityId: 'wine-ce-petrus',
          candidatePromotionClass: 'exact_safe',
          locale: 'ko',
          proposalStatus: 'needs_review',
          reviewTarget: 'lookup_exact_safe_registry_v1',
          suggestedAliasType: 'translation',
          holeClass: 'realworld_frenchish_korean_gap',
          benchmarkGoldHint: 'petrus',
          benchmarkGoldEntityIdSource: 'semantic_scope_target_registry',
          sourceArtifact: '/tmp/c.json',
          sourceEvidence: 'coverage hole',
          proposedAt: '2026-06-06T00:00:00.000Z',
        },
        {
          surface: '폴 로저 윈스턴 처칠',
          entityId: 'wine-ce-pol-roger',
          candidatePromotionClass: 'exact_safe',
          locale: 'ko',
          proposalStatus: 'needs_review',
          reviewTarget: 'lookup_exact_safe_registry_v1',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_brand_suffix',
          benchmarkGoldHint: 'pol roger',
          benchmarkGoldEntityIdSource: 'runtime_identity_safe_alias',
          sourceArtifact: '/tmp/b.json',
          sourceEvidence: 'coverage hole',
          proposedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
      reviewedBy: 'registry:reviewed-authority',
      reviewedAt: '2026-06-06T01:00:00.000Z',
      decisionReason: 'approved upstream reviewed authority source',
    });

    expect(rows[0]).toEqual(expect.objectContaining({
      proposalStatus: 'approved',
      reviewedBy: 'registry:reviewed-authority',
    }));
    expect(rows[1]).toEqual(expect.objectContaining({
      proposalStatus: 'approved',
    }));
    expect(rows[2]).toEqual(expect.objectContaining({
      proposalStatus: 'needs_review',
    }));
  });
});
