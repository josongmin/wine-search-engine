import { describe, expect, it } from 'vitest';
import { applyLookupV2ExactSafeFamilyReviewPacket } from '../../../scripts/eval/apply-lookup-v2-exact-safe-family-review-packet.js';

describe('applyLookupV2ExactSafeFamilyReviewPacket', () => {
  it('projects scope-reviewed exact-safe decisions back to matching row packet rows only', () => {
    const rows = applyLookupV2ExactSafeFamilyReviewPacket({
      familyRows: [
        {
          reviewScopeKey: 'wine-ce-cheval-blanc::canonical::realworld_exact_vintage',
          entityId: 'wine-ce-cheval-blanc',
          locale: 'ko',
          candidatePromotionClass: 'exact_safe',
          benchmarkGoldEntityIdSources: ['hint_resolution'],
          proposalStatus: 'approved',
          reviewTarget: 'lookup_exact_safe_registry_v1',
          scopeHoleClass: 'realworld_exact_vintage',
          scopeSuggestedAliasType: 'canonical',
          surfaces: ['슈발 블랑 2010'],
          benchmarkGoldHints: ['cheval blanc'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['coverage hole'],
          proposedAt: '2026-06-05T00:00:00.000Z',
          reviewedAt: '2026-06-06T00:00:00.000Z',
          reviewedBy: 'op',
          decisionReason: 'family reviewed',
        },
        {
          reviewScopeKey: 'wine-ce-cheval-blanc::translation::realworld_compact_alias',
          entityId: 'wine-ce-cheval-blanc',
          locale: 'ko',
          candidatePromotionClass: 'exact_safe',
          benchmarkGoldEntityIdSources: ['hint_resolution'],
          proposalStatus: 'needs_review',
          reviewTarget: 'lookup_exact_safe_registry_v1',
          scopeHoleClass: 'realworld_compact_alias',
          scopeSuggestedAliasType: 'translation',
          surfaces: ['슈발블랑 생테밀리옹'],
          benchmarkGoldHints: ['cheval blanc'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['coverage hole'],
          proposedAt: '2026-06-05T00:00:00.000Z',
        },
      ],
      rowPacketRows: [
        {
          surface: '슈발 블랑 2010',
          entityId: 'wine-ce-cheval-blanc',
          candidatePromotionClass: 'exact_safe',
          locale: 'ko',
          proposalStatus: 'needs_review',
          reviewTarget: 'lookup_exact_safe_registry_v1',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_exact_vintage',
          benchmarkGoldHint: 'cheval blanc',
          benchmarkGoldEntityIdSource: 'hint_resolution',
          sourceArtifact: '/tmp/a.json',
          sourceEvidence: 'coverage hole A',
          proposedAt: '2026-06-05T00:00:00.000Z',
        },
        {
          surface: '슈발블랑 생테밀리옹',
          entityId: 'wine-ce-cheval-blanc',
          candidatePromotionClass: 'exact_safe',
          locale: 'ko',
          proposalStatus: 'needs_review',
          reviewTarget: 'lookup_exact_safe_registry_v1',
          suggestedAliasType: 'translation',
          holeClass: 'realworld_compact_alias',
          benchmarkGoldHint: 'cheval blanc',
          benchmarkGoldEntityIdSource: 'hint_resolution',
          sourceArtifact: '/tmp/a.json',
          sourceEvidence: 'coverage hole B',
          proposedAt: '2026-06-05T00:00:00.000Z',
        },
      ],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        surface: '슈발 블랑 2010',
        proposalStatus: 'approved',
        reviewedBy: 'op',
      }),
      expect.objectContaining({
        surface: '슈발블랑 생테밀리옹',
        proposalStatus: 'needs_review',
      }),
    ]);
  });

  it('fails closed when a row has no family owner', () => {
    expect(() => applyLookupV2ExactSafeFamilyReviewPacket({
      familyRows: [],
      rowPacketRows: [
        {
          surface: '슈발 블랑 2010',
          entityId: 'wine-ce-cheval-blanc',
          candidatePromotionClass: 'exact_safe',
          locale: 'ko',
          proposalStatus: 'needs_review',
          reviewTarget: 'lookup_exact_safe_registry_v1',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_exact_vintage',
          benchmarkGoldHint: 'cheval blanc',
          benchmarkGoldEntityIdSource: 'hint_resolution',
          sourceArtifact: '/tmp/a.json',
          sourceEvidence: 'coverage hole A',
          proposedAt: '2026-06-05T00:00:00.000Z',
        },
      ],
    })).toThrow(/no family review row/);
  });
});
