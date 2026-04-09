import { nanoid } from 'nanoid';
import type { Pool } from 'pg';
import type { LineageStore } from '../../domain/ingestion/port/lineage-store.port.js';
import type { LineageRecord } from '../../domain/ingestion/model/lineage-record.js';
import type { EntityId } from '../../domain/shared/types/index.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';

const log = bootstrapLogger.child({ component: 'PgLineageStore' });

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

const VALID_LINEAGE_DECISIONS: ReadonlySet<string> = new Set([
  'merge', 'split', 'reject', 'manual_review',
]);
const VALID_LINEAGE_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'ingestion_pipeline', 'manual_review', 'api_import', 'batch_correction',
]);

/**
 * Validates ALL non-optional fields of a JSONB lineage payload, including
 * union-type constraints on `decision` and `sourceType`.
 *
 * Returns false on any shape mismatch — audit data is too important to
 * forge from a corrupted row.
 *
 * Note: returns Record<string, unknown>, NOT Required<LineageRecord>.
 * The previous Required<> type stripped optional markers and let raw JSONB
 * values flow into LineageRecord-typed fields without per-field checks.
 */
function isLineagePayload(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- narrowing after typeof/null/Array checks; object indexing requires Record type
  const obj = value as Record<string, unknown>; // nosemgrep: wine-jsonb-as-cast
  // Required string fields
  if (typeof obj['sourceRecordId'] !== 'string') return false;
  if (typeof obj['sourceType'] !== 'string') return false;
  if (!VALID_LINEAGE_SOURCE_TYPES.has(obj['sourceType'])) return false;
  if (typeof obj['candidateId'] !== 'string') return false;
  if (typeof obj['extractionVersion'] !== 'string') return false;
  if (typeof obj['matchingVersion'] !== 'string') return false;
  if (typeof obj['decision'] !== 'string') return false;
  if (!VALID_LINEAGE_DECISIONS.has(obj['decision'])) return false;
  if (typeof obj['decisionReason'] !== 'string') return false;
  // Required array of strings
  if (!Array.isArray(obj['normalizationRulesApplied'])) return false;
  for (const r of obj['normalizationRulesApplied']) {
    if (typeof r !== 'string') return false;
  }
  // Timestamp must be parseable
  if (parseTimestampOrNull(obj['timestamp']) === null) return false;
  return true;
}

function parseTimestampOrNull(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/**
 * Validates that a value looks like an EntityId. Mirrors the domain
 * `isEntityId` (any non-empty string) and adds a safety upper-bound to reject
 * obviously malformed JSONB blobs (e.g. multi-MB strings from corruption).
 *
 * The previous regex `/^[A-Za-z0-9_:-]{1,256}$/` was wrong: real EntityIds can
 * contain arbitrary Unicode (Korean wine names, accented Latin), so it would
 * silently drop legitimate audit rows.
 */
const MAX_ENTITY_ID_LENGTH = 1024;
function isValidEntityId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_ENTITY_ID_LENGTH) return false;
  // Reject control characters (defense in depth against log injection / null bytes).
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) return false;
  return true;
}

function asEntityIdArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const v of value) {
    if (!isValidEntityId(v)) return undefined;
    out.push(v);
  }
  return out;
}

function rowToRecord(row: LineageRow): LineageRecord | null {
  if (!isLineagePayload(row.field_changes)) {
    log.warn(
      { lineageId: row.lineage_id },
      'lineage_records.field_changes has unexpected shape; skipping row',
    );
    return null;
  }
  const payload = row.field_changes;
  const timestamp = parseTimestampOrNull(payload['timestamp']);
  if (timestamp === null) return null;

  // Per-field type checks for OPTIONAL fields. Previously the code accessed
  // payload.matchedEntityId etc. and trusted whatever junk JSONB returned.
  // EntityId is a branded type — validate the runtime shape, don't just cast.
  const rawMatchedId = payload['matchedEntityId'];
  const matchedEntityId = isValidEntityId(rawMatchedId)
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- EntityId branded type; runtime-validated by isValidEntityId above
    ? (rawMatchedId as LineageRecord['matchedEntityId'])
    : undefined;
  const rawPrevIds = asEntityIdArray(payload['previousEntityIds']);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- readonly string[] to branded EntityId[]; runtime-validated by asEntityIdArray
  const previousEntityIds = rawPrevIds as LineageRecord['previousEntityIds'] | undefined;
  const operator = typeof payload['operator'] === 'string'
    ? payload['operator']
    : undefined;
  const abuseFlag = typeof payload['abuseFlag'] === 'boolean'
    ? payload['abuseFlag']
    : undefined;

  // All fields below were runtime-validated by isLineagePayload(); use String()
  // for validated strings and eslint-disable for union/branded types.
  return {
    sourceRecordId: String(payload['sourceRecordId']),
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- union type validated by isLineagePayload (VALID_LINEAGE_SOURCE_TYPES check)
    sourceType: payload['sourceType'] as LineageRecord['sourceType'],
    candidateId: String(payload['candidateId']),
    ...(matchedEntityId !== undefined ? { matchedEntityId } : {}),
    ...(previousEntityIds !== undefined ? { previousEntityIds } : {}),
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- array of strings validated by isLineagePayload
    normalizationRulesApplied: payload['normalizationRulesApplied'] as readonly string[],
    extractionVersion: String(payload['extractionVersion']),
    matchingVersion: String(payload['matchingVersion']),
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- union type validated by isLineagePayload (VALID_LINEAGE_DECISIONS check)
    decision: payload['decision'] as LineageRecord['decision'],
    decisionReason: String(payload['decisionReason']),
    ...(operator !== undefined ? { operator } : {}),
    ...(abuseFlag !== undefined ? { abuseFlag } : {}),
    timestamp,
  };
}

function filterValidRecords(rows: readonly LineageRow[]): LineageRecord[] {
  let dropped = 0;
  const out: LineageRecord[] = [];
  for (const row of rows) {
    const rec = rowToRecord(row);
    if (rec === null) {
      dropped++;
    } else {
      out.push(rec);
    }
  }
  if (dropped > 0) {
    log.warn(
      { droppedCount: dropped, totalCount: rows.length },
      'lineage_records corruption — dropped invalid rows',
    );
  }
  return out;
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
    return filterValidRecords(result.rows);
  }

  async findByEntity(entityId: EntityId): Promise<readonly LineageRecord[]> {
    const result = await this.pool.query<LineageRow>(
      `SELECT * FROM lineage_records WHERE entity_id = $1 ORDER BY created_at ASC`,
      [entityId],
    );
    return filterValidRecords(result.rows);
  }
}
