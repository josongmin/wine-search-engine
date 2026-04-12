import type { Pool } from 'pg';
import type { AliasRepository } from '../../domain/alias/port/alias-repository.port.js';
import type { Alias, AliasScope, AliasType } from '../../domain/alias/model/alias.js';
import { createCanonicalEntityId, type CanonicalEntityId } from '../../domain/shared/types/index.js';

function toAliasType(value: string): AliasType {
  if (
    value === 'canonical' ||
    value === 'translation' ||
    value === 'phonetic' ||
    value === 'misspelling' ||
    value === 'observed_query_alias' ||
    value === 'catalog_noise_alias'
  ) return value;
  return 'canonical';
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
  return 'global';
}

interface AliasRow {
  alias_id: string;
  entity_id: string;
  alias_type: string;
  alias_scope: string;
  surface_form: string;
  normalized_value: string;
  source: string;
  source_trust: number;
  confidence: number;
  is_suppressed: boolean;
  created_at: Date;
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

  async findByValue(value: string, scope?: AliasScope): Promise<readonly Alias[]> {
    let query: string;
    let params: unknown[];

    if (scope != null) {
      query = `SELECT * FROM aliases
               WHERE surface_form = $1 AND alias_scope = $2 AND is_suppressed = FALSE
               ORDER BY confidence DESC`;
      params = [value, scope];
    } else {
      query = `SELECT * FROM aliases
               WHERE surface_form = $1 AND is_suppressed = FALSE
               ORDER BY confidence DESC`;
      params = [value];
    }

    const result = await this.pool.query<AliasRow>(query, params);
    return result.rows.map(rowToAlias);
  }

  async findByEntity(entityId: CanonicalEntityId): Promise<readonly Alias[]> {
    const result = await this.pool.query<AliasRow>(
      `SELECT * FROM aliases WHERE entity_id = $1 ORDER BY confidence DESC`,
      [entityId],
    );
    return result.rows.map(rowToAlias);
  }

  async findByNormalizedValue(normalized: string): Promise<readonly Alias[]> {
    const result = await this.pool.query<AliasRow>(
      `SELECT * FROM aliases
       WHERE normalized_value = $1 AND is_suppressed = FALSE
       ORDER BY confidence DESC`,
      [normalized],
    );
    return result.rows.map(rowToAlias);
  }

  findFuzzyCandidates: AliasRepository['findFuzzyCandidates'] = async (
    normalized,
    scope,
  ) => {
    const prefixLength = Math.max(1, Math.ceil(normalized.length / 2));
    const prefix = normalized.slice(0, prefixLength);

    let query = `SELECT * FROM aliases
                 WHERE normalized_value LIKE $1 AND is_suppressed = FALSE`;
    const params: unknown[] = [`${prefix}%`];

    if (scope != null) {
      query += ' AND alias_scope = $2';
      params.push(scope);
    }

    query += ' ORDER BY confidence DESC LIMIT 50';

    const result = await this.pool.query<AliasRow>(query, params);
    return result.rows.map(rowToAlias);
  };

  async save(alias: Alias): Promise<void> {
    await this.pool.query(
      `INSERT INTO aliases (
        alias_id, entity_id, alias_type, alias_scope,
        surface_form, normalized_value, source, confidence, is_suppressed
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (alias_id) DO UPDATE SET
        entity_id = EXCLUDED.entity_id,
        alias_type = EXCLUDED.alias_type,
        alias_scope = EXCLUDED.alias_scope,
        surface_form = EXCLUDED.surface_form,
        normalized_value = EXCLUDED.normalized_value,
        source = EXCLUDED.source,
        confidence = EXCLUDED.confidence,
        is_suppressed = EXCLUDED.is_suppressed`,
      [
        alias.aliasId,
        alias.entityId,
        alias.type,
        alias.scope,
        alias.value,
        alias.normalizedValue,
        alias.source,
        alias.confidencePrior,
        alias.suppressed,
      ],
    );
  }

  async suppress(aliasId: string, _reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE aliases SET is_suppressed = TRUE WHERE alias_id = $1`,
      [aliasId],
    );
  }

  async bulkSave(aliases: readonly Alias[]): Promise<void> {
    if (aliases.length === 0) return;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const alias of aliases) {
        await client.query(
          `INSERT INTO aliases (
            alias_id, entity_id, alias_type, alias_scope,
            surface_form, normalized_value, source, confidence, is_suppressed
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (alias_id) DO UPDATE SET
            entity_id = EXCLUDED.entity_id,
            alias_type = EXCLUDED.alias_type,
            alias_scope = EXCLUDED.alias_scope,
            surface_form = EXCLUDED.surface_form,
            normalized_value = EXCLUDED.normalized_value,
            source = EXCLUDED.source,
            confidence = EXCLUDED.confidence,
            is_suppressed = EXCLUDED.is_suppressed`,
          [
            alias.aliasId,
            alias.entityId,
            alias.type,
            alias.scope,
            alias.value,
            alias.normalizedValue,
            alias.source,
            alias.confidencePrior,
            alias.suppressed,
          ],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
