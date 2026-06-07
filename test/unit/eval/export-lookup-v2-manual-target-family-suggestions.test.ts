import { describe, expect, it } from 'vitest';
import {
  buildLookupV2ManualTargetFamilySuggestions,
  buildLookupV2ManualTargetSuggestedDecisionRows,
} from '../../../scripts/eval/export-lookup-v2-manual-target-family-suggestions.js';

describe('manual-target family suggestions', () => {
  it('builds assign/collision/missing suggestions from runtime owner evidence', () => {
    const packetRows = [
      {
        reviewScopeKey: 'calon segur::translation::realworld_korean_orthography',
        benchmarkGoldHint: 'calon segur',
        normalizedBenchmarkGoldHint: 'calon segur',
        benchmarkGoldHintVariants: ['calon segur'],
        proposalStatus: 'needs_target_review',
        reviewTarget: 'lookup_manual_target_resolution_v1',
        scopeHoleClass: 'realworld_korean_orthography',
        scopeSuggestedAliasType: 'translation',
        scopeRisk: 'family_only',
        locales: ['ko'],
        surfaces: ['칼롱 세귀르'],
        holeClasses: ['realworld_korean_orthography'],
        suggestedAliasTypes: ['translation'],
        rowCount: 1,
        sourceArtifacts: ['/tmp/a.json'],
        sourceEvidenceSamples: ['coverage hole'],
        runtimeEvidenceStatus: 'candidate_unique_owner',
        runtimeEvidenceEntityId: 'wine-a',
        runtimeEvidenceEntityLabel: 'Calon Segur 2010',
        runtimeEvidenceWitnesses: [
          {
            entityId: 'wine-a',
            witnessSurface: 'Calon Segur 2010',
            witnessSource: 'canonical_label',
          },
        ],
        proposedAt: '2026-06-06T00:00:00.000Z',
      },
      {
        reviewScopeKey: 'angelus::translation::realworld_korean_orthography',
        benchmarkGoldHint: 'angelus',
        normalizedBenchmarkGoldHint: 'angelus',
        benchmarkGoldHintVariants: ['angelus'],
        proposalStatus: 'needs_target_review',
        reviewTarget: 'lookup_manual_target_resolution_v1',
        scopeHoleClass: 'realworld_korean_orthography',
        scopeSuggestedAliasType: 'translation',
        scopeRisk: 'family_only',
        locales: ['ko'],
        surfaces: ['앙젤루스'],
        holeClasses: ['realworld_korean_orthography'],
        suggestedAliasTypes: ['translation'],
        rowCount: 1,
        sourceArtifacts: ['/tmp/b.json'],
        sourceEvidenceSamples: ['coverage hole'],
        runtimeEvidenceStatus: 'collision_candidates',
        runtimeCollisionEntityIds: ['wine-b', 'wine-c'],
        runtimeCollisionEntityLabels: ['Angelus 2012', 'Angelus 2015'],
        runtimeCollisionWitnesses: [
          {
            entityId: 'wine-b',
            witnessSurface: 'Angelus',
            witnessSource: 'aliases_noisy_recall',
          },
          {
            entityId: 'wine-c',
            witnessSurface: 'Angelus',
            witnessSource: 'aliases_noisy_recall',
          },
        ],
        proposedAt: '2026-06-06T00:00:00.000Z',
      },
      {
        reviewScopeKey: 'salon::canonical::realworld_exact_vintage',
        benchmarkGoldHint: 'salon',
        normalizedBenchmarkGoldHint: 'salon',
        benchmarkGoldHintVariants: ['salon'],
        proposalStatus: 'needs_target_review',
        reviewTarget: 'lookup_manual_target_resolution_v1',
        scopeHoleClass: 'realworld_exact_vintage',
        scopeSuggestedAliasType: 'canonical',
        scopeRisk: 'mixed_vintage_family',
        locales: ['ko'],
        surfaces: ['살롱 2012'],
        holeClasses: ['realworld_exact_vintage'],
        suggestedAliasTypes: ['canonical'],
        rowCount: 1,
        sourceArtifacts: ['/tmp/c.json'],
        sourceEvidenceSamples: ['coverage hole'],
        runtimeEvidenceStatus: 'missing_runtime_owner',
        proposedAt: '2026-06-06T00:00:00.000Z',
      },
    ] as const;

    const suggestions = buildLookupV2ManualTargetFamilySuggestions(packetRows);

    expect(suggestions).toEqual([
      {
        reviewScopeKey: 'angelus::translation::realworld_korean_orthography',
        benchmarkGoldHint: 'angelus',
        normalizedBenchmarkGoldHint: 'angelus',
        scopeHoleClass: 'realworld_korean_orthography',
        scopeSuggestedAliasType: 'translation',
        scopeRisk: 'family_only',
        suggestionStatus: 'collision_candidates',
        candidateEntityIds: ['wine-b', 'wine-c'],
        candidateEntityLabels: ['Angelus 2012', 'Angelus 2015'],
        candidateWitnesses: [
          {
            entityId: 'wine-b',
            witnessSurface: 'Angelus',
            witnessSource: 'aliases_noisy_recall',
          },
          {
            entityId: 'wine-c',
            witnessSurface: 'Angelus',
            witnessSource: 'aliases_noisy_recall',
          },
        ],
        sourceEvidence: 'runtime_colliding_surface_owner',
      },
      {
        reviewScopeKey: 'calon segur::translation::realworld_korean_orthography',
        benchmarkGoldHint: 'calon segur',
        normalizedBenchmarkGoldHint: 'calon segur',
        scopeHoleClass: 'realworld_korean_orthography',
        scopeSuggestedAliasType: 'translation',
        scopeRisk: 'family_only',
        suggestionStatus: 'candidate_unique_owner',
        recommendedEntityId: 'wine-a',
        recommendedEntityLabel: 'Calon Segur 2010',
        recommendedWitnesses: [
          {
            entityId: 'wine-a',
            witnessSurface: 'Calon Segur 2010',
            witnessSource: 'canonical_label',
          },
        ],
        sourceEvidence: 'runtime_unique_surface_owner',
      },
      {
        reviewScopeKey: 'salon::canonical::realworld_exact_vintage',
        benchmarkGoldHint: 'salon',
        normalizedBenchmarkGoldHint: 'salon',
        scopeHoleClass: 'realworld_exact_vintage',
        scopeSuggestedAliasType: 'canonical',
        scopeRisk: 'mixed_vintage_family',
        suggestionStatus: 'missing_runtime_owner',
        sourceEvidence: 'runtime_owner_missing',
      },
    ]);

    expect(buildLookupV2ManualTargetSuggestedDecisionRows(suggestions)).toEqual([]);
  });
});
