import { describe, expect, it } from 'vitest';
import {
  buildLookupV2PolicyFamilySuggestions,
  buildLookupV2PolicyFamilySuggestedDecisionRows,
} from '../../../scripts/eval/export-lookup-v2-policy-family-suggestions.js';

describe('policy-family suggestions', () => {
  it('suggests keep-policy-conflict only for fail-closed broad conflicts', () => {
    const suggestions = buildLookupV2PolicyFamilySuggestions([
      {
        policyConflictSurface: '라뚜르',
        locale: 'ko',
        policyConflictType: 'short_form_collision',
        authorityStatus: 'resolved',
        stretchExpectedStatus: 'ambiguous',
        benchmarkGoldEntityId: 'wine-a',
        benchmarkGoldEntityIdSources: ['policy_registry_authority'],
        proposalStatus: 'needs_policy_review',
        reviewTarget: 'lookup_policy_conflict_registry_v1',
        benchmarkGoldHints: ['latour'],
        sampleSurfaces: ['라뚜르 2009'],
        holeClasses: ['realworld_exact_vintage'],
        suggestedAliasTypes: ['canonical'],
        rowCount: 1,
        sourceArtifacts: ['/tmp/a.json'],
        sourceEvidenceSamples: ['coverage hole'],
        proposedAt: '2026-06-06T00:00:00.000Z',
      },
      {
        policyConflictSurface: 'foo',
        locale: 'ko',
        policyConflictType: 'producer_family_collision',
        authorityStatus: 'resolved',
        stretchExpectedStatus: 'ambiguous',
        benchmarkGoldEntityId: 'wine-b',
        benchmarkGoldEntityIdSources: ['policy_registry_authority'],
        proposalStatus: 'needs_policy_review',
        reviewTarget: 'lookup_policy_conflict_registry_v1',
        benchmarkGoldHints: ['foo'],
        sampleSurfaces: ['foo reserve'],
        holeClasses: ['realworld_brand_suffix'],
        suggestedAliasTypes: ['canonical'],
        rowCount: 1,
        sourceArtifacts: ['/tmp/b.json'],
        sourceEvidenceSamples: ['coverage hole'],
        proposedAt: '2026-06-06T00:00:00.000Z',
      },
    ]);

    expect(suggestions).toEqual([
      {
        semanticConflictKey: 'foo',
        policyConflictSurface: 'foo',
        benchmarkGoldEntityId: 'wine-b',
        suggestionStatus: 'manual_review',
        rationale: 'requires manual policy review: type=producer_family_collision authority=resolved stretch=ambiguous',
      },
      {
        semanticConflictKey: '라뚜르',
        policyConflictSurface: '라뚜르',
        benchmarkGoldEntityId: 'wine-a',
        suggestionStatus: 'suggest_keep_ambiguous',
        rationale: 'fail-closed broad conflict: type=short_form_collision authority=resolved stretch=ambiguous',
      },
    ]);

    expect(buildLookupV2PolicyFamilySuggestedDecisionRows(suggestions)).toEqual([
      {
        semanticConflictKey: '라뚜르',
        policyConflictSurface: '라뚜르',
        benchmarkGoldEntityId: 'wine-a',
        decision: 'keep_ambiguous',
        reviewedBy: 'codex:suggested',
        decisionReason: 'fail-closed broad conflict: type=short_form_collision authority=resolved stretch=ambiguous',
        reviewedAt: expect.any(String),
      },
    ]);
  });
});
