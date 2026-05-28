import type { Pool, QueryResultRow } from 'pg';
import type {
  AmbiguityDictionary,
  AmbiguityInfo,
} from '../../domain/query/port/ambiguity-dictionary.port.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import { readPgSqlState } from '../db/pg-sqlstate.js';
import {
  ACTIVE_SNAPSHOT_POINTER_CACHE_TTL_MS,
  isActiveSnapshotSubstrateBootstrapAllowed,
  resolveActiveSnapshot,
} from '../db/active-snapshot-resolver.js';

/**
 * Decode a row from `ambiguity_registry` into the domain shape. JSONB ambiguity
 * data is external substrate, so per the JSONB safety rule we validate the
 * shape rather than `as`-casting. Returns `null` if `ambiguity_types` is not a
 * string array. Throws if severity is an unknown literal (loud — schema drift).
 */
function parseAmbiguityRow(row: QueryResultRow): AmbiguityInfo | null {
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

export class PgAmbiguityDictionary implements AmbiguityDictionary {
  private activeSnapshotMissingTableUntil = 0;
  private activeSnapshotMissingTableLogged = false;

  constructor(
    private readonly pool: Pool,
    private readonly snapshotIdOverride?: string,
  ) {}

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

  async getAmbiguityInfo(surfaceForm: string): Promise<AmbiguityInfo | null> {
    const snap = await this.resolveActiveSnapshotOrNull();
    if (snap === null) return null;
    const result = await this.queryAmbiguity(
      `SELECT * FROM ambiguity_registry WHERE normalized_form = $1 AND search_snapshot_id = $2`,
      [surfaceForm, snap.activeSnapshotId],
    );
    const row = result.rows[0];
    if (row == null) return null;
    return parseAmbiguityRow(row);
  }

  /**
   * Batch lookup — single `WHERE normalized_form = ANY($1::text[])` query.
   * Collapses N sequential round-trips into one. See port docs (C3 rationale).
   */
  async getAmbiguityInfoBatch(
    surfaceForms: readonly string[],
  ): Promise<ReadonlyMap<string, AmbiguityInfo>> {
    if (surfaceForms.length === 0) {
      return new Map();
    }
    const snap = await this.resolveActiveSnapshotOrNull();
    if (snap === null) {
      return new Map();
    }

    // Dedupe at the SQL boundary so the substrate sees no redundant entries.
    // Use Set to preserve uniqueness; surface_form casing is preserved verbatim
    // (caller is responsible for normalisation, matching the singular path).
    const distinctForms = [...new Set(surfaceForms)];
    const result = await this.queryAmbiguity(
      `SELECT normalized_form, ambiguity_types, severity
       FROM ambiguity_registry
       WHERE normalized_form = ANY($1::text[]) AND search_snapshot_id = $2`,
      [distinctForms, snap.activeSnapshotId],
    );

    const out = new Map<string, AmbiguityInfo>();
    for (const row of result.rows) {
      const formRaw: unknown = Reflect.get(row, 'normalized_form');
      if (typeof formRaw !== 'string') continue;
      const info = parseAmbiguityRow(row);
      if (info !== null) {
        out.set(formRaw, info);
      }
    }
    return out;
  }

  /**
   * T-010/W2: degrade gracefully when the pointer table is missing (fresh
   * dev DB before migration). A present-but-empty pointer row is still a
   * loud error upstream.
   */
  private async resolveActiveSnapshotOrNull(): Promise<{ activeSnapshotId: string } | null> {
    if (this.snapshotIdOverride !== undefined) {
      return { activeSnapshotId: this.snapshotIdOverride };
    }
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
