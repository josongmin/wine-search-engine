import { describe, expect, it } from 'vitest';
import { buildLookupV2ExactSafeFamilyReviewPacketRows } from '../../../scripts/eval/export-lookup-v2-exact-safe-family-review-packet.js';

describe('buildLookupV2ExactSafeFamilyReviewPacketRows', () => {
  it('groups exact-safe proposal rows by entityId', () => {
    const rows = buildLookupV2ExactSafeFamilyReviewPacketRows({
      packetRows: [
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
          sourceArtifact: '/tmp/b.json',
          sourceEvidence: 'coverage hole B',
          proposedAt: '2026-06-05T01:00:00.000Z',
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
          sourceArtifact: '/tmp/c.json',
          sourceEvidence: 'coverage hole C',
          proposedAt: '2026-06-05T00:30:00.000Z',
        },
      ],
    });

    expect(rows).toEqual([
      {
        entityId: 'wine-ce-cheval-blanc',
        locale: 'ko',
        candidatePromotionClass: 'exact_safe',
        benchmarkGoldEntityIdSources: ['hint_resolution'],
        proposalStatus: 'needs_review',
        reviewTarget: 'lookup_exact_safe_registry_v1',
        surfaces: ['슈발 블랑 2010', '슈발블랑 생테밀리옹'],
        benchmarkGoldHints: ['cheval blanc'],
        holeClasses: ['realworld_compact_alias', 'realworld_exact_vintage'],
        suggestedAliasTypes: ['canonical', 'translation'],
        rowCount: 2,
        sourceArtifacts: ['/tmp/a.json', '/tmp/b.json'],
        sourceEvidenceSamples: ['coverage hole A', 'coverage hole B'],
        proposedAt: '2026-06-05T01:00:00.000Z',
      },
      {
        entityId: 'wine-ce-pol-roger',
        locale: 'ko',
        candidatePromotionClass: 'exact_safe',
        benchmarkGoldEntityIdSources: ['runtime_identity_safe_alias'],
        proposalStatus: 'needs_review',
        reviewTarget: 'lookup_exact_safe_registry_v1',
        surfaces: ['폴 로저 윈스턴 처칠'],
        benchmarkGoldHints: ['pol roger'],
        holeClasses: ['realworld_brand_suffix'],
        suggestedAliasTypes: ['canonical'],
        rowCount: 1,
        sourceArtifacts: ['/tmp/c.json'],
        sourceEvidenceSamples: ['coverage hole C'],
        proposedAt: '2026-06-05T00:30:00.000Z',
      },
    ]);
  });
});
