import type { Pool, QueryResultRow } from 'pg';
import type { AmbiguityDictionary } from '../../domain/query/port/ambiguity-dictionary.port.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import { readPgSqlState } from '../db/pg-sqlstate.js';

export class PgAmbiguityDictionary implements AmbiguityDictionary {
  constructor(private readonly pool: Pool) {}

  async isKnownAmbiguous(surfaceForm: string): Promise<boolean> {
    const result = await this.queryAmbiguity(
      `SELECT EXISTS(
        SELECT 1 FROM ambiguity_registry WHERE normalized_form = $1
      ) AS exists`,
      [surfaceForm],
    );
    const row0 = result.rows[0];
    const existsRaw: unknown = row0 != null ? Reflect.get(row0, 'exists') : undefined;
    return existsRaw === true;
  }

  async getAmbiguityInfo(
    surfaceForm: string,
  ): Promise<{ types: string[]; severity: 'low' | 'medium' | 'high' } | null> {
    const result = await this.queryAmbiguity(
      `SELECT * FROM ambiguity_registry WHERE normalized_form = $1`,
      [surfaceForm],
    );
    const row = result.rows[0];
    if (row == null) return null;

    const typesRaw: unknown = Reflect.get(row, 'ambiguity_types');
    const severityRaw: unknown = Reflect.get(row, 'severity');
    if (!Array.isArray(typesRaw) || !typesRaw.every((t): t is string => typeof t === 'string')) {
      return null;
    }
    const severity =
      severityRaw === 'low' || severityRaw === 'medium' || severityRaw === 'high'
        ? severityRaw
        : 'low';
    return {
      types: typesRaw,
      severity,
    };
  }

  private async queryAmbiguity(
    sql: string,
    params: readonly unknown[],
  ): Promise<{ rows: QueryResultRow[] }> {
    try {
      return await this.pool.query(sql, [...params]);
    } catch (err: unknown) {
      const code = readPgSqlState(err);
      if (code !== '42P01') {
        throw err;
      }
      bootstrapLogger.info(
        '[PgAmbiguityDictionary] ambiguity_registry table does not exist yet — ambiguity lookup disabled for this request',
      );
      return { rows: [] };
    }
  }
}
