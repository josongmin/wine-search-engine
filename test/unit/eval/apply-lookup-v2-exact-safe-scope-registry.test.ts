import { describe, expect, it } from 'vitest';
import { applyLookupV2ExactSafeScopeRegistry } from '../../../scripts/eval/apply-lookup-v2-exact-safe-scope-registry.js';

describe('applyLookupV2ExactSafeScopeRegistry', () => {
  it('appends reviewed exact-safe family decisions into registry rows and skips pending rows', () => {
    const result = applyLookupV2ExactSafeScopeRegistry({
      familyRows: [
        {
          reviewScopeKey: 'wine-a::canonical::realworld_brand_suffix',
          entityId: 'wine-a',
          locale: 'ko',
          candidatePromotionClass: 'exact_safe',
          benchmarkGoldEntityIdSources: ['family_target_registry'],
          proposalStatus: 'approved',
          reviewTarget: 'lookup_exact_safe_registry_v1',
          scopeHoleClass: 'realworld_brand_suffix',
          scopeSuggestedAliasType: 'canonical',
          surfaces: ['와인 A'],
          benchmarkGoldHints: ['wine a'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['coverage hole'],
          proposedAt: '2026-06-06T00:00:00.000Z',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-06T01:00:00.000Z',
          decisionReason: 'approve exact-safe scope',
        },
        {
          reviewScopeKey: 'wine-b::translation::realworld_korean_orthography',
          entityId: 'wine-b',
          locale: 'ko',
          candidatePromotionClass: 'exact_safe',
          benchmarkGoldEntityIdSources: ['family_target_registry'],
          proposalStatus: 'needs_review',
          reviewTarget: 'lookup_exact_safe_registry_v1',
          scopeHoleClass: 'realworld_korean_orthography',
          scopeSuggestedAliasType: 'translation',
          surfaces: ['와인 비'],
          benchmarkGoldHints: ['wine b'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/b.json'],
          sourceEvidenceSamples: ['coverage hole'],
          proposedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
      existingRegistryRows: [],
      knownEntityIds: new Set(['wine-a', 'wine-b']),
    });

    expect(result.pendingRows).toBe(1);
    expect(result.approvedRows).toBe(1);
    expect(result.rejectedRows).toBe(0);
    expect(result.registryInsertedRows).toBe(1);
    expect(result.registryConflictRows).toBe(0);
    expect(result.mergedRows).toEqual([
      expect.objectContaining({
        reviewScopeKey: 'wine-a::canonical::realworld_brand_suffix',
        entityId: 'wine-a',
        decisionStatus: 'approved',
      }),
    ]);
  });
});
