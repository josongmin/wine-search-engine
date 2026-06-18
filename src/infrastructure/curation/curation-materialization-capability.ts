import type { Pool } from 'pg';
import { pgTableHasColumn } from '../db/pg-schema-capabilities.js';

/** Migration 033 — materialized snapshot tracking on staging proposal tables. */
export const CURATION_MATERIALIZATION_SNAPSHOT_COLUMN = 'materialized_snapshot_id';

const PROBE_TABLE = 'alias_proposals';

export async function pgCurationMaterializationTrackingEnabled(pool: Pool): Promise<boolean> {
  return pgTableHasColumn(pool, PROBE_TABLE, CURATION_MATERIALIZATION_SNAPSHOT_COLUMN);
}
