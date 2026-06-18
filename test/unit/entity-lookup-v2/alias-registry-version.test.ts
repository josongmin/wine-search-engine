import { describe, expect, it } from 'vitest';
import {
  ALIAS_REGISTRY_V2_SCHEMA_VERSION,
  AliasRegistryVersionSchema,
  buildAliasRegistryVersion,
} from '../../../src/domain/alias/model/alias-registry-version.js';

/**
 * T-ELV2-03: the dedicated alias-registry version identity. Deterministic stamp,
 * omit-optional-keys (exactOptionalPropertyTypes), JSONB-safe via Zod.
 */
describe('buildAliasRegistryVersion', () => {
  it('stamps the literal schema version + truncates a non-int alias count', () => {
    const v = buildAliasRegistryVersion({ source: 'snapshot_manifest', aliasCount: 12.9, snapshotId: 's1', aliasContentHash: 'h1' });
    expect(v.schemaVersion).toBe(ALIAS_REGISTRY_V2_SCHEMA_VERSION);
    expect(v.aliasCount).toBe(12);
    expect(v.snapshotId).toBe('s1');
    expect(v.aliasContentHash).toBe('h1');
  });

  it('OMITS optional keys when absent (pg_overlay carries no content hash)', () => {
    const v = buildAliasRegistryVersion({ source: 'pg_overlay', aliasCount: 5, snapshotId: 's2' });
    expect('aliasContentHash' in v).toBe(false);
    const searchIndex = buildAliasRegistryVersion({ source: 'search_index', aliasCount: 0 });
    expect('snapshotId' in searchIndex).toBe(false);
    expect('aliasContentHash' in searchIndex).toBe(false);
  });

  it('clamps a negative count to 0', () => {
    expect(buildAliasRegistryVersion({ source: 'search_index', aliasCount: -3 }).aliasCount).toBe(0);
  });
});

describe('AliasRegistryVersionSchema (JSONB shape guard)', () => {
  it('round-trips a valid stamp', () => {
    const v = buildAliasRegistryVersion({ source: 'snapshot_manifest', aliasCount: 3, snapshotId: 's' });
    expect(AliasRegistryVersionSchema.safeParse(v).success).toBe(true);
  });

  it('rejects an unknown schema version, extra keys, and a negative/non-int count', () => {
    expect(AliasRegistryVersionSchema.safeParse({ schemaVersion: 'alias_registry.v1', source: 'pg_overlay', aliasCount: 1 }).success).toBe(false);
    expect(AliasRegistryVersionSchema.safeParse({ schemaVersion: ALIAS_REGISTRY_V2_SCHEMA_VERSION, source: 'pg_overlay', aliasCount: 1, extra: true }).success).toBe(false);
    expect(AliasRegistryVersionSchema.safeParse({ schemaVersion: ALIAS_REGISTRY_V2_SCHEMA_VERSION, source: 'pg_overlay', aliasCount: -1 }).success).toBe(false);
    expect(AliasRegistryVersionSchema.safeParse({ schemaVersion: ALIAS_REGISTRY_V2_SCHEMA_VERSION, source: 'bogus', aliasCount: 1 }).success).toBe(false);
  });
});
