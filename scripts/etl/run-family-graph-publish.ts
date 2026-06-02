/**
 * Entity Lookup V2 — family graph publisher (T-ELV2-06 Half B, runnable).
 *
 * Builds the REAL-producer family adjacency and publishes it to the
 * snapshot-scoped `entity_family` table (migration 031) for the ACTIVE snapshot.
 * Operator ETL step (infra-gated on live PG), mirroring the ambiguity-registry
 * publish. Atomic + idempotent: replaces the active snapshot's rows in one tx.
 *
 * SOURCE = the runtime `entities` table (NOT silver.ndjson). The family members
 * MUST be in the runtime CanonicalEntityId id-space — the same ids the alias
 * substrate/engine anchors use — or no anchor would ever match a family member.
 * silver carries source-namespace `sourceId`, so reading it would publish ids
 * that never join. producer comes from attributes->>'producer' (REAL-producer
 * gating excludes the canonicalLabel fallback inside buildFamilyGraphRows).
 *
 *   pnpm run etl:family-graph:publish
 */

import type { PoolClient } from 'pg';
import { loadConfig } from '../../src/config/env.js';
import { getPgPool, closePgPool } from '../../src/infrastructure/db/pg-pool.js';
import { resolveActiveSnapshot } from '../../src/infrastructure/db/active-snapshot-resolver.js';
import {
  buildFamilyGraphRows,
  mapEntityRowToInput,
  type FamilyGraphInputRecord,
  type FamilyGraphRow,
} from './family-graph-builder.js';

const INSERT_BATCH_SIZE = 500;

async function insertFamilyRows(
  client: PoolClient,
  snapshotId: string,
  rows: readonly FamilyGraphRow[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
    const values: unknown[] = [];
    const tuples = batch.map((r, j) => {
      values.push(snapshotId, r.familyId, r.familyKey, r.memberEntityId, r.familySize, r.edgeWeight);
      const o = j * 6; // 6 params per row
      return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6})`;
    });
    await client.query(
      `INSERT INTO entity_family (search_snapshot_id, family_id, family_key, member_entity_id, family_size, edge_weight)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (search_snapshot_id, family_id, member_entity_id) DO NOTHING`,
      values,
    );
  }
}

async function main(): Promise<void> {
  loadConfig();
  const pool = getPgPool();
  try {
    const { activeSnapshotId } = await resolveActiveSnapshot(pool, { bypassCache: true });

    // Runtime entities (CanonicalEntityId id-space) + producer from attributes.
    const entitiesResult = await pool.query(
      `SELECT entity_id, canonical_label, attributes->>'producer' AS producer
         FROM entities
        WHERE search_snapshot_id = $1`,
      [activeSnapshotId],
    );
    const records: FamilyGraphInputRecord[] = [];
    for (const row of entitiesResult.rows) {
      const mapped = mapEntityRowToInput(row);
      if (mapped !== null) records.push(mapped);
    }
    const rows = buildFamilyGraphRows(records);
    const families = new Set(rows.map((r) => r.familyId)).size;
    console.log(`[elv2-family] entities=${records.length} → family rows=${rows.length} across ${families} families`);

    // Atomic republish: DELETE + INSERT in one transaction (no partial wipe).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM entity_family WHERE search_snapshot_id = $1', [activeSnapshotId]);
      await insertFamilyRows(client, activeSnapshotId, rows);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    console.log(`[elv2-family] published → snapshot ${activeSnapshotId}`);
  } finally {
    await closePgPool();
  }
}

main().catch((err: unknown) => {
  console.error('[elv2-family] FATAL', err);
  process.exit(1);
});
