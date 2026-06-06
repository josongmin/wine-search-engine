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
        proposedAt: '2026-06-06T00:00:00.000Z',
      },
    ] as const;

    const suggestions = buildLookupV2ManualTargetFamilySuggestions(packetRows, {
      uniqueOwners: new Map([['calon segur', 'wine-a']]),
      collidingOwners: new Map([['angelus', ['wine-b', 'wine-c']]]),
      entityLabels: new Map([
        ['wine-a', 'Calon Segur 2010'],
        ['wine-b', 'Angelus 2012'],
        ['wine-c', 'Angelus 2015'],
      ]),
      entityProducers: new Map([
        ['wine-a', 'Chateau Calon-Segur'],
        ['wine-b', 'Chateau Angelus'],
        ['wine-c', 'Chateau Angelus'],
      ]),
      entityRegions: new Map([
        ['wine-a', 'France'],
        ['wine-b', 'France'],
        ['wine-c', 'France'],
      ]),
      entityAppellations: new Map([
        ['wine-a', 'Saint-Estephe'],
        ['wine-b', 'Saint-Emilion'],
        ['wine-c', 'Saint-Emilion'],
      ]),
      uniqueOwnerWitnesses: new Map([
        ['calon segur', [
          {
            entityId: 'wine-a',
            witnessSurface: 'Calon Segur 2010',
            witnessSource: 'canonical_label',
          },
        ]],
      ]),
      collidingOwnerWitnesses: new Map([
        ['angelus', [
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
        ]],
      ]),
    });

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
