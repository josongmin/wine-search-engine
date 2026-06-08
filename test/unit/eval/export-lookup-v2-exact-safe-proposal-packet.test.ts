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

  it('fails closed when semantic scope target authority is provided without the approved scope map', () => {
    expect(() => buildLookupExactSafeProposalPacketRows({
      draftRows: [
        {
          surface: '팔머 2020',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'failed',
          benchmarkGoldHint: 'palmer',
          benchmarkGoldEntityId: 'wine-ce-palmer-grand-vin',
          benchmarkGoldEntityIdSource: 'semantic_scope_target_registry',
          semanticScopeKey: 'line::palmer::::::::2020::qualified::ko',
          scopeAxis: 'line',
          familyKey: 'palmer',
          vintage: 2020,
          surfaceFormKind: 'qualified',
          triageBucket: 'auto_targetable',
          sourceArtifact: '/tmp/sample.json',
          sourceEvidence: 'reviewed semantic scope authority',
          reviewedAt: '2026-06-08T00:00:00.000Z',
        },
      ],
    })).toThrow(/requires approved semantic scope target map/);
  });

  it('does not promote detached-vintage reviewed collision authority into exact-safe proposals', () => {
    const rows = buildLookupExactSafeProposalPacketRows({
      draftRows: [
        {
          surface: '팔머 2020',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'failed',
          benchmarkGoldHint: 'palmer',
          benchmarkGoldEntityId: 'wine-ce-palmer-grand-vin',
          benchmarkGoldEntityIdSource: 'semantic_scope_target_registry',
          semanticScopeKey: 'line::palmer::::::::2020::qualified::ko',
          scopeAxis: 'line',
          familyKey: 'palmer',
          vintage: 2020,
          surfaceFormKind: 'qualified',
          triageBucket: 'auto_targetable',
          sourceArtifact: '/tmp/sample.json',
          sourceEvidence: 'reviewed semantic scope authority',
          reviewedAt: '2026-06-08T00:00:00.000Z',
        },
      ],
      semanticScopeTargetApprovedMap: new Map([
        ['line::palmer::::::::2020::qualified::ko', {
          semanticScopeKey: 'line::palmer::::::::2020::qualified::ko',
          benchmarkGoldHint: 'palmer',
          normalizedBenchmarkGoldHint: 'palmer',
          scopeAxis: 'line',
          familyKey: 'palmer',
          vintage: 2020,
          surfaceFormKind: 'qualified',
          locale: 'ko',
          entityId: 'wine-ce-palmer-grand-vin',
          decisionStatus: 'approved',
          reviewedBy: 'registry',
          reviewedAt: '2026-06-08T00:00:00.000Z',
          decisionReason: 'reviewed collision lane',
          evidenceClass: 'reviewed_collision_family_review',
        }],
      ]),
    });

    expect(rows).toEqual([]);
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

  it('overlays reviewed exact-safe scope decisions onto matching proposal rows', () => {
    const rows = buildLookupExactSafeProposalPacketRowsFromCandidates({
      candidateRows: [
        {
          surface: '페트뤼스',
          entityId: 'wine-ce-petrus',
          locale: 'ko',
          suggestedAliasType: 'translation',
          holeClass: 'realworld_frenchish_korean_gap',
          semanticScopeKey: 'family::petrus::::::bare::ko',
          benchmarkGoldHint: 'petrus',
          benchmarkGoldEntityIdSource: 'semantic_scope_target_registry',
          sourceArtifact: '/tmp/manual-family-reviewed.jsonl',
          sourceEvidence: 'coverage hole [reviewed exact-safe scope reject]',
          proposedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
      semanticScopeTargetApprovedMap: new Map([
        ['family::petrus::::::bare::ko', {
          semanticScopeKey: 'family::petrus::::::bare::ko',
          benchmarkGoldHint: 'petrus',
          normalizedBenchmarkGoldHint: 'petrus',
          scopeAxis: 'family',
          familyKey: 'petrus',
          surfaceFormKind: 'bare',
          locale: 'ko',
          entityId: 'wine-ce-petrus',
          decisionStatus: 'approved',
          reviewedBy: 'registry',
          reviewedAt: '2026-06-06T00:30:00.000Z',
          decisionReason: 'reviewed family authority',
          evidenceClass: 'manual_target_family_review',
        }],
      ]),
      exactSafeScopeRegistryMap: new Map([
        ['wine-ce-petrus::translation::realworld_frenchish_korean_gap', {
          reviewScopeKey: 'wine-ce-petrus::translation::realworld_frenchish_korean_gap',
          entityId: 'wine-ce-petrus',
          scopeHoleClass: 'realworld_frenchish_korean_gap',
          scopeSuggestedAliasType: 'translation',
          decisionStatus: 'rejected',
          reviewedBy: 'registry',
          reviewedAt: '2026-06-06T01:00:00.000Z',
          decisionReason: 'reviewed reject',
          evidenceClass: 'exact_safe_family_review',
        }],
      ]),
    });

    expect(rows).toEqual([
      expect.objectContaining({
        surface: '페트뤼스',
        entityId: 'wine-ce-petrus',
        proposalStatus: 'rejected',
        reviewedBy: 'registry',
        reviewedAt: '2026-06-06T01:00:00.000Z',
        decisionReason: 'reviewed reject',
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
