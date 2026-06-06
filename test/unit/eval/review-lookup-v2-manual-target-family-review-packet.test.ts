import { describe, expect, it } from 'vitest';
import { applyLookupV2ManualTargetFamilyReviewDecisions } from '../../../scripts/eval/review-lookup-v2-manual-target-family-review-packet.js';

describe('applyLookupV2ManualTargetFamilyReviewDecisions', () => {
  it('applies direct semantic-scope decisions deterministically', () => {
    const result = applyLookupV2ManualTargetFamilyReviewDecisions({
      packetRows: [
        {
          semanticScopeKey: 'family::calon segur::::::::::bare::ko',
          scopeAxis: 'family',
          familyKey: 'calon segur',
          surfaceFormKind: 'bare',
          reviewScopeKey: 'family::calon segur::::::::::bare::ko',
          legacyReviewScopeKeys: ['calon segur::translation::realworld_korean_orthography'],
          benchmarkGoldHint: 'calon segur',
          normalizedBenchmarkGoldHint: 'calon segur',
          benchmarkGoldHintVariants: ['calon segur'],
          proposalStatus: 'needs_target_review',
          reviewTarget: 'lookup_manual_target_resolution_v1',
          scopeHoleClass: 'realworld_korean_orthography',
          scopeSuggestedAliasType: 'translation',
          locales: ['ko'],
          scopeRisk: 'family_only',
          surfaces: ['칼롱 세귀르'],
          holeClasses: ['realworld_korean_orthography'],
          suggestedAliasTypes: ['translation'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['coverage hole'],
          runtimeEvidenceStatus: 'candidate_unique_owner',
          proposedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
      decisionRows: [
        {
          reviewScopeKey: 'family::calon segur::::::::::bare::ko',
          benchmarkGoldHint: 'Calon Segur',
          decision: 'assign_target',
          entityId: 'wine-ce-calon-segur',
          reviewedBy: 'op',
          decisionReason: 'single iconic target family',
          reviewedAt: '2026-06-06T01:00:00.000Z',
        },
      ],
    });

    expect(result.matchedDecisionRows).toBe(1);
    expect(result.staleDecisionRows).toBe(0);
    expect(result.ambiguousLegacyDecisionRows).toBe(0);
    expect(result.reviewedRows).toEqual([
      expect.objectContaining({
        proposalStatus: 'target_assigned',
        targetEntityId: 'wine-ce-calon-segur',
        reviewedBy: 'op',
      }),
    ]);
  });

  it('resolves a legacy reviewScopeKey onto the current semantic scope when the mapping is 1:1', () => {
    const result = applyLookupV2ManualTargetFamilyReviewDecisions({
      packetRows: [
        {
          semanticScopeKey: 'family::cheval blanc::::::::::bare::ko',
          scopeAxis: 'family',
          familyKey: 'cheval blanc',
          surfaceFormKind: 'bare',
          reviewScopeKey: 'family::cheval blanc::::::::::bare::ko',
          legacyReviewScopeKeys: [
            'cheval blanc::canonical::realworld_exact_vintage',
            'cheval blanc::canonical::realworld_spaced_alias',
          ],
          benchmarkGoldHint: 'cheval blanc',
          normalizedBenchmarkGoldHint: 'cheval blanc',
          benchmarkGoldHintVariants: ['cheval blanc'],
          proposalStatus: 'needs_target_review',
          reviewTarget: 'lookup_manual_target_resolution_v1',
          scopeHoleClass: 'realworld_exact_vintage',
          scopeSuggestedAliasType: 'canonical',
          locales: ['ko'],
          scopeRisk: 'family_only',
          surfaces: ['슈발 블랑 2010'],
          holeClasses: ['realworld_exact_vintage', 'realworld_spaced_alias'],
          suggestedAliasTypes: ['canonical'],
          rowCount: 2,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['coverage hole'],
          runtimeEvidenceStatus: 'collision_candidates',
          proposedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
      decisionRows: [
        {
          reviewScopeKey: 'cheval blanc::canonical::realworld_spaced_alias',
          benchmarkGoldHint: 'cheval blanc',
          decision: 'assign_target',
          entityId: 'wine-ce-cheval-blanc',
          reviewedBy: 'op',
          decisionReason: 'historical reviewed scope matches current family scope',
          reviewedAt: '2026-06-06T01:00:00.000Z',
        },
      ],
    });

    expect(result.matchedDecisionRows).toBe(1);
    expect(result.reviewedRows).toEqual([
      expect.objectContaining({
        proposalStatus: 'target_assigned',
        targetEntityId: 'wine-ce-cheval-blanc',
      }),
    ]);
  });

  it('ignores stale decisions for rows already closed out of the current packet', () => {
    const result = applyLookupV2ManualTargetFamilyReviewDecisions({
      packetRows: [
        {
          semanticScopeKey: 'family::calon segur::::::::::bare::ko',
          scopeAxis: 'family',
          familyKey: 'calon segur',
          surfaceFormKind: 'bare',
          reviewScopeKey: 'family::calon segur::::::::::bare::ko',
          legacyReviewScopeKeys: ['calon segur::translation::realworld_korean_orthography'],
          benchmarkGoldHint: 'calon segur',
          normalizedBenchmarkGoldHint: 'calon segur',
          benchmarkGoldHintVariants: ['calon segur'],
          proposalStatus: 'needs_target_review',
          reviewTarget: 'lookup_manual_target_resolution_v1',
          scopeHoleClass: 'realworld_korean_orthography',
          scopeSuggestedAliasType: 'translation',
          locales: ['ko'],
          scopeRisk: 'family_only',
          surfaces: ['칼롱 세귀르'],
          holeClasses: ['realworld_korean_orthography'],
          suggestedAliasTypes: ['translation'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['coverage hole'],
          runtimeEvidenceStatus: 'candidate_unique_owner',
          proposedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
      decisionRows: [
        {
          reviewScopeKey: 'salon::canonical::realworld_exact_vintage',
          benchmarkGoldHint: 'salon',
          decision: 'assign_target',
          entityId: 'wine-ce-salon',
          reviewedBy: 'op',
          decisionReason: 'unknown',
          reviewedAt: '2026-06-06T01:00:00.000Z',
        },
      ],
    });

    expect(result.matchedDecisionRows).toBe(0);
    expect(result.staleDecisionRows).toBe(1);
    expect(result.reviewedRows).toEqual([
      expect.objectContaining({
        reviewScopeKey: 'family::calon segur::::::::::bare::ko',
        proposalStatus: 'needs_target_review',
      }),
    ]);
  });

  it('skips ambiguous legacy reviewScopeKeys that now span multiple semantic scopes', () => {
    const result = applyLookupV2ManualTargetFamilyReviewDecisions({
      packetRows: [
        {
          semanticScopeKey: 'line::calon segur::::::::2009::qualified::ko',
          scopeAxis: 'line',
          familyKey: 'calon segur',
          vintage: 2009,
          surfaceFormKind: 'qualified',
          reviewScopeKey: 'line::calon segur::::::::2009::qualified::ko',
          legacyReviewScopeKeys: ['calon segur::canonical::realworld_exact_vintage'],
          benchmarkGoldHint: 'calon segur',
          normalizedBenchmarkGoldHint: 'calon segur',
          benchmarkGoldHintVariants: ['calon segur'],
          proposalStatus: 'needs_target_review',
          reviewTarget: 'lookup_manual_target_resolution_v1',
          scopeHoleClass: 'realworld_exact_vintage',
          scopeSuggestedAliasType: 'canonical',
          locales: ['ko'],
          scopeRisk: 'mixed_vintage_family',
          surfaces: ['칼롱 세귀르 2009'],
          holeClasses: ['realworld_exact_vintage'],
          suggestedAliasTypes: ['canonical'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['coverage hole'],
          runtimeEvidenceStatus: 'candidate_unique_owner',
          proposedAt: '2026-06-06T00:00:00.000Z',
        },
        {
          semanticScopeKey: 'line::calon segur::::::::2020::qualified::ko',
          scopeAxis: 'line',
          familyKey: 'calon segur',
          vintage: 2020,
          surfaceFormKind: 'qualified',
          reviewScopeKey: 'line::calon segur::::::::2020::qualified::ko',
          legacyReviewScopeKeys: ['calon segur::canonical::realworld_exact_vintage'],
          benchmarkGoldHint: 'calon segur',
          normalizedBenchmarkGoldHint: 'calon segur',
          benchmarkGoldHintVariants: ['calon segur'],
          proposalStatus: 'needs_target_review',
          reviewTarget: 'lookup_manual_target_resolution_v1',
          scopeHoleClass: 'realworld_exact_vintage',
          scopeSuggestedAliasType: 'canonical',
          locales: ['ko'],
          scopeRisk: 'mixed_vintage_family',
          surfaces: ['칼롱 세귀르 2020'],
          holeClasses: ['realworld_exact_vintage'],
          suggestedAliasTypes: ['canonical'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['coverage hole'],
          runtimeEvidenceStatus: 'candidate_unique_owner',
          proposedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
      decisionRows: [
        {
          reviewScopeKey: 'calon segur::canonical::realworld_exact_vintage',
          benchmarkGoldHint: 'calon segur',
          decision: 'reject',
          reviewedBy: 'op',
          decisionReason: 'legacy scope does not specify which vintage line should own this row',
          reviewedAt: '2026-06-06T01:00:00.000Z',
        },
      ],
    });

    expect(result.matchedDecisionRows).toBe(0);
    expect(result.staleDecisionRows).toBe(0);
    expect(result.ambiguousLegacyDecisionRows).toBe(1);
    expect(result.reviewedRows).toEqual([
      expect.objectContaining({
        reviewScopeKey: 'line::calon segur::::::::2009::qualified::ko',
        proposalStatus: 'needs_target_review',
      }),
      expect.objectContaining({
        reviewScopeKey: 'line::calon segur::::::::2020::qualified::ko',
        proposalStatus: 'needs_target_review',
      }),
    ]);
  });

  it('fails closed when incompatible legacy decisions collapse onto one semantic scope', () => {
    expect(() => applyLookupV2ManualTargetFamilyReviewDecisions({
      packetRows: [
        {
          semanticScopeKey: 'family::cheval blanc::::::::::bare::ko',
          scopeAxis: 'family',
          familyKey: 'cheval blanc',
          surfaceFormKind: 'bare',
          reviewScopeKey: 'family::cheval blanc::::::::::bare::ko',
          legacyReviewScopeKeys: [
            'cheval blanc::canonical::realworld_exact_vintage',
            'cheval blanc::canonical::realworld_spaced_alias',
          ],
          benchmarkGoldHint: 'cheval blanc',
          normalizedBenchmarkGoldHint: 'cheval blanc',
          benchmarkGoldHintVariants: ['cheval blanc'],
          proposalStatus: 'needs_target_review',
          reviewTarget: 'lookup_manual_target_resolution_v1',
          scopeHoleClass: 'realworld_exact_vintage',
          scopeSuggestedAliasType: 'canonical',
          locales: ['ko'],
          scopeRisk: 'family_only',
          surfaces: ['슈발 블랑 2010'],
          holeClasses: ['realworld_exact_vintage', 'realworld_spaced_alias'],
          suggestedAliasTypes: ['canonical'],
          rowCount: 2,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['coverage hole'],
          runtimeEvidenceStatus: 'collision_candidates',
          proposedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
      decisionRows: [
        {
          reviewScopeKey: 'cheval blanc::canonical::realworld_exact_vintage',
          benchmarkGoldHint: 'cheval blanc',
          decision: 'assign_target',
          entityId: 'wine-ce-cheval-blanc',
          reviewedBy: 'op',
          decisionReason: 'historical reviewed scope matches current family scope',
          reviewedAt: '2026-06-06T01:00:00.000Z',
        },
        {
          reviewScopeKey: 'cheval blanc::canonical::realworld_spaced_alias',
          benchmarkGoldHint: 'cheval blanc',
          decision: 'reject',
          reviewedBy: 'op',
          decisionReason: 'conflicting historical decision',
          reviewedAt: '2026-06-06T01:05:00.000Z',
        },
      ],
    })).toThrow(/conflicting manual-target family decisions collapse onto semanticScopeKey/);
  });

  it('fails closed on missing entity ids', () => {
    expect(() => applyLookupV2ManualTargetFamilyReviewDecisions({
      packetRows: [
        {
          semanticScopeKey: 'family::calon segur::::::::::bare::ko',
          scopeAxis: 'family',
          familyKey: 'calon segur',
          surfaceFormKind: 'bare',
          reviewScopeKey: 'family::calon segur::::::::::bare::ko',
          legacyReviewScopeKeys: ['calon segur::translation::realworld_korean_orthography'],
          benchmarkGoldHint: 'calon segur',
          normalizedBenchmarkGoldHint: 'calon segur',
          benchmarkGoldHintVariants: ['calon segur'],
          proposalStatus: 'needs_target_review',
          reviewTarget: 'lookup_manual_target_resolution_v1',
          scopeHoleClass: 'realworld_korean_orthography',
          scopeSuggestedAliasType: 'translation',
          locales: ['ko'],
          scopeRisk: 'family_only',
          surfaces: ['칼롱 세귀르'],
          holeClasses: ['realworld_korean_orthography'],
          suggestedAliasTypes: ['translation'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['coverage hole'],
          runtimeEvidenceStatus: 'candidate_unique_owner',
          proposedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
      decisionRows: [
        {
          reviewScopeKey: 'family::calon segur::::::::::bare::ko',
          benchmarkGoldHint: 'calon segur',
          decision: 'assign_target',
          reviewedBy: 'op',
          decisionReason: 'missing target',
          reviewedAt: '2026-06-06T01:00:00.000Z',
        },
      ],
    } as never)).toThrow(/missing entityId/);
  });
});
