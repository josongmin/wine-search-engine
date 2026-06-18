import { describe, expect, it } from 'vitest';
import {
  buildLookupV2ExactSafeFamilySuggestions,
  buildLookupV2ExactSafeSuggestedDecisionRows,
} from '../../../scripts/eval/export-lookup-v2-exact-safe-family-suggestions.js';

describe('exact-safe family suggestions', () => {
  it('auto-approves only fixture-exact normalization-only families', () => {
    const suggestions = buildLookupV2ExactSafeFamilySuggestions([
      {
        reviewScopeKey: 'wine-a::canonical::realworld_compact_alias',
        entityId: 'wine-a',
        locale: 'ko',
        candidatePromotionClass: 'exact_safe',
        benchmarkGoldEntityIdSources: ['runtime_identity_safe_alias'],
        proposalStatus: 'needs_review',
        reviewTarget: 'lookup_exact_safe_registry_v1',
        scopeHoleClass: 'realworld_compact_alias',
        scopeSuggestedAliasType: 'canonical',
        surfaces: ['폴 로저 브뤼'],
        benchmarkGoldHints: ['pol roger'],
        rowCount: 1,
        sourceArtifacts: ['/tmp/a.json'],
        sourceEvidenceSamples: ['coverage hole'],
        proposedAt: '2026-06-06T00:00:00.000Z',
      },
      {
        reviewScopeKey: 'wine-b::canonical::realworld_compact_alias',
        entityId: 'wine-b',
        locale: 'ko',
        candidatePromotionClass: 'exact_safe',
        benchmarkGoldEntityIdSources: ['fixture_exact'],
        proposalStatus: 'needs_review',
        reviewTarget: 'lookup_exact_safe_registry_v1',
        scopeHoleClass: 'realworld_compact_alias',
        scopeSuggestedAliasType: 'canonical',
        surfaces: ['칼롱세귀르'],
        benchmarkGoldHints: ['calon segur'],
        rowCount: 1,
        sourceArtifacts: ['/tmp/b.json'],
        sourceEvidenceSamples: ['coverage hole'],
        proposedAt: '2026-06-06T00:00:00.000Z',
      },
    ]);

    expect(suggestions).toEqual([
      {
        reviewScopeKey: 'wine-a::canonical::realworld_compact_alias',
        entityId: 'wine-a',
        scopeHoleClass: 'realworld_compact_alias',
        scopeSuggestedAliasType: 'canonical',
        suggestionStatus: 'manual_review',
        rationale: 'requires manual review because source_strength=runtime_identity_safe_alias hole_class=realworld_compact_alias alias_type=canonical',
      },
      {
        reviewScopeKey: 'wine-b::canonical::realworld_compact_alias',
        entityId: 'wine-b',
        scopeHoleClass: 'realworld_compact_alias',
        scopeSuggestedAliasType: 'canonical',
        suggestionStatus: 'suggest_approve',
        rationale: 'promotion-safe exact-safe scope: sources=fixture_exact hole_class=realworld_compact_alias alias_type=canonical',
      },
    ]);

    expect(buildLookupV2ExactSafeSuggestedDecisionRows(suggestions)).toEqual([
      {
        reviewScopeKey: 'wine-b::canonical::realworld_compact_alias',
        decision: 'approve',
        reviewedBy: 'codex:suggested',
        decisionReason: 'promotion-safe exact-safe scope: sources=fixture_exact hole_class=realworld_compact_alias alias_type=canonical',
        reviewedAt: expect.any(String),
      },
    ]);
  });
});
