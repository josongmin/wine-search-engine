import { describe, expect, it } from 'vitest';
import {
  applyLookupV2ExactSafeScopeRegistryToFamilyReviewPacketRows,
  buildLookupV2ExactSafeFamilyReviewPacketRows,
} from '../../../scripts/eval/export-lookup-v2-exact-safe-family-review-packet.js';

describe('buildLookupV2ExactSafeFamilyReviewPacketRows', () => {
  it('groups exact-safe proposal rows by deterministic review scope', () => {
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
        reviewScopeKey: 'wine-ce-cheval-blanc::canonical::realworld_exact_vintage',
        entityId: 'wine-ce-cheval-blanc',
        locale: 'ko',
        candidatePromotionClass: 'exact_safe',
        benchmarkGoldEntityIdSources: ['hint_resolution'],
        proposalStatus: 'needs_review',
        reviewTarget: 'lookup_exact_safe_registry_v1',
        scopeHoleClass: 'realworld_exact_vintage',
        scopeSuggestedAliasType: 'canonical',
        surfaces: ['슈발 블랑 2010'],
        benchmarkGoldHints: ['cheval blanc'],
        rowCount: 1,
        sourceArtifacts: ['/tmp/a.json'],
        sourceEvidenceSamples: ['coverage hole A'],
        proposedAt: '2026-06-05T00:00:00.000Z',
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
        sourceArtifacts: ['/tmp/b.json'],
        sourceEvidenceSamples: ['coverage hole B'],
        proposedAt: '2026-06-05T01:00:00.000Z',
      },
      {
        reviewScopeKey: 'wine-ce-pol-roger::canonical::realworld_brand_suffix',
        entityId: 'wine-ce-pol-roger',
        locale: 'ko',
        candidatePromotionClass: 'exact_safe',
        benchmarkGoldEntityIdSources: ['runtime_identity_safe_alias'],
        proposalStatus: 'needs_review',
        reviewTarget: 'lookup_exact_safe_registry_v1',
        scopeHoleClass: 'realworld_brand_suffix',
        scopeSuggestedAliasType: 'canonical',
        surfaces: ['폴 로저 윈스턴 처칠'],
        benchmarkGoldHints: ['pol roger'],
        rowCount: 1,
        sourceArtifacts: ['/tmp/c.json'],
        sourceEvidenceSamples: ['coverage hole C'],
        proposedAt: '2026-06-05T00:30:00.000Z',
      },
    ]);
  });

  it('preserves reviewed proposal status when the row packet is already scope-reviewed', () => {
    const rows = buildLookupV2ExactSafeFamilyReviewPacketRows({
      packetRows: [
        {
          surface: '페트뤼스',
          entityId: 'wine-ce-petrus',
          candidatePromotionClass: 'exact_safe',
          locale: 'ko',
          proposalStatus: 'rejected',
          reviewTarget: 'lookup_exact_safe_registry_v1',
          suggestedAliasType: 'translation',
          holeClass: 'realworld_frenchish_korean_gap',
          benchmarkGoldHint: 'petrus',
          benchmarkGoldEntityIdSource: 'semantic_scope_target_registry',
          sourceArtifact: '/tmp/a.json',
          sourceEvidence: 'coverage hole A',
          proposedAt: '2026-06-05T00:00:00.000Z',
          reviewedBy: 'registry',
          reviewedAt: '2026-06-06T00:00:00.000Z',
          decisionReason: 'reviewed reject',
        },
      ],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        reviewScopeKey: 'wine-ce-petrus::translation::realworld_frenchish_korean_gap',
        proposalStatus: 'rejected',
        reviewedBy: 'registry',
        reviewedAt: '2026-06-06T00:00:00.000Z',
        decisionReason: 'reviewed reject',
      }),
    ]);
  });

  it('overlays reviewed exact-safe scope registry decisions onto matching family rows only', () => {
    const rows = applyLookupV2ExactSafeScopeRegistryToFamilyReviewPacketRows({
      familyRows: [
        {
          reviewScopeKey: 'wine-ce-cheval-blanc::canonical::realworld_exact_vintage',
          entityId: 'wine-ce-cheval-blanc',
          locale: 'ko',
          candidatePromotionClass: 'exact_safe',
          benchmarkGoldEntityIdSources: ['family_target_registry'],
          proposalStatus: 'needs_review',
          reviewTarget: 'lookup_exact_safe_registry_v1',
          scopeHoleClass: 'realworld_exact_vintage',
          scopeSuggestedAliasType: 'canonical',
          surfaces: ['슈발 블랑 2010'],
          benchmarkGoldHints: ['cheval blanc'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['coverage hole A'],
          proposedAt: '2026-06-05T00:00:00.000Z',
        },
        {
          reviewScopeKey: 'wine-ce-cheval-blanc::translation::realworld_compact_alias',
          entityId: 'wine-ce-cheval-blanc',
          locale: 'ko',
          candidatePromotionClass: 'exact_safe',
          benchmarkGoldEntityIdSources: ['family_target_registry'],
          proposalStatus: 'needs_review',
          reviewTarget: 'lookup_exact_safe_registry_v1',
          scopeHoleClass: 'realworld_compact_alias',
          scopeSuggestedAliasType: 'translation',
          surfaces: ['슈발블랑'],
          benchmarkGoldHints: ['cheval blanc'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/b.json'],
          sourceEvidenceSamples: ['coverage hole B'],
          proposedAt: '2026-06-05T00:00:00.000Z',
        },
      ],
      scopeRegistryMap: new Map([
        ['wine-ce-cheval-blanc::canonical::realworld_exact_vintage', {
          reviewScopeKey: 'wine-ce-cheval-blanc::canonical::realworld_exact_vintage',
          entityId: 'wine-ce-cheval-blanc',
          scopeHoleClass: 'realworld_exact_vintage',
          scopeSuggestedAliasType: 'canonical',
          decisionStatus: 'rejected',
          reviewedBy: 'registry',
          reviewedAt: '2026-06-06T00:00:00.000Z',
          decisionReason: 'reviewed reject',
          evidenceClass: 'exact_safe_family_review',
        }],
      ]),
    });

    expect(rows).toEqual([
      expect.objectContaining({
        reviewScopeKey: 'wine-ce-cheval-blanc::canonical::realworld_exact_vintage',
        proposalStatus: 'rejected',
        reviewedBy: 'registry',
      }),
      expect.objectContaining({
        reviewScopeKey: 'wine-ce-cheval-blanc::translation::realworld_compact_alias',
        proposalStatus: 'needs_review',
      }),
    ]);
  });
});
