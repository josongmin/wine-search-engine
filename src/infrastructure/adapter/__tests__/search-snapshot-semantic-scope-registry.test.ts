import { describe, it, expect } from 'vitest';
import { SearchSnapshotSemanticScopeRegistry } from '../search-snapshot-semantic-scope-registry.js';
import type { LookupSemanticScopeRuntimeEntry } from '../../../domain/shared/types/search-snapshot-lookup-semantic-runtime.js';
import { buildNormalizedQueryViews } from '../../../domain/query/service/query-normalizer.js';

/**
 * Locks the reviewed-anchor seam the entity-lookup-v2 collision resolver relies
 * on: getReviewedTargetEntityIds must expose EVERY runtime scope entry's
 * entityId (the runtime artifact only ever contains reviewed APPROVED targets,
 * so the whole set is authority). Without this, the resolver cannot break a
 * reviewed family collision to the grand-vin anchor by candidate identity.
 * See [[project_elv2_scope_target_recall_only_runtime]].
 */
const entry = (
  semanticScopeKey: string,
  familyKey: string,
  entityId: string,
  surfaceFormKind: LookupSemanticScopeRuntimeEntry['surfaceFormKind'],
): LookupSemanticScopeRuntimeEntry => ({
  semanticScopeKey,
  scopeAxis: 'family',
  familyKey,
  surfaceFormKind,
  locale: 'ko',
  entityId,
});

describe('SearchSnapshotSemanticScopeRegistry reviewed-anchor seam', () => {
  const entries: readonly LookupSemanticScopeRuntimeEntry[] = [
    entry('family::angelus::::::::::bare::ko', 'angelus', 'wine-ce-angelus-grand-vin', 'bare'),
    entry('family::angelus::::::::::compact::ko', 'angelus', 'wine-ce-angelus-grand-vin', 'compact'),
    entry('family::palmer::::::::::bare::ko', 'palmer', 'wine-ce-palmer-grand-vin', 'bare'),
  ];
  const registry = new SearchSnapshotSemanticScopeRegistry(entries);

  it('exposes every entry entityId as a reviewed anchor (de-duplicated)', () => {
    const anchors = registry.getReviewedTargetEntityIds();
    expect([...anchors].sort()).toEqual(['wine-ce-angelus-grand-vin', 'wine-ce-palmer-grand-vin']);
  });

  it('returns a stable, snapshot-independent set instance', () => {
    expect(registry.getReviewedTargetEntityIds()).toBe(registry.getReviewedTargetEntityIds());
  });

  it('empty registry yields an empty anchor set (resolver abstains)', () => {
    expect(new SearchSnapshotSemanticScopeRegistry([]).getReviewedTargetEntityIds().size).toBe(0);
  });

  it('findMatches still returns the latin-token scope match (recall seam intact)', () => {
    const matches = registry.findMatches({
      query: 'chateau angelus',
      views: buildNormalizedQueryViews('chateau angelus'),
      locale: 'ko',
    });
    expect(matches.some((m) => m.entityId === 'wine-ce-angelus-grand-vin')).toBe(true);
  });

  describe('reviewed component-surface index (final architecture L1)', () => {
    // family::angelus::ko reviewed surfaces — note NONE contain the latin token
    // "angelus"; matching MUST come from the surface index, not latin literal.
    const componentSurfaces = new Map<string, ReadonlySet<string>>([
      ['family::angelus::ko', new Set(['샤또 앙젤뤼스', '앙젤루스'])],
    ]);
    const withSurfaces = new SearchSnapshotSemanticScopeRegistry(entries, componentSurfaces);

    it('STRUCTURE PROOF: Korean producer surface matches the family scope via surface index (no latin, no family recall)', () => {
      const matches = withSurfaces.findMatches({
        query: '샤또 앙젤뤼스',
        views: buildNormalizedQueryViews('샤또 앙젤뤼스'),
        locale: 'ko',
      });
      expect(matches.some((m) => m.entityId === 'wine-ce-angelus-grand-vin')).toBe(true);
    });

    it('without the surface index the same Korean query does NOT match (proves the index is what closes it)', () => {
      const matches = registry.findMatches({
        query: '샤또 앙젤뤼스',
        views: buildNormalizedQueryViews('샤또 앙젤뤼스'),
        locale: 'ko',
      });
      expect(matches).toEqual([]);
    });

    it('a Korean surface NOT in the reviewed index stays unmatched (no fuzzy leak)', () => {
      const matches = withSurfaces.findMatches({
        query: '랜덤 와인 이름',
        views: buildNormalizedQueryViews('랜덤 와인 이름'),
        locale: 'ko',
      });
      expect(matches).toEqual([]);
    });
  });
});
