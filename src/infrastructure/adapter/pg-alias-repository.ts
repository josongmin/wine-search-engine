import type { Pool } from 'pg';
import type { AliasRepository } from '../../domain/alias/port/alias-repository.port.js';
import type { Alias, AliasScope, AliasType } from '../../domain/alias/model/alias.js';
import { createCanonicalEntityId, type CanonicalEntityId } from '../../domain/shared/types/index.js';
import { resolveActiveSnapshot } from '../db/active-snapshot-resolver.js';
import { runAbortablePgQuery } from '../db/abortable-pg-query.js';

function toAliasType(value: string): AliasType {
  if (
    value === 'canonical' ||
    value === 'translation' ||
    value === 'phonetic' ||
    value === 'misspelling' ||
    value === 'observed_query_alias' ||
    value === 'catalog_noise_alias' ||
    value === 'derived_initialism' ||
    value === 'abbreviation'
  ) return value;
  throw new Error(`PgAliasRepository: unknown alias_type "${value}" — schema drift or corrupted row`);
}

function toAliasScope(value: string): AliasScope {
  if (
    value === 'global' ||
    value === 'locale_ko' ||
    value === 'locale_en' ||
    value === 'locale_fr' ||
    value === 'marketplace_specific' ||
    value === 'retailer_specific' ||
    value === 'temporal'
  ) return value;
  throw new Error(`PgAliasRepository: unknown alias_scope "${value}" — schema drift or corrupted row`);
}

/**
 * Row shape returned by a wildcard read from the aliases table. Exported so
 * regression tests can assert `search_snapshot_id` is declared — mandatory for
 * any snapshot-scoped query to type-check against the composite-PK table.
 */
export interface AliasRow {
  readonly alias_id: string;
  readonly search_snapshot_id: string;
  readonly entity_id: string;
  readonly alias_type: string;
  readonly alias_scope: string;
  readonly surface_form: string;
  readonly normalized_value: string;
  readonly source: string;
  readonly source_trust: number;
  readonly confidence: number;
  readonly is_suppressed: boolean;
  readonly created_at: Date;
}

function rowToAlias(row: AliasRow): Alias {
  return {
    aliasId: row.alias_id,
    entityId: createCanonicalEntityId(row.entity_id),
    value: row.surface_form,
    normalizedValue: row.normalized_value,
    type: toAliasType(row.alias_type),
    confidencePrior: row.confidence,
    source: row.source,
    scope: toAliasScope(row.alias_scope),
    suppressed: row.is_suppressed,
  };
}

export class PgAliasRepository implements AliasRepository {
  constructor(private readonly pool: Pool) {}

  async findByValue(
    value: string,
    scope?: AliasScope,
    signal?: AbortSignal,
  ): Promise<readonly Alias[]> {
    const { activeSnapshotId } = await resolveActiveSnapshot(this.pool);
    let query: string;
    let params: unknown[];

    if (scope != null) {
      query = `SELECT * FROM aliases
               WHERE surface_form = $1 AND alias_scope = $2 AND search_snapshot_id = $3 AND is_suppressed = FALSE
               ORDER BY confidence DESC`;
      params = [value, scope, activeSnapshotId];
    } else {
      query = `SELECT * FROM aliases
               WHERE surface_form = $1 AND search_snapshot_id = $2 AND is_suppressed = FALSE
               ORDER BY confidence DESC`;
      params = [value, activeSnapshotId];
    }

    const result = await runAbortablePgQuery<AliasRow>(this.pool, signal, query, params);
    return result.rows.map(rowToAlias);
  }

  async findByEntity(
    entityId: CanonicalEntityId,
    signal?: AbortSignal,
  ): Promise<readonly Alias[]> {
    const { activeSnapshotId } = await resolveActiveSnapshot(this.pool);
    const result = await runAbortablePgQuery<AliasRow>(
      this.pool,
      signal,
      `SELECT * FROM aliases WHERE entity_id = $1 AND search_snapshot_id = $2 ORDER BY confidence DESC`,
      [entityId, activeSnapshotId],
    );
    return result.rows.map(rowToAlias);
  }

  async findByNormalizedValue(
    normalized: string,
    signal?: AbortSignal,
  ): Promise<readonly Alias[]> {
    const { activeSnapshotId } = await resolveActiveSnapshot(this.pool);
    const result = await runAbortablePgQuery<AliasRow>(
      this.pool,
      signal,
      `SELECT * FROM aliases
       WHERE normalized_value = $1 AND search_snapshot_id = $2 AND is_suppressed = FALSE
       ORDER BY confidence DESC`,
      [normalized, activeSnapshotId],
    );
    return result.rows.map(rowToAlias);
  }

  findFuzzyCandidates: AliasRepository['findFuzzyCandidates'] = async (
    normalized,
    scope,
    signal,
  ) => {
    const prefixLength = Math.max(1, Math.ceil(normalized.length / 2));
    const prefix = normalized.slice(0, prefixLength);
    const { activeSnapshotId } = await resolveActiveSnapshot(this.pool);

    let query = `SELECT * FROM aliases
                 WHERE normalized_value LIKE $1 AND search_snapshot_id = $2 AND is_suppressed = FALSE`;
    const params: unknown[] = [`${prefix}%`, activeSnapshotId];

    if (scope != null) {
      query += ' AND alias_scope = $3';
      params.push(scope);
    }

    query += ' ORDER BY confidence DESC LIMIT 50';

    const result = await runAbortablePgQuery<AliasRow>(this.pool, signal, query, params);
    return result.rows.map(rowToAlias);
  };
}
