import { describe, expect, it } from 'vitest';
import {
  buildLookupV2ExactSafeFamilySuggestions,
  buildLookupV2ExactSafeSuggestedDecisionRows,
} from '../../../scripts/eval/export-lookup-v2-exact-safe-family-suggestions.js';

describe('exact-safe family suggestions', () => {
  it('auto-approves only fixture-exact normalization-only families', () => {
    const suggestions = buildLookupV2ExactSafeFamilySuggestions([
      {
        entityId: 'wine-a',
        locale: 'ko',
        candidatePromotionClass: 'exact_safe',
        benchmarkGoldEntityIdSources: ['runtime_identity_safe_alias'],
        proposalStatus: 'needs_review',
        reviewTarget: 'lookup_exact_safe_registry_v1',
        surfaces: ['폴 로저 브뤼'],
        benchmarkGoldHints: ['pol roger'],
        holeClasses: ['realworld_compact_alias'],
        suggestedAliasTypes: ['canonical'],
        rowCount: 1,
        sourceArtifacts: ['/tmp/a.json'],
        sourceEvidenceSamples: ['coverage hole'],
        proposedAt: '2026-06-06T00:00:00.000Z',
      },
      {
        entityId: 'wine-b',
        locale: 'ko',
        candidatePromotionClass: 'exact_safe',
        benchmarkGoldEntityIdSources: ['fixture_exact'],
        proposalStatus: 'needs_review',
        reviewTarget: 'lookup_exact_safe_registry_v1',
        surfaces: ['칼롱세귀르'],
        benchmarkGoldHints: ['calon segur'],
        holeClasses: ['realworld_compact_alias'],
        suggestedAliasTypes: ['canonical'],
        rowCount: 1,
        sourceArtifacts: ['/tmp/b.json'],
        sourceEvidenceSamples: ['coverage hole'],
        proposedAt: '2026-06-06T00:00:00.000Z',
      },
    ]);

    expect(suggestions).toEqual([
      {
        entityId: 'wine-a',
        suggestionStatus: 'manual_review',
        rationale: 'requires manual review because source_strength=runtime_identity_safe_alias hole_classes=realworld_compact_alias',
      },
      {
        entityId: 'wine-b',
        suggestionStatus: 'suggest_approve',
        rationale: 'promotion-safe exact-safe family: sources=fixture_exact hole_classes=realworld_compact_alias',
      },
    ]);

    expect(buildLookupV2ExactSafeSuggestedDecisionRows(suggestions)).toEqual([
      {
        entityId: 'wine-b',
        decision: 'approve',
        reviewedBy: 'codex:suggested',
        decisionReason: 'promotion-safe exact-safe family: sources=fixture_exact hole_classes=realworld_compact_alias',
        reviewedAt: expect.any(String),
      },
    ]);
  });
});
