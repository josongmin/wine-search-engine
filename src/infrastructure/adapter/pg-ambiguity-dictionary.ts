import type { Pool } from 'pg';
import type { AmbiguityDictionary } from '../../domain/query/port/ambiguity-dictionary.port.js';

interface AmbiguityRow {
  registry_id: string;
  normalized_form: string;
  entity_ids: string[];
  ambiguity_types: string[];
  severity: string;
  created_at: Date;
  updated_at: Date;
}

export class PgAmbiguityDictionary implements AmbiguityDictionary {
  constructor(private readonly pool: Pool) {}

  async isKnownAmbiguous(surfaceForm: string): Promise<boolean> {
    const result = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS(
        SELECT 1 FROM ambiguity_registry WHERE normalized_form = $1
      ) AS exists`,
      [surfaceForm],
    );
    return result.rows[0]?.exists ?? false;
  }

  async getAmbiguityInfo(
    surfaceForm: string,
  ): Promise<{ types: string[]; severity: 'low' | 'medium' | 'high' } | null> {
    const result = await this.pool.query<AmbiguityRow>(
      `SELECT * FROM ambiguity_registry WHERE normalized_form = $1`,
      [surfaceForm],
    );
    const row = result.rows[0];
    if (row == null) return null;

    const severity =
      row.severity === 'low' || row.severity === 'medium' || row.severity === 'high'
        ? row.severity
        : 'low';
    return {
      types: row.ambiguity_types,
      severity,
    };
  }
}
