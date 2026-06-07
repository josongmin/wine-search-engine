import { describe, it, expect } from 'vitest';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import {
  loadLookupV2LocalizedScopeSurfaceRegistrySync,
  buildLookupV2ApprovedScopeSurfaceMap,
  buildLookupV2ScopeSurfaceComponentKey,
} from '../../scripts/eval/lookup-v2-localized-scope-surface-registry.js';
import {
  loadLookupV2SemanticScopeSupportRegistrySync,
  LOOKUP_V2_SCOPE_SUPPORT_STATUSES,
} from '../../scripts/eval/lookup-v2-semantic-scope-support-registry.js';

/**
 * Hell-gate for the final-architecture L1 (Surface SoT) and L3 (Support SoT)
 * registries. Surfaces are component-scoped and recall-only; support is keyed
 * by semanticScopeKey (NOT family). See
 * [[project_elv2_scope_target_recall_only_runtime]]. Append-only.
 */
describe('entity-lookup-v2 surface + support registries (hell-gate)', () => {
  it('surface registry round-trips through its validator', () => {
    expect(() => loadLookupV2LocalizedScopeSurfaceRegistrySync()).not.toThrow();
  });

  it('every surface row is component-scoped, canonically normalized, and review-stamped', () => {
    const offenders: string[] = [];
    for (const row of loadLookupV2LocalizedScopeSurfaceRegistrySync()) {
      if (row.normalizedLocalSurface !== normalizeForMatch(row.localSurface)) {
        offenders.push(`${row.localSurface} normalized mismatch`);
      }
      if (row.evidenceClass !== 'localized_scope_surface_review') {
        offenders.push(`${row.localSurface} evidenceClass`);
      }
      if (!['family', 'line', 'region', 'appellation'].includes(row.componentKind)) {
        offenders.push(`${row.localSurface} componentKind=${row.componentKind}`);
      }
      // recall-only: no entityId / authority leak on a surface row
      if ('entityId' in (row as Record<string, unknown>)) {
        offenders.push(`${row.localSurface} leaks entityId`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('approved component-surface map groups by componentKind::componentKey::locale', () => {
    const rows = loadLookupV2LocalizedScopeSurfaceRegistrySync();
    const map = buildLookupV2ApprovedScopeSurfaceMap(rows);
    for (const row of rows) {
      if (row.decisionStatus !== 'approved') continue;
      const key = buildLookupV2ScopeSurfaceComponentKey(row);
      expect(map.get(key)?.has(row.normalizedLocalSurface)).toBe(true);
    }
  });

  it('support registry round-trips and is keyed by unique semanticScopeKey with valid status', () => {
    const rows = loadLookupV2SemanticScopeSupportRegistrySync();
    const keys = new Set<string>();
    for (const row of rows) {
      expect(LOOKUP_V2_SCOPE_SUPPORT_STATUSES).toContain(row.supportStatus);
      expect(row.evidenceClass).toBe('scope_support_review');
      expect(keys.has(row.semanticScopeKey)).toBe(false);
      keys.add(row.semanticScopeKey);
    }
  });
});
