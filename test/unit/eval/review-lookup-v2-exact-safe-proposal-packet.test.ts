import { describe, expect, it } from 'vitest';
import { applyLookupExactSafeProposalReviewDecisions } from '../../../scripts/eval/review-lookup-v2-exact-safe-proposal-packet.js';

describe('applyLookupExactSafeProposalReviewDecisions', () => {
  it('applies approve/reject decisions onto needs_review packet rows', () => {
    const reviewed = applyLookupExactSafeProposalReviewDecisions({
      packetRows: [
        {
          surface: '샤또 무통 로쉴드',
          entityId: 'wine-ce-mouton',
          candidatePromotionClass: 'exact_safe',
          locale: 'ko',
          proposalStatus: 'needs_review',
          reviewTarget: 'lookup_exact_safe_registry_v1',
          suggestedAliasType: 'translation',
          holeClass: 'realworld_korean_orthography',
          benchmarkGoldEntityIdSource: 'hint_resolution',
          sourceArtifact: '/tmp/sample.json',
          sourceEvidence: 'coverage hole',
          proposedAt: '2026-06-05T00:00:00.000Z',
        },
        {
          surface: '슈발 블랑 2015',
          entityId: 'wine-ce-cheval',
          candidatePromotionClass: 'exact_safe',
          locale: 'ko',
          proposalStatus: 'needs_review',
          reviewTarget: 'lookup_exact_safe_registry_v1',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_exact_vintage',
          benchmarkGoldEntityIdSource: 'hint_resolution',
          sourceArtifact: '/tmp/sample.json',
          sourceEvidence: 'coverage hole',
          proposedAt: '2026-06-05T00:00:00.000Z',
        },
      ],
      decisionRows: [
        {
          surface: '샤또 무통 로쉴드',
          entityId: 'wine-ce-mouton',
          decision: 'approve',
          reviewedBy: 'op',
          decisionReason: 'verified singleton',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
        {
          surface: '슈발 블랑 2015',
          entityId: 'wine-ce-cheval',
          decision: 'reject',
          reviewedBy: 'op',
          decisionReason: 'too broad',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
    });

    expect(reviewed.map((row) => row.proposalStatus)).toEqual(['approved', 'rejected']);
    expect(reviewed[0]).toEqual(expect.objectContaining({
      reviewedBy: 'op',
      decisionReason: 'verified singleton',
      reviewedAt: '2026-06-06T00:00:00.000Z',
    }));
  });

  it('fails closed on duplicate or unknown decisions', () => {
    expect(() => applyLookupExactSafeProposalReviewDecisions({
      packetRows: [
        {
          surface: '샤또 무통 로쉴드',
          entityId: 'wine-ce-mouton',
          candidatePromotionClass: 'exact_safe',
          locale: 'ko',
          proposalStatus: 'needs_review',
          reviewTarget: 'lookup_exact_safe_registry_v1',
          suggestedAliasType: 'translation',
          holeClass: 'realworld_korean_orthography',
          benchmarkGoldEntityIdSource: 'hint_resolution',
          sourceArtifact: '/tmp/sample.json',
          sourceEvidence: 'coverage hole',
          proposedAt: '2026-06-05T00:00:00.000Z',
        },
      ],
      decisionRows: [
        {
          surface: '샤또 무통 로쉴드',
          entityId: 'wine-ce-mouton',
          decision: 'approve',
          reviewedBy: 'op',
          decisionReason: 'verified singleton',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
        {
          surface: '샤또 무통 로쉴드',
          entityId: 'wine-ce-mouton',
          decision: 'reject',
          reviewedBy: 'op',
          decisionReason: 'duplicate',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
    })).toThrow(/duplicate review decision/);

    expect(() => applyLookupExactSafeProposalReviewDecisions({
      packetRows: [],
      decisionRows: [
        {
          surface: '샤또 무통 로쉴드',
          entityId: 'wine-ce-mouton',
          decision: 'approve',
          reviewedBy: 'op',
          decisionReason: 'verified singleton',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
    })).not.toThrow();

    expect(applyLookupExactSafeProposalReviewDecisions({
      packetRows: [],
      decisionRows: [
        {
          surface: '샤또 무통 로쉴드',
          entityId: 'wine-ce-mouton',
          decision: 'approve',
          reviewedBy: 'op',
          decisionReason: 'verified singleton',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
    })).toEqual([]);
  });

  it('fails closed on re-reviewing terminal rows', () => {
    expect(() => applyLookupExactSafeProposalReviewDecisions({
      packetRows: [
        {
          surface: '샤또 무통 로쉴드',
          entityId: 'wine-ce-mouton',
          candidatePromotionClass: 'exact_safe',
          locale: 'ko',
          proposalStatus: 'approved',
          reviewTarget: 'lookup_exact_safe_registry_v1',
          suggestedAliasType: 'translation',
          holeClass: 'realworld_korean_orthography',
          benchmarkGoldEntityIdSource: 'hint_resolution',
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
          surface: '샤또 무통 로쉴드',
          entityId: 'wine-ce-mouton',
          decision: 'reject',
          reviewedBy: 'op',
          decisionReason: 'should fail',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
    })).toThrow(/cannot re-review/);
  });
});
