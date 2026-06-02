import type { Pool, QueryResultRow } from 'pg';
import type { FamilyGraphPort, FamilySibling } from '../../domain/resolver/v2/family-graph.port.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import { readPgSqlState } from '../db/pg-sqlstate.js';
import { runAbortablePgQuery } from '../db/abortable-pg-query.js';
import {
  ACTIVE_SNAPSHOT_POINTER_CACHE_TTL_MS,
  isActiveSnapshotSubstrateBootstrapAllowed,
  resolveActiveSnapshot,
} from '../db/active-snapshot-resolver.js';

/**
 * PgFamilyGraph — snapshot-scoped producer family adjacency (T-ELV2-06 Half B),
 * backed by the `entity_family` table (migration 031). Returns the co-producer
 * siblings of an anchor entity (excluding the anchor). Mirrors
 * PgAmbiguityDictionary's degradation contract: empty result when the table or
 * active snapshot is unavailable, so the family_graph channel stays dormant
 * until the graph is published — never throws on a missing substrate.
 *
 * The edge_weight is computed at build time (1 - 1/familySize); the runtime read
 * trusts it but validates the row shape (no `as` on external data, rule 11).
 */
function parseSiblingRow(row: QueryResultRow): FamilySibling | null {
  const memberRaw: unknown = Reflect.get(row, 'member_entity_id');
  const weightRaw: unknown = Reflect.get(row, 'edge_weight');
  if (typeof memberRaw !== 'string' || memberRaw.length === 0) return null;
  if (typeof weightRaw !== 'number' || !Number.isFinite(weightRaw)) return null;
  return { entityId: memberRaw, edgeWeight: weightRaw };
}

export class PgFamilyGraph implements FamilyGraphPort {
  private activeSnapshotMissingUntil = 0;
  private missingLogged = false;

  constructor(
    private readonly pool: Pool,
    private readonly snapshotIdOverride?: string,
  ) {}

  async getFamilySiblings(entityId: string, signal?: AbortSignal): Promise<readonly FamilySibling[]> {
    const snap = await this.resolveActiveSnapshotOrNull();
    if (snap === null) return [];
    const result = await this.queryFamily(
      `SELECT ef2.member_entity_id, ef2.edge_weight
         FROM entity_family ef1
         JOIN entity_family ef2
           ON ef2.search_snapshot_id = ef1.search_snapshot_id
          AND ef2.family_id = ef1.family_id
        WHERE ef1.search_snapshot_id = $1
          AND ef1.member_entity_id = $2
          AND ef2.member_entity_id <> $2`,
      [snap.activeSnapshotId, entityId],
      signal,
    );
    return result.rows.map(parseSiblingRow).filter((s): s is FamilySibling => s !== null);
  }

  async getFamilySiblingsBatch(
    entityIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, readonly FamilySibling[]>> {
    const out = new Map<string, FamilySibling[]>();
    if (entityIds.length === 0) return out;
    const snap = await this.resolveActiveSnapshotOrNull();
    if (snap === null) return out;
    const distinct = [...new Set(entityIds)];
    const result = await this.queryFamily(
      `SELECT ef1.member_entity_id AS anchor_id, ef2.member_entity_id, ef2.edge_weight
         FROM entity_family ef1
         JOIN entity_family ef2
           ON ef2.search_snapshot_id = ef1.search_snapshot_id
          AND ef2.family_id = ef1.family_id
        WHERE ef1.search_snapshot_id = $1
          AND ef1.member_entity_id = ANY($2::text[])
          AND ef2.member_entity_id <> ef1.member_entity_id`,
      [snap.activeSnapshotId, distinct],
      signal,
    );
    for (const row of result.rows) {
      const anchorRaw: unknown = Reflect.get(row, 'anchor_id');
      if (typeof anchorRaw !== 'string' || anchorRaw.length === 0) continue;
      const sibling = parseSiblingRow(row);
      if (sibling === null) continue;
      const list = out.get(anchorRaw);
      if (list === undefined) out.set(anchorRaw, [sibling]);
      else list.push(sibling);
    }
    return out;
  }

  private async resolveActiveSnapshotOrNull(): Promise<{ activeSnapshotId: string } | null> {
    if (this.snapshotIdOverride !== undefined) {
      return { activeSnapshotId: this.snapshotIdOverride };
    }
    const now = Date.now();
    if (this.activeSnapshotMissingUntil > now) return null;
    try {
      const snapshot = await resolveActiveSnapshot(this.pool);
      this.activeSnapshotMissingUntil = 0;
      this.missingLogged = false;
      return snapshot;
    } catch (err: unknown) {
      if (readPgSqlState(err) === '42P01') {
        if (!isActiveSnapshotSubstrateBootstrapAllowed()) throw err;
        this.activeSnapshotMissingUntil = now + ACTIVE_SNAPSHOT_POINTER_CACHE_TTL_MS;
        if (!this.missingLogged) {
          bootstrapLogger.info(
            '[PgFamilyGraph] active_search_snapshot table missing — family graph disabled until substrate recovers',
          );
          this.missingLogged = true;
        }
        return null;
      }
      throw err;
    }
  }

  private async queryFamily(
    sql: string,
    params: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<{ rows: QueryResultRow[] }> {
    try {
      return await runAbortablePgQuery(this.pool, signal, sql, params);
    } catch (err: unknown) {
      if (readPgSqlState(err) !== '42P01') throw err;
      if (!isActiveSnapshotSubstrateBootstrapAllowed()) throw err;
      bootstrapLogger.info(
        '[PgFamilyGraph] entity_family table does not exist yet — family graph disabled for this request',
      );
      return { rows: [] };
    }
  }
}
