import { describe, expect, it } from 'vitest';
import { resolveAliasClaimsAndBuildAmbiguityRegistry } from '../../../scripts/etl/build-ambiguity-registry.js';
import type { AliasSnapshotRecord } from '../../../scripts/etl/search-snapshot-schema.js';

function alias(overrides: Partial<AliasSnapshotRecord> & Pick<AliasSnapshotRecord, 'aliasId' | 'entityId' | 'value' | 'normalizedValue'>): AliasSnapshotRecord {
  return {
    type: 'translation',
    scope: 'global',
    source: 'snapshot:test',
    confidencePrior: 0.9,
    ...overrides,
  };
}

describe('resolveAliasClaimsAndBuildAmbiguityRegistry', () => {
  it('auto-resolves high-authority canonical collisions and suppresses weaker claims', () => {
    const input: readonly AliasSnapshotRecord[] = [
      alias({
        aliasId: 'a1',
        entityId: 'wine-1',
        value: 'Opus One',
        normalizedValue: 'opus one',
        type: 'canonical',
        confidencePrior: 1.0,
        source: 'snapshot:canonical_label_v1',
      }),
      alias({
        aliasId: 'a2',
        entityId: 'wine-2',
        value: 'Opus One',
        normalizedValue: 'opus one',
        type: 'catalog_noise_alias',
        confidencePrior: 0.4,
        source: 'rule:short_name_v1',
      }),
    ];

    const result = resolveAliasClaimsAndBuildAmbiguityRegistry(input);

    expect(result.ambiguityRows).toHaveLength(0);
    expect(result.resolvedAliases).toHaveLength(1);
    expect(result.resolvedAliases[0]?.entityId).toBe('wine-1');
  });

  it('emits ambiguity rows for unresolved producer short-name collisions', () => {
    const input: readonly AliasSnapshotRecord[] = [
      alias({
        aliasId: 'a1',
        entityId: 'wine-1',
        value: 'Margaux',
        normalizedValue: 'margaux',
        type: 'catalog_noise_alias',
        confidencePrior: 0.4,
        source: 'rule:short_name_v1',
      }),
      alias({
        aliasId: 'a2',
        entityId: 'wine-2',
        value: 'Margaux',
        normalizedValue: 'margaux',
        type: 'catalog_noise_alias',
        confidencePrior: 0.4,
        source: 'rule:short_name_v1',
      }),
    ];

    const result = resolveAliasClaimsAndBuildAmbiguityRegistry(input);

    expect(result.resolvedAliases).toHaveLength(2);
    expect(result.ambiguityRows).toHaveLength(1);
    expect(result.ambiguityRows[0]).toMatchObject({
      normalizedForm: 'margaux',
      entityIds: ['wine-1', 'wine-2'],
      severity: 'medium',
    });
    expect(result.ambiguityRows[0]?.ambiguityTypes).toContain('producer_short_name_collision');
    expect(result.ambiguityRows[0]?.ambiguityTypes).toContain('surface_form_collision');
  });
});
