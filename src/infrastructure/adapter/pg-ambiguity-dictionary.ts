import type { Pool, QueryResultRow } from 'pg';
import type { AmbiguityDictionary } from '../../domain/query/port/ambiguity-dictionary.port.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import { readPgSqlState } from '../db/pg-sqlstate.js';
import {
  ACTIVE_SNAPSHOT_POINTER_CACHE_TTL_MS,
  isActiveSnapshotSubstrateBootstrapAllowed,
  resolveActiveSnapshot,
} from '../db/active-snapshot-resolver.js';

export class PgAmbiguityDictionary implements AmbiguityDictionary {
  private activeSnapshotMissingTableUntil = 0;
  private activeSnapshotMissingTableLogged = false;

  constructor(private readonly pool: Pool) {}

  async isKnownAmbiguous(surfaceForm: string): Promise<boolean> {
    const snap = await this.resolveActiveSnapshotOrNull();
    if (snap === null) return false;
    const result = await this.queryAmbiguity(
      `SELECT EXISTS(
        SELECT 1 FROM ambiguity_registry WHERE normalized_form = $1 AND search_snapshot_id = $2
      ) AS exists`,
      [surfaceForm, snap.activeSnapshotId],
    );
    const row0 = result.rows[0];
    const existsRaw: unknown = row0 != null ? Reflect.get(row0, 'exists') : undefined;
    return existsRaw === true;
  }

  async getAmbiguityInfo(
    surfaceForm: string,
  ): Promise<{ types: string[]; severity: 'low' | 'medium' | 'high' } | null> {
    const snap = await this.resolveActiveSnapshotOrNull();
    if (snap === null) return null;
    const result = await this.queryAmbiguity(
      `SELECT * FROM ambiguity_registry WHERE normalized_form = $1 AND search_snapshot_id = $2`,
      [surfaceForm, snap.activeSnapshotId],
    );
    const row = result.rows[0];
    if (row == null) return null;

    const typesRaw: unknown = Reflect.get(row, 'ambiguity_types');
    const severityRaw: unknown = Reflect.get(row, 'severity');
    if (!Array.isArray(typesRaw) || !typesRaw.every((t): t is string => typeof t === 'string')) {
      return null;
    }
    if (severityRaw !== 'low' && severityRaw !== 'medium' && severityRaw !== 'high') {
      throw new Error(
        `PgAmbiguityDictionary: unknown severity "${String(severityRaw)}" — schema drift or corrupted row`,
      );
    }
    return {
      types: typesRaw,
      severity: severityRaw,
    };
  }

  /**
   * T-010/W2: degrade gracefully when the pointer table is missing (fresh
   * dev DB before migration). A present-but-empty pointer row is still a
   * loud error upstream.
   */
  private async resolveActiveSnapshotOrNull(): Promise<{ activeSnapshotId: string } | null> {
    const now = Date.now();
    if (this.activeSnapshotMissingTableUntil > now) {
      return null;
    }

    try {
      const snapshot = await resolveActiveSnapshot(this.pool);
      this.activeSnapshotMissingTableUntil = 0;
      this.activeSnapshotMissingTableLogged = false;
      return snapshot;
    } catch (err: unknown) {
      if (readPgSqlState(err) === '42P01') {
        if (!isActiveSnapshotSubstrateBootstrapAllowed()) {
          throw err;
        }
        this.activeSnapshotMissingTableUntil = now + ACTIVE_SNAPSHOT_POINTER_CACHE_TTL_MS;
        if (!this.activeSnapshotMissingTableLogged) {
          bootstrapLogger.info(
            '[PgAmbiguityDictionary] active_search_snapshot table missing — ambiguity lookup disabled until substrate recovers',
          );
          this.activeSnapshotMissingTableLogged = true;
        }
        return null;
      }
      throw err;
    }
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
      if (!isActiveSnapshotSubstrateBootstrapAllowed()) {
        throw err;
      }
      bootstrapLogger.info(
        '[PgAmbiguityDictionary] ambiguity_registry table does not exist yet — ambiguity lookup disabled for this request',
      );
      return { rows: [] };
    }
  }
}
