import { describe, expect, it } from 'vitest';
import {
  assertLookupV2FamilyTargetRegistryRowsValid,
  buildLookupV2FamilyTargetApprovedMap,
  buildLookupV2FamilyTargetReviewScopeKey,
} from '../../../scripts/eval/lookup-v2-family-target-registry.js';

describe('lookup-v2-family-target-registry', () => {
  it('builds approved target map keyed by review scope', () => {
    const map = buildLookupV2FamilyTargetApprovedMap([
      {
        reviewScopeKey: 'petrus::translation::realworld_frenchish_korean_gap',
        benchmarkGoldHint: 'petrus',
        normalizedBenchmarkGoldHint: 'petrus',
        scopeHoleClass: 'realworld_frenchish_korean_gap',
        scopeSuggestedAliasType: 'translation',
        entityId: 'wine-ce-petrus',
        decisionStatus: 'approved',
        reviewedBy: 'codex',
        reviewedAt: '2026-06-06T00:00:00.000Z',
        decisionReason: 'fixture exact',
        evidenceClass: 'fixture_exact',
      },
      {
        reviewScopeKey: 'salon::canonical::realworld_exact_vintage',
        benchmarkGoldHint: 'salon',
        normalizedBenchmarkGoldHint: 'salon',
        scopeHoleClass: 'realworld_exact_vintage',
        scopeSuggestedAliasType: 'canonical',
        decisionStatus: 'rejected',
        reviewedBy: 'codex',
        reviewedAt: '2026-06-06T00:00:00.000Z',
        decisionReason: 'no safe single target',
        evidenceClass: 'manual_target_scope_review',
      },
    ]);

    expect(map.size).toBe(1);
    expect(map.get('petrus::translation::realworld_frenchish_korean_gap')?.entityId).toBe('wine-ce-petrus');
    expect(map.has('salon::canonical::realworld_exact_vintage')).toBe(false);
  });

  it('validates normalized hint, review scope, and known entity ids fail-closed', () => {
    expect(() => assertLookupV2FamilyTargetRegistryRowsValid({
      rows: [
        {
          reviewScopeKey: 'petrus::translation::realworld_frenchish_korean_gap',
          benchmarkGoldHint: 'petrus',
          normalizedBenchmarkGoldHint: 'petrus',
          scopeHoleClass: 'realworld_frenchish_korean_gap',
          scopeSuggestedAliasType: 'translation',
          entityId: 'wine-ce-a',
          decisionStatus: 'approved',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-06T00:00:00.000Z',
          decisionReason: 'a',
          evidenceClass: 'fixture_exact',
        },
        {
          reviewScopeKey: 'petrus::translation::realworld_frenchish_korean_gap',
          benchmarkGoldHint: 'Petrus',
          normalizedBenchmarkGoldHint: 'petrus',
          scopeHoleClass: 'realworld_frenchish_korean_gap',
          scopeSuggestedAliasType: 'translation',
          entityId: 'wine-ce-b',
          decisionStatus: 'approved',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-06T00:00:00.000Z',
          decisionReason: 'b',
          evidenceClass: 'fixture_exact',
        },
      ],
      knownEntityIds: new Set(['wine-ce-a', 'wine-ce-b']),
    })).toThrow(/duplicate reviewScopeKey/);

    expect(() => assertLookupV2FamilyTargetRegistryRowsValid({
      rows: [
        {
          reviewScopeKey: 'petrus::translation::realworld_frenchish_korean_gap',
          benchmarkGoldHint: 'petrus',
          normalizedBenchmarkGoldHint: 'petrus',
          scopeHoleClass: 'realworld_frenchish_korean_gap',
          scopeSuggestedAliasType: 'translation',
          entityId: 'wine-ce-missing',
          decisionStatus: 'approved',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-06T00:00:00.000Z',
          decisionReason: 'a',
          evidenceClass: 'fixture_exact',
        },
      ],
      knownEntityIds: new Set(['wine-ce-a']),
    })).toThrow(/unknown entityId/);

    expect(() => assertLookupV2FamilyTargetRegistryRowsValid({
      rows: [
        {
          reviewScopeKey: 'broken',
          benchmarkGoldHint: 'petrus',
          normalizedBenchmarkGoldHint: 'petrus',
          scopeHoleClass: 'realworld_frenchish_korean_gap',
          scopeSuggestedAliasType: 'translation',
          entityId: 'wine-ce-a',
          decisionStatus: 'approved',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-06T00:00:00.000Z',
          decisionReason: 'a',
          evidenceClass: 'fixture_exact',
        },
      ],
      knownEntityIds: new Set(['wine-ce-a']),
    })).toThrow(/reviewScopeKey mismatch/);
  });

  it('builds review scope keys deterministically', () => {
    expect(buildLookupV2FamilyTargetReviewScopeKey({
      benchmarkGoldHint: 'Calon Segur',
      holeClass: 'realworld_exact_vintage',
      suggestedAliasType: 'canonical',
    })).toBe('calon segur::canonical::realworld_exact_vintage');
  });
});
