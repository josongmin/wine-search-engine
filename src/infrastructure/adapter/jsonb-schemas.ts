/**
 * Shared Zod schemas for validating JSONB columns read from PostgreSQL.
 *
 * Rule 11 (CLAUDE.md): NEVER cast JSONB directly with `as DomainType`.
 * Use these schemas with `.safeParse()` and throw on validation failure.
 *
 * T-E7-01: All parse functions throw CorruptedJsonbError on validation failure
 * instead of returning silent sentinels/empty fallbacks. This makes data
 * corruption loud and forces callers to handle it explicitly.
 */
import { z } from 'zod';
import type { DecisionSnapshot } from '../../domain/shared/types/index.js';
import type { EvidenceItem } from '../../domain/shared/types/index.js';
import type { Relations } from '../../domain/entity/model/relations.js';
import type { EntityAttributes } from '../../domain/entity/model/attributes.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';

// ---------------------------------------------------------------------------
// CorruptedJsonbError — loud failure for JSONB validation
// ---------------------------------------------------------------------------

/**
 * Thrown when a JSONB column read from PostgreSQL fails Zod validation.
 * Callers must handle this explicitly — silent degradation is prohibited.
 */
export class CorruptedJsonbError extends Error {
  readonly column: string;
  readonly caller: string;
  readonly issues: unknown[];

  constructor(column: string, caller: string, issues: unknown[]) {
    super(`Corrupted JSONB in column '${column}' (caller: ${caller}): ${issues.length} validation issue(s)`);
    this.name = 'CorruptedJsonbError';
    this.column = column;
    this.caller = caller;
    this.issues = issues;
  }
}

/** Domain ceiling: a wine rarely has more than ~15 primary grapes; 50 is a safe cap. */
const MAX_GRAPE_ARRAY_LENGTH = 50;
/** Domain ceiling: Vivino pairing taxonomy has ~80 tags; 100 is a safe cap. */
const MAX_PAIRING_ARRAY_LENGTH = 100;
/** Domain ceiling: Vivino occasion taxonomy has ~30 tags; 50 is a safe cap. */
const MAX_OCCASION_ARRAY_LENGTH = 50;

/** Prefix used on warning logs emitted by JSONB validation failures. */
const JSONB_WARN_PREFIX = 'JSONB validation failed';

const jsonbLog = bootstrapLogger.child({ component: 'jsonb-validation' });

// ---------------------------------------------------------------------------
// DecisionSnapshot
// ---------------------------------------------------------------------------

/**
 * Runtime schema for DecisionSnapshot JSONB column.
 * Uses `.passthrough()` so extra DB columns are preserved, not rejected.
 */
export const DecisionSnapshotJsonbSchema = z.object({
  snapshot_id: z.string().min(1),
  policy_rule_version: z.string().min(1),
  threshold_profile_id: z.string().min(1),
  planner_version: z.string().min(1),
  response_contract_version: z.string().min(1),
  model_versions: z.record(z.string()),
  index_versions: z.record(z.string()),
  feature_flags: z.record(z.boolean()),
  nondeterminism_notes: z.string().optional(),
}).passthrough();

/**
 * Validate JSONB decision_snapshot column at read time.
 * Throws CorruptedJsonbError on validation failure — callers must handle explicitly.
 */
export function parseDecisionSnapshotJsonb(raw: unknown, caller: string): DecisionSnapshot {
  const result = DecisionSnapshotJsonbSchema.safeParse(raw);
  if (result.success) {

    return result.data as unknown as DecisionSnapshot;
  }
  jsonbLog.warn(
    { issues: result.error.issues.slice(0, 3), caller },
    'decision_snapshot JSONB failed validation — throwing CorruptedJsonbError',
  );
  throw new CorruptedJsonbError('decision_snapshot', caller, result.error.issues);
}

// ---------------------------------------------------------------------------
// EvidenceItem[]
// ---------------------------------------------------------------------------

/**
 * Runtime schema for a single EvidenceItem from JSONB.
 * Uses `.passthrough()` to tolerate extra fields from schema evolution.
 */
