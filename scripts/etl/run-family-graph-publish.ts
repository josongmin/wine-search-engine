/**
 * Entity Lookup V2 — family graph publisher (T-ELV2-06 Half B, runnable).
 *
 * Reads the silver entity records, builds the REAL-producer family adjacency
 * (family-graph-builder, no heuristic), and publishes the rows to the
 * snapshot-scoped `entity_family` table (migration 031) for the active snapshot.
 * This is the population step the runtime family_graph channel depends on — it
 * is the operator-run ETL stage (infra-gated on live PG), mirroring the
 * ambiguity-registry publish. Idempotent: replaces the active snapshot's rows.
 *
 * Reads silver's RAW producer (NOT the snapshot's `producer ?? canonicalLabel`
 * fallback), so null/empty producers are naturally excluded — real producers only.
 *
 *   pnpm run etl:family-graph:publish
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { loadConfig } from '../../src/config/env.js';
import { getPgPool, closePgPool } from '../../src/infrastructure/db/pg-pool.js';
import { resolveActiveSnapshot } from '../../src/infrastructure/db/active-snapshot-resolver.js';
import { ETL_ARTIFACT_FILES } from './artifact-contract.js';
import { buildFamilyGraphRows, type FamilyGraphInputRecord } from './family-graph-builder.js';

/** Defensive shape for a silver entity record (only the fields we need). */
const SilverRecordSchema = z.object({
  entityId: z.string().min(1),
  canonicalLabel: z.string().min(1),
  producer: z.string().optional().nullable(),
});

const INSERT_BATCH_SIZE = 500;

function parseSilverRecords(path: string): readonly FamilyGraphInputRecord[] {
  const raw = readFileSync(path, 'utf8');
  const records: FamilyGraphInputRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parsed = SilverRecordSchema.safeParse(JSON.parse(trimmed));
    if (!parsed.success) continue;
    records.push({
      entityId: parsed.data.entityId,
      canonicalLabel: parsed.data.canonicalLabel,
      producer: parsed.data.producer ?? '',
    });
  }
  return records;
}

async function main(): Promise<void> {
  const records = parseSilverRecords(ETL_ARTIFACT_FILES.silver);
  const rows = buildFamilyGraphRows(records);
  console.log(`[elv2-family] silver records=${records.length} → family rows=${rows.length}`);

  loadConfig();
  const pool = getPgPool();
  try {
    const { activeSnapshotId } = await resolveActiveSnapshot(pool, { bypassCache: true });
    // Idempotent republish: clear this snapshot's family rows, then insert.
    await pool.query('DELETE FROM entity_family WHERE search_snapshot_id = $1', [activeSnapshotId]);
    for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
      const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
      const values: unknown[] = [];
      const tuples = batch.map((r, j) => {
        values.push(activeSnapshotId, r.familyId, r.familyKey, r.memberEntityId, r.familySize, r.edgeWeight);
        const o = j * 6; // 6 params per row
        return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6})`;
      });
      await pool.query(
        `INSERT INTO entity_family (search_snapshot_id, family_id, family_key, member_entity_id, family_size, edge_weight)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (search_snapshot_id, family_id, member_entity_id) DO NOTHING`,
        values,
      );
    }
    const families = new Set(rows.map((r) => r.familyId)).size;
    console.log(`[elv2-family] published ${rows.length} rows across ${families} families → snapshot ${activeSnapshotId}`);
  } finally {
    await closePgPool();
  }
}

main().catch((err: unknown) => {
  console.error('[elv2-family] FATAL', err);
  process.exit(1);
});
