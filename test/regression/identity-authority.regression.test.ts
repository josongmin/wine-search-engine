/**
 * T-011/W3: identity/public-id authority regression.
 *
 * Contract:
 *  - WineSnapshotEntityResolution documents entityId/runtimePublicIdAuthority
 *    as immutable runtime authority, benchmarkEntityId/benchmarkLinkageAuthority
 *    as mutable linkage authority.
 *  - assertSourceLinkRemapBlocked refuses to let publish silently remap a
 *    pre-existing (source_system, source_record_id) → canonical_entity_id link.
 *  - canonical sync UPSERT omits canonical_entity_id from the SET list.
 *  - migration 011 SQL carries the documented constraints & indexes.
 *  - runtime coverage verifier performs identity-signature parity.
 */
import { describe, expect, it, vi } from 'vitest';
import { assertSourceLinkRemapBlocked } from '../../scripts/etl/canonical-entity-graph-sync.js';

describe('T-011/W3 WineSnapshotEntityResolution doc boundary', () => {
  it('snapshot-entity-identity file documents two-authority model', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../scripts/etl/snapshot-entity-identity.ts', import.meta.url)),
      'utf-8',
    );
    expect(src).toMatch(/runtime public-id authority/);
    expect(src).toMatch(/benchmark linkage authority/);
    expect(src).toMatch(/Runtime public id \(immutable authority\)/);
    expect(src).toMatch(/Benchmark\/gold linkage id/);
    expect(src).toMatch(/runtimePublicIdAuthority/);
    expect(src).toMatch(/benchmarkLinkageAuthority/);
  });
});

describe('T-011/W3 assertSourceLinkRemapBlocked', () => {
  it('is a no-op for empty link rows', async () => {
    const client = { query: vi.fn() };
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock
    await expect(assertSourceLinkRemapBlocked(client as never, [])).resolves.toBeUndefined();
    expect(client.query).not.toHaveBeenCalled();
  });

  it('passes when existing link points to the same canonical_entity_id', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          source_system: 'sys-a',
          source_record_id: 'rec-1',
          canonical_entity_ids: ['cid-same'],
        }],
      }),
    };
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock
    await expect(assertSourceLinkRemapBlocked(client as never, [{
      canonical_entity_id: 'cid-same',
      source_system: 'sys-a',
      source_record_id: 'rec-1',
    }])).resolves.toBeUndefined();
  });

  it('passes when no existing link matches (first publish)', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock
    await expect(assertSourceLinkRemapBlocked(client as never, [{
      canonical_entity_id: 'cid-new',
      source_system: 'sys-a',
      source_record_id: 'rec-1',
    }])).resolves.toBeUndefined();
  });

  it('throws when an existing link maps to a different canonical_entity_id', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          source_system: 'sys-a',
          source_record_id: 'rec-1',
          canonical_entity_ids: ['cid-existing'],
        }],
      }),
    };
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock
    await expect(assertSourceLinkRemapBlocked(client as never, [{
      canonical_entity_id: 'cid-DIFFERENT',
      source_system: 'sys-a',
      source_record_id: 'rec-1',
    }])).rejects.toThrow(/refusing to remap/);
  });

  it('surfaces both old and new canonical ids in the error message', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          source_system: 'sys-a',
          source_record_id: 'rec-1',
          canonical_entity_ids: ['cid-OLD'],
        }],
      }),
    };
    try {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock
      await assertSourceLinkRemapBlocked(client as never, [{
        canonical_entity_id: 'cid-NEW',
        source_system: 'sys-a',
        source_record_id: 'rec-1',
      }]);
      expect.fail('expected throw');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toContain('cid-OLD');
      expect(msg).toContain('cid-NEW');
      expect(msg).toContain('sys-a');
      expect(msg).toContain('rec-1');
    }
  });

  it('throws when a source link exists in multiple snapshots with different canonical ids', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          source_system: 'sys-a',
          source_record_id: 'rec-1',
          canonical_entity_ids: ['cid-OLD', 'cid-NEW'],
        }],
      }),
    };
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock
    await expect(assertSourceLinkRemapBlocked(client as never, [{
      canonical_entity_id: 'cid-NEW',
      source_system: 'sys-a',
      source_record_id: 'rec-1',
    }])).rejects.toThrow(/multiple canonical_entity_id values across snapshots/);
  });
});

