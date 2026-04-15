import { describe, expect, it } from 'vitest';
import type { Pool, QueryResult, QueryResultRow } from 'pg';
import { PgEntityRepository } from '../../../../src/infrastructure/adapter/pg-entity-repository.js';
import { PgAliasRepository } from '../../../../src/infrastructure/adapter/pg-alias-repository.js';
import { PgAliasMatcher } from '../../../../src/infrastructure/adapter/pg-alias-matcher.js';
import { createCanonicalEntityId } from '../../../../src/domain/shared/types/index.js';

/**
 * ADR-007 read-path seal: every read adapter MUST funnel `entity_id` through
 * `createCanonicalEntityId`, which throws on the source-record namespace
 * (`vivino-*`). If a corrupted/legacy row leaks through, every adapter must
 * fail loud rather than silently materialise a poisoned domain object.
 */

interface FakeRow extends QueryResultRow {
  readonly [key: string]: unknown;
}

function fakePoolReturning(rows: readonly FakeRow[]): Pool {
  const pointerRow = {
    active_snapshot_id: 'snap-active',
    previous_snapshot_id: null,
    content_hash: 'hash-active',
    promoted_at: new Date('2026-04-14T00:00:00Z'),
  };
  const result = {
    rows: [...rows],
    rowCount: rows.length,
    command: 'SELECT',
    oid: 0,
    fields: [],
  } satisfies QueryResult<FakeRow>;
  // Minimal Pool surface used by these adapters: just `query`.
  return {
    query: async (sql: string) => {
      if (sql.includes('FROM active_search_snapshot')) {
        return {
          rows: [pointerRow],
          rowCount: 1,
          command: 'SELECT',
          oid: 0,
          fields: [],
        } satisfies QueryResult<FakeRow>;
      }
      return result;
    },
  } as unknown as Pool;
}

const LEGACY_ENTITY_ROW: FakeRow = {
  entity_id: 'vivino-12345',
  entity_type: 'wine',
  canonical_label: 'Legacy Vivino Row',
  identity_signature: 'sig:legacy',
  relations: {},
  attributes: {},
  metadata: {},
  created_at: new Date('2025-01-01T00:00:00Z'),
  updated_at: new Date('2025-01-01T00:00:00Z'),
};

const LEGACY_ALIAS_ROW: FakeRow = {
  alias_id: 'alias-legacy-1',
  entity_id: 'vivino-12345',
  alias_type: 'canonical',
  alias_scope: 'global',
  surface_form: 'Legacy',
  normalized_value: 'legacy',
  source: 'seed',
  source_trust: 1,
  confidence: 0.9,
  is_suppressed: false,
  created_at: new Date('2025-01-01T00:00:00Z'),
};

describe('ADR-007 read-path namespace seal', () => {
  describe('PgEntityRepository', () => {
    it('findById rejects a legacy vivino- entity_id row', async () => {
      const repo = new PgEntityRepository(fakePoolReturning([LEGACY_ENTITY_ROW]));
      await expect(
        repo.findById(createCanonicalEntityId('opus-one-2018')),
      ).rejects.toThrow(/ADR-007/);
    });

    it('findBySignature rejects a legacy vivino- entity_id row', async () => {
      const repo = new PgEntityRepository(fakePoolReturning([LEGACY_ENTITY_ROW]));
      await expect(repo.findBySignature('sig:legacy')).rejects.toThrow(/ADR-007/);
    });

    it('findByType rejects when any returned row uses the source-record namespace', async () => {
      const repo = new PgEntityRepository(fakePoolReturning([LEGACY_ENTITY_ROW]));
      await expect(repo.findByType('wine')).rejects.toThrow(/ADR-007/);
    });
  });

  describe('PgAliasRepository', () => {
    it('findByValue rejects an alias whose entity_id is in the source-record namespace', async () => {
      const repo = new PgAliasRepository(fakePoolReturning([LEGACY_ALIAS_ROW]));
      await expect(repo.findByValue('Legacy')).rejects.toThrow(/ADR-007/);
    });

    it('findByEntity rejects a row whose stored entity_id is legacy', async () => {
      const repo = new PgAliasRepository(fakePoolReturning([LEGACY_ALIAS_ROW]));
      await expect(
        repo.findByEntity(createCanonicalEntityId('opus-one-2018')),
      ).rejects.toThrow(/ADR-007/);
    });

    it('findByNormalizedValue rejects a legacy alias row', async () => {
      const repo = new PgAliasRepository(fakePoolReturning([LEGACY_ALIAS_ROW]));
      await expect(repo.findByNormalizedValue('legacy')).rejects.toThrow(/ADR-007/);
    });
  });

  describe('PgAliasMatcher', () => {
    it('findMatches rejects when any matched alias row carries a legacy entity_id', async () => {
      const matcher = new PgAliasMatcher(fakePoolReturning([LEGACY_ALIAS_ROW]));
      await expect(matcher.findMatches('legacy')).rejects.toThrow(/ADR-007/);
    });
  });
});
