import { nanoid } from 'nanoid';
import type { Pool } from 'pg';
import type { LineageStore } from '../../domain/ingestion/port/lineage-store.port.js';
import type { LineageRecord, LineageDecision, LineageSourceType } from '../../domain/ingestion/model/lineage-record.js';
import type { EntityId } from '../../domain/shared/types/index.js';

/**
 * The domain LineageRecord has no explicit `lineageId` field.
 * We derive a stable storage key from sourceRecordId + candidateId + timestamp.
 * Full record is stored as JSONB in field_changes for immutable audit trail.
 */
interface LineageRow {
  lineage_id: string;
  source_record_id: string;
  entity_id: string | null;
  action: string;
  field_changes: unknown;
  source_type: string;
  created_at: Date;
}

function rowToRecord(row: LineageRow): LineageRecord {
  // Full domain record is stored inside field_changes as the canonical payload
  const payload = row.field_changes as LineageRecord;
  const VALID_SOURCE_TYPES = new Set<string>([
    'ingestion_pipeline', 'manual_review', 'api_import', 'batch_correction',
  ]);
  const sourceType: LineageSourceType = VALID_SOURCE_TYPES.has(row.source_type)
    ? (row.source_type as LineageSourceType)
    : 'ingestion_pipeline';

  return {
    sourceRecordId: payload.sourceRecordId ?? row.source_record_id,
    sourceType: payload.sourceType ?? sourceType,
    candidateId: payload.candidateId,
    matchedEntityId: payload.matchedEntityId,
    previousEntityIds: payload.previousEntityIds,
    normalizationRulesApplied: payload.normalizationRulesApplied ?? [],
    extractionVersion: payload.extractionVersion,
    matchingVersion: payload.matchingVersion,
    decision: payload.decision ?? (row.action as LineageDecision),
    decisionReason: payload.decisionReason,
    operator: payload.operator,
    abuseFlag: payload.abuseFlag,
    timestamp: payload.timestamp != null ? new Date(payload.timestamp as unknown as string) : row.created_at,
  };
}

export class PgLineageStore implements LineageStore {
  constructor(private readonly pool: Pool) {}

  async save(record: LineageRecord): Promise<void> {
    const lineageId = nanoid();
    await this.pool.query(
      `INSERT INTO lineage_records (
        lineage_id, source_record_id, entity_id, action,
        field_changes, source_type
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        lineageId,
        record.sourceRecordId,
        record.matchedEntityId ?? null,
        record.decision,
        JSON.stringify(record),
        record.sourceType,
      ],
    );
  }

  async findBySourceRecord(sourceRecordId: string): Promise<readonly LineageRecord[]> {
    const result = await this.pool.query<LineageRow>(
      `SELECT * FROM lineage_records WHERE source_record_id = $1 ORDER BY created_at ASC`,
      [sourceRecordId],
    );
    return result.rows.map(rowToRecord);
  }

  async findByEntity(entityId: EntityId): Promise<readonly LineageRecord[]> {
    const result = await this.pool.query<LineageRow>(
      `SELECT * FROM lineage_records WHERE entity_id = $1 ORDER BY created_at ASC`,
      [entityId],
    );
    return result.rows.map(rowToRecord);
  }
}
