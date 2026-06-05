import { describe, expect, it } from 'vitest';
import {
  buildLookupExactSafeProposalPacketRowsFromCandidates,
  buildLookupExactSafeProposalPacketRows,
} from '../../../scripts/eval/export-lookup-v2-exact-safe-proposal-packet.js';

describe('buildLookupExactSafeProposalPacketRows', () => {
  it('projects auto_targetable draft rows into a reviewed exact-safe packet', () => {
    const rows = buildLookupExactSafeProposalPacketRows({
      draftRows: [
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
        {
          surface: '도미누스',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_gap_napa_icon',
          observedStatus: 'failed',
          benchmarkGoldHint: 'dominus',
          triageBucket: 'manual_target',
          sourceArtifact: '/tmp/sample.json',
          sourceEvidence: 'coverage hole',
          reviewedAt: '2026-06-05T00:00:00.000Z',
        },
        {
          surface: '라뚜르 2009',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'failed',
          benchmarkGoldHint: 'latour',
          benchmarkGoldEntityId: 'wine-ce-latour',
          benchmarkGoldEntityIdSource: 'hint_resolution',
          triageBucket: 'policy_review',
          policyConflictHint: 'latour',
          sourceArtifact: '/tmp/sample.json',
          sourceEvidence: 'coverage hole',
          reviewedAt: '2026-06-05T00:00:00.000Z',
        },
      ],
    });

    expect(rows).toEqual([
      {
        surface: '샤또 무통 로쉴드',
        entityId: 'wine-ce-mouton',
        candidatePromotionClass: 'exact_safe',
        locale: 'ko',
        proposalStatus: 'needs_review',
        reviewTarget: 'lookup_exact_safe_registry_v1',
        suggestedAliasType: 'translation',
        holeClass: 'realworld_korean_orthography',
        benchmarkGoldHint: 'mouton',
        benchmarkGoldEntityIdSource: 'hint_resolution',
        sourceArtifact: '/tmp/sample.json',
        sourceEvidence: 'coverage hole',
        proposedAt: '2026-06-05T00:00:00.000Z',
      },
    ]);
  });

  it('skips rows already curated for the same entity', () => {
    const rows = buildLookupExactSafeProposalPacketRows({
      draftRows: [
        {
          surface: '샤또 무통 로쉴드',
          locale: 'ko',
          suggestedAliasType: 'translation',
          holeClass: 'realworld_korean_orthography',
          observedStatus: 'failed',
          benchmarkGoldEntityId: 'wine-ce-mouton',
          benchmarkGoldEntityIdSource: 'hint_resolution',
          triageBucket: 'auto_targetable',
          sourceArtifact: '/tmp/sample.json',
          sourceEvidence: 'coverage hole',
          reviewedAt: '2026-06-05T00:00:00.000Z',
        },
      ],
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
    });

    expect(rows).toEqual([]);
  });

  it('carries runtime identity-safe alias authority sources into the packet', () => {
    const rows = buildLookupExactSafeProposalPacketRows({
      draftRows: [
        {
          surface: '폴 로저 윈스턴 처칠',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_brand_suffix',
          observedStatus: 'failed',
          benchmarkGoldHint: 'pol roger',
          benchmarkGoldEntityId: 'wine-ce-pol-roger',
          benchmarkGoldEntityIdSource: 'runtime_identity_safe_alias',
          triageBucket: 'auto_targetable',
          sourceArtifact: '/tmp/sample.json',
          sourceEvidence: 'coverage hole',
          reviewedAt: '2026-06-05T00:00:00.000Z',
        },
      ],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        surface: '폴 로저 윈스턴 처칠',
        entityId: 'wine-ce-pol-roger',
        benchmarkGoldEntityIdSource: 'runtime_identity_safe_alias',
      }),
    ]);
  });

  it('accepts manual family review targets as exact-safe packet sources', () => {
    const rows = buildLookupExactSafeProposalPacketRowsFromCandidates({
      candidateRows: [
        {
          surface: '칼롱 세귀르',
          entityId: 'wine-ce-calon-segur',
          locale: 'ko',
          suggestedAliasType: 'translation',
          holeClass: 'realworld_korean_orthography',
          benchmarkGoldHint: 'calon segur',
          benchmarkGoldEntityIdSource: 'manual_family_review_target',
          sourceArtifact: '/tmp/manual-family-reviewed.jsonl',
          sourceEvidence: 'coverage hole [manual target family review]',
          proposedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        surface: '칼롱 세귀르',
        entityId: 'wine-ce-calon-segur',
        benchmarkGoldEntityIdSource: 'manual_family_review_target',
      }),
    ]);
  });

  it('fails closed when a draft surface conflicts with an existing curated owner', () => {
    expect(() => buildLookupExactSafeProposalPacketRows({
      draftRows: [
        {
          surface: '샤또 무통 로쉴드',
          locale: 'ko',
          suggestedAliasType: 'translation',
          holeClass: 'realworld_korean_orthography',
          observedStatus: 'failed',
          benchmarkGoldEntityId: 'wine-ce-mouton',
          benchmarkGoldEntityIdSource: 'hint_resolution',
          triageBucket: 'auto_targetable',
          sourceArtifact: '/tmp/sample.json',
          sourceEvidence: 'coverage hole',
          reviewedAt: '2026-06-05T00:00:00.000Z',
        },
      ],
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
    })).toThrow(/conflicts with existing registry owner/);
  });
});
