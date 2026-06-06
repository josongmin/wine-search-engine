import { describe, expect, it } from 'vitest';
import {
  assertLookupV2ExactSafeScopeRegistryRowsValid,
  buildLookupV2ExactSafeScopeRegistryMap,
} from '../../../scripts/eval/lookup-v2-exact-safe-scope-registry.js';

describe('lookup-v2-exact-safe-scope-registry', () => {
  it('accepts reviewed exact-safe scope rows with valid deterministic scope keys', () => {
    const rows = [{
      reviewScopeKey: 'wine-a::canonical::realworld_brand_suffix',
      entityId: 'wine-a',
      scopeHoleClass: 'realworld_brand_suffix',
      scopeSuggestedAliasType: 'canonical',
      decisionStatus: 'rejected',
      reviewedBy: 'codex',
      reviewedAt: '2026-06-06T00:00:00.000Z',
      decisionReason: 'reject family-level exact-safe promotion',
      evidenceClass: 'exact_safe_family_review',
    }] as const;

    expect(() => assertLookupV2ExactSafeScopeRegistryRowsValid({
      rows,
      knownEntityIds: new Set(['wine-a']),
    })).not.toThrow();
    expect(buildLookupV2ExactSafeScopeRegistryMap(rows).get(rows[0].reviewScopeKey)).toEqual(rows[0]);
  });

  it('fails on duplicate reviewScopeKey or unknown entity', () => {
    const duplicateRows = [
      {
        reviewScopeKey: 'wine-a::canonical::realworld_brand_suffix',
        entityId: 'wine-a',
        scopeHoleClass: 'realworld_brand_suffix',
        scopeSuggestedAliasType: 'canonical',
        decisionStatus: 'approved',
        reviewedBy: 'codex',
        reviewedAt: '2026-06-06T00:00:00.000Z',
        decisionReason: 'approve',
        evidenceClass: 'exact_safe_family_review',
      },
      {
        reviewScopeKey: 'wine-a::canonical::realworld_brand_suffix',
        entityId: 'wine-a',
        scopeHoleClass: 'realworld_brand_suffix',
        scopeSuggestedAliasType: 'canonical',
        decisionStatus: 'rejected',
        reviewedBy: 'codex',
        reviewedAt: '2026-06-06T00:00:00.000Z',
        decisionReason: 'reject',
        evidenceClass: 'exact_safe_family_review',
      },
    ] as const;

    expect(() => assertLookupV2ExactSafeScopeRegistryRowsValid({
      rows: duplicateRows,
      knownEntityIds: new Set(['wine-a']),
    })).toThrow(/duplicate reviewScopeKey/);

    expect(() => assertLookupV2ExactSafeScopeRegistryRowsValid({
      rows: [{
        reviewScopeKey: 'wine-missing::canonical::realworld_brand_suffix',
        entityId: 'wine-missing',
        scopeHoleClass: 'realworld_brand_suffix',
        scopeSuggestedAliasType: 'canonical',
        decisionStatus: 'approved',
        reviewedBy: 'codex',
        reviewedAt: '2026-06-06T00:00:00.000Z',
        decisionReason: 'approve',
        evidenceClass: 'exact_safe_family_review',
      }],
      knownEntityIds: new Set(['wine-a']),
    })).toThrow(/unknown entityId/);
  });
});
