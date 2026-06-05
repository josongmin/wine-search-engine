import { describe, expect, it } from 'vitest';
import { applyLookupExactSafeProposalPacket } from '../../../scripts/eval/apply-lookup-v2-exact-safe-proposal-packet.js';

describe('applyLookupExactSafeProposalPacket', () => {
  it('merges approved packet rows into the registry deterministically', () => {
    const result = applyLookupExactSafeProposalPacket({
      packetPath: 'data/lookup-v2/drafts/example.jsonl',
      existingRegistryRows: [
        {
          surface: '오푸스원',
          entityId: 'opus-one-2018',
          promotionClass: 'exact_safe',
          locale: 'ko',
          sourceEvidence: 'seed',
          reviewedAt: '2026-06-04T00:00:00.000Z',
        },
      ],
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
          reviewedAt: '2026-06-06T00:00:00.000Z',
          reviewedBy: 'op',
          decisionReason: 'verified singleton',
        },
      ],
    });

    expect(result.approvedRows).toBe(1);
    expect(result.insertedRows).toBe(1);
    expect(result.skippedExistingRows).toBe(0);
    expect(result.mergedRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          surface: '샤또 무통 로쉴드',
          entityId: 'wine-ce-mouton',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        }),
      ]),
    );
  });

  it('skips non-approved rows and same-owner normalized duplicates', () => {
    const result = applyLookupExactSafeProposalPacket({
      packetPath: 'data/lookup-v2/drafts/example.jsonl',
      existingRegistryRows: [
        {
          surface: '샤또 무통 로쉴드',
          entityId: 'wine-ce-mouton',
          promotionClass: 'exact_safe',
          locale: 'ko',
          sourceEvidence: 'seed',
          reviewedAt: '2026-06-04T00:00:00.000Z',
        },
      ],
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
          reviewedAt: '2026-06-06T00:00:00.000Z',
          reviewedBy: 'op',
          decisionReason: 'verified singleton',
        },
        {
          surface: '라뚜르',
          entityId: 'wine-ce-latour',
          candidatePromotionClass: 'exact_safe',
          locale: 'ko',
          proposalStatus: 'needs_review',
          reviewTarget: 'lookup_exact_safe_registry_v1',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_short_form_collision',
          benchmarkGoldEntityIdSource: 'hint_resolution',
          sourceArtifact: '/tmp/sample.json',
          sourceEvidence: 'coverage hole',
          proposedAt: '2026-06-05T00:00:00.000Z',
        },
      ],
    });

    expect(result.approvedRows).toBe(1);
    expect(result.insertedRows).toBe(0);
    expect(result.skippedExistingRows).toBe(1);
    expect(result.mergedRows).toHaveLength(1);
  });

  it('fails closed on conflicting owner or missing review metadata', () => {
    expect(() => applyLookupExactSafeProposalPacket({
      packetPath: 'data/lookup-v2/drafts/example.jsonl',
      existingRegistryRows: [
        {
          surface: '샤또 무통 로쉴드',
          entityId: 'wine-ce-other',
          promotionClass: 'exact_safe',
          locale: 'ko',
          sourceEvidence: 'seed',
          reviewedAt: '2026-06-04T00:00:00.000Z',
        },
      ],
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
          reviewedAt: '2026-06-06T00:00:00.000Z',
          reviewedBy: 'op',
          decisionReason: 'verified singleton',
        },
      ],
    })).toThrow(/conflicts with existing owner/);

    expect(() => applyLookupExactSafeProposalPacket({
      packetPath: 'data/lookup-v2/drafts/example.jsonl',
      existingRegistryRows: [],
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
        },
      ],
    })).toThrow(/missing reviewedAt/);
  });
});