describe('T-011/W3 canonical sync UPSERT contract', () => {
  it('canonical_entity_id is NOT in entity_source_links DO UPDATE SET', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../scripts/etl/canonical-entity-graph-sync.ts', import.meta.url)),
      'utf-8',
    );
    // Locate the entity_source_links insert block
    const insertIdx = src.indexOf('INSERT INTO entity_source_links');
    expect(insertIdx).toBeGreaterThan(0);
    const afterInsert = src.slice(insertIdx, insertIdx + 1500);
    const onConflictIdx = afterInsert.indexOf('ON CONFLICT');
    expect(onConflictIdx).toBeGreaterThan(0);
    const onConflictBlock = afterInsert.slice(onConflictIdx, afterInsert.indexOf('`', onConflictIdx));
    // Ensure canonical_entity_id is NOT re-assigned from EXCLUDED (remap blocked).
    expect(onConflictBlock).not.toMatch(/canonical_entity_id = EXCLUDED\.canonical_entity_id/);
  });
});

describe('T-011/W3 migration 011 contract', () => {
  it('migration creates identity_signature unique index on entities', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../src/infrastructure/db/migrations/011_identity_authority_constraints.sql', import.meta.url)),
      'utf-8',
    );
    expect(src).toMatch(/uq_entities_identity_signature/);
    expect(src).toMatch(/CREATE UNIQUE INDEX uq_entities_identity_signature/);
    expect(src).toMatch(/WHERE length\(identity_signature\) > 0/);
  });

  it('migration creates entity_source_link_remap_audit append-only table', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../src/infrastructure/db/migrations/011_identity_authority_constraints.sql', import.meta.url)),
      'utf-8',
    );
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS entity_source_link_remap_audit/);
    expect(src).toMatch(/from_canonical_id/);
    expect(src).toMatch(/to_canonical_id/);
    expect(src).toMatch(/operator/);
  });

  it('migration creates reverse-lookup index on entity_source_links', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../src/infrastructure/db/migrations/011_identity_authority_constraints.sql', import.meta.url)),
      'utf-8',
    );
    expect(src).toMatch(/idx_entity_source_links_canonical/);
  });
});

describe('T-014 canonical identity authority migration contract', () => {
  it('creates canonical_identity_authority with global 1:1 constraints', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../src/infrastructure/db/migrations/014_canonical_identity_authority.sql', import.meta.url)),
      'utf-8',
    );
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS canonical_identity_authority/);
    expect(src).toMatch(/identity_signature TEXT PRIMARY KEY/);
    expect(src).toMatch(/canonical_entity_id TEXT NOT NULL UNIQUE/);
    expect(src).toMatch(/conflicting canonical_entity_id values for the same identity_signature/);
    expect(src).toMatch(/conflicting identity_signature values for the same canonical_entity_id/);
  });
});

describe('T-011/W3 runtime coverage — identity parity', () => {
  it('verify-runtime-gold-catalog-coverage performs identity_signature parity check', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../scripts/etl/verify-runtime-gold-catalog-coverage.ts', import.meta.url)),
      'utf-8',
    );
    expect(src).toMatch(/runtimePublicIdMatches/);
    expect(src).toMatch(/runtimeBenchmarkLinkageMatches/);
    expect(src).toMatch(/canonicalBenchmarkLinkageMatches/);
    expect(src).toMatch(/Identity authority drift/);
    expect(src).toMatch(/canonical_identity_authority/);
    expect(src).toMatch(/row\.runtime_signature !== row\.authority_signature/);
    expect(src).toMatch(/row\.entity_id !== row\.authority_entity_id/);
    expect(src).toMatch(/Benchmark linkage drift/);
    expect(src).toMatch(/runtime benchmarkEntityId=/);
    // Benchmark linkage still joins entities to canonical_entities on snapshot + entity_id.
    expect(src).toMatch(/LEFT JOIN canonical_entities ce/);
    expect(src).toMatch(/ce\.search_snapshot_id = e\.search_snapshot_id/);
    expect(src).toMatch(/ce\.canonical_entity_id = e\.entity_id/);
  });
});