export const EvidenceItemJsonbSchema = z.object({
  type: z.string().min(1),
  source: z.string().min(1),
  contribution: z.string(),
  strength: z.enum(['low', 'medium', 'high']),
  provenance: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

/**
 * Validate JSONB evidence_items column at read time.
 *
 * - null/undefined → empty array (legitimate: new entity with no evidence yet)
 * - non-array (string, object, etc.) → throws CorruptedJsonbError
 * - array with ANY invalid element → throws CorruptedJsonbError (no silent item skipping)
 */
export function parseEvidenceItemsJsonb(raw: unknown, caller: string): readonly EvidenceItem[] {
  if (raw == null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    jsonbLog.warn({ caller, rawType: typeof raw }, 'evidence_items JSONB is not an array — throwing CorruptedJsonbError');
    throw new CorruptedJsonbError('evidence_items', caller, [{ message: `expected array, got ${typeof raw}` }]);
  }
  const validated: EvidenceItem[] = [];
  const failures: unknown[] = [];
  for (const item of raw) {
    const result = EvidenceItemJsonbSchema.safeParse(item);
    if (result.success) {

      validated.push(result.data as unknown as EvidenceItem);
    } else {
      failures.push(...result.error.issues);
    }
  }
  if (failures.length > 0) {
    jsonbLog.warn(
      { issueCount: failures.length, caller },
      'evidence_items contains invalid element(s) — throwing CorruptedJsonbError',
    );
    throw new CorruptedJsonbError('evidence_items', caller, failures);
  }
  return validated;
}

// ---------------------------------------------------------------------------
// EntityRowSnapshotJsonbSchema removed — migration 016 makes runtime write
// path single-authority (ETL publisher). Row-level rollback is replaced by
// pointer-based rollback via active_search_snapshot. Re-introducing a
// row-level rollback schema would invite secondary writers to runtime tables.
// ---------------------------------------------------------------------------
// Relations (entity.relations JSONB column)
// ---------------------------------------------------------------------------

/**
 * Runtime schema for the Relations JSONB payload.
 * All relation fields are optional EntityId strings; `.passthrough()` lets
 * future ETL writers add extra relation keys without read-time crashes.
 */
export const RelationsJsonbSchema = z.object({
  producedBy: z.string().min(1).optional(),
  variantOf: z.string().min(1).optional(),
  locatedIn: z.string().min(1).optional(),
}).passthrough();

/**
 * Validate a Relations JSONB value at read time.
 * Throws CorruptedJsonbError on validation failure — callers must handle explicitly.
 */
export function parseRelationsJsonb(raw: unknown, caller: string): Relations {
  const result = RelationsJsonbSchema.safeParse(raw);
  if (result.success) {

    return result.data as unknown as Relations;
  }
  jsonbLog.warn(
    { issues: result.error.issues.slice(0, 3), caller, rawType: typeof raw },
    `${JSONB_WARN_PREFIX}: relations JSONB — throwing CorruptedJsonbError`,
  );
  throw new CorruptedJsonbError('relations', caller, result.error.issues);
}

// ---------------------------------------------------------------------------
// EntityAttributes (entity.attributes JSONB column)
// ---------------------------------------------------------------------------

/**
 * Runtime schema for the EntityAttributes JSONB payload.
 * Mirrors the EntityAttributes interface; `.passthrough()` tolerates schema
 * drift (new attribute fields added by ETL before TS types catch up).
 * Numeric fields use `.finite()` to reject NaN/Infinity that can poison
 * downstream scoring math.
 */
export const EntityAttributesJsonbSchema = z.object({
  grapes: z.array(z.string()).max(MAX_GRAPE_ARRAY_LENGTH).optional(),
  style: z.string().optional(),
  body: z.number().finite().optional(),
  sweetness: z.number().finite().optional(),
  acidity: z.number().finite().optional(),
  tannin: z.number().finite().optional(),
  region: z.string().optional(),
  priceBand: z.string().optional(),
  vintage: z.number().int().optional(),
  pairing: z.array(z.string()).max(MAX_PAIRING_ARRAY_LENGTH).optional(),
  occasion: z.array(z.string()).max(MAX_OCCASION_ARRAY_LENGTH).optional(),
}).passthrough();

/**
 * Validate an EntityAttributes JSONB value at read time.
 * Throws CorruptedJsonbError on validation failure — callers must handle explicitly.
 */
export function parseEntityAttributesJsonb(raw: unknown, caller: string): EntityAttributes {
  const result = EntityAttributesJsonbSchema.safeParse(raw);
  if (result.success) {

    return result.data as unknown as EntityAttributes;
  }
  jsonbLog.warn(
    { issues: result.error.issues.slice(0, 3), caller, rawType: typeof raw },
    `${JSONB_WARN_PREFIX}: attributes JSONB — throwing CorruptedJsonbError`,
  );
  throw new CorruptedJsonbError('attributes', caller, result.error.issues);
}
