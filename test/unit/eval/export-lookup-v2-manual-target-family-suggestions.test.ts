import { describe, expect, it } from 'vitest';
import {
  buildLookupV2ManualTargetFamilySuggestions,
  buildLookupV2ManualTargetSuggestedDecisionRows,
} from '../../../scripts/eval/export-lookup-v2-manual-target-family-suggestions.js';

describe('manual-target family suggestions', () => {
  it('builds assign/collision/missing suggestions from runtime owner evidence', () => {
    const packetRows = [
      {
        benchmarkGoldHint: 'calon segur',
        normalizedBenchmarkGoldHint: 'calon segur',
        benchmarkGoldHintVariants: ['calon segur'],
        proposalStatus: 'needs_target_review',
        reviewTarget: 'lookup_manual_target_resolution_v1',
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
        benchmarkGoldHint: 'angelus',
        normalizedBenchmarkGoldHint: 'angelus',
        benchmarkGoldHintVariants: ['angelus'],
        proposalStatus: 'needs_target_review',
        reviewTarget: 'lookup_manual_target_resolution_v1',
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
        benchmarkGoldHint: 'salon',
        normalizedBenchmarkGoldHint: 'salon',
        benchmarkGoldHintVariants: ['salon'],
        proposalStatus: 'needs_target_review',
        reviewTarget: 'lookup_manual_target_resolution_v1',
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
    });

    expect(suggestions).toEqual([
      {
        benchmarkGoldHint: 'angelus',
        normalizedBenchmarkGoldHint: 'angelus',
        suggestionStatus: 'collision_candidates',
        candidateEntityIds: ['wine-b', 'wine-c'],
        candidateEntityLabels: ['Angelus 2012', 'Angelus 2015'],
        sourceEvidence: 'runtime_colliding_surface_owner',
      },
      {
        benchmarkGoldHint: 'calon segur',
        normalizedBenchmarkGoldHint: 'calon segur',
        suggestionStatus: 'candidate_unique_owner',
        recommendedEntityId: 'wine-a',
        recommendedEntityLabel: 'Calon Segur 2010',
        sourceEvidence: 'runtime_unique_surface_owner',
      },
      {
        benchmarkGoldHint: 'salon',
        normalizedBenchmarkGoldHint: 'salon',
        suggestionStatus: 'missing_runtime_owner',
        sourceEvidence: 'runtime_owner_missing',
      },
    ]);

    expect(buildLookupV2ManualTargetSuggestedDecisionRows(suggestions)).toEqual([]);
  });
});
