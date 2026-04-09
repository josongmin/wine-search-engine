/**
 * Shared Zod schemas for validating JSONB columns read from PostgreSQL.
 *
 * Rule 11 (CLAUDE.md): NEVER cast JSONB directly with `as DomainType`.
 * Use these schemas with `.safeParse()` and fall back to sentinels on failure.
 */
import { z } from 'zod';
import type { DecisionSnapshot } from '../../domain/shared/types/index.js';
import type { EvidenceItem } from '../../domain/shared/types/index.js';
import type { Relations } from '../../domain/entity/model/relations.js';
import type { EntityAttributes } from '../../domain/entity/model/attributes.js';
import { CORRUPTED_SNAPSHOT_ID } from '../../domain/shared/types/index.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';

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
 * Sentinel snapshot returned when JSONB validation fails.
 * All fields use explicit "corrupted" markers so downstream code
 * never silently treats invalid data as a real snapshot.
 */
export const CORRUPTED_SNAPSHOT_SENTINEL: DecisionSnapshot = Object.freeze({
  snapshot_id: CORRUPTED_SNAPSHOT_ID,
  model_versions: {},
  index_versions: {},
  policy_rule_version: CORRUPTED_SNAPSHOT_ID,
  threshold_profile_id: CORRUPTED_SNAPSHOT_ID,
  planner_version: CORRUPTED_SNAPSHOT_ID,
  response_contract_version: CORRUPTED_SNAPSHOT_ID,
  feature_flags: {},
});

/**
 * Validate JSONB decision_snapshot column at read time.
 * Returns a sentinel snapshot on validation failure (graceful degradation)
 * because the domain model requires a non-null DecisionSnapshot.
 */
export function parseDecisionSnapshotJsonb(raw: unknown, caller: string): DecisionSnapshot {
  const result = DecisionSnapshotJsonbSchema.safeParse(raw);
  if (result.success) {
     
    return result.data as unknown as DecisionSnapshot;
  }
  jsonbLog.warn(
    { issues: result.error.issues.slice(0, 3), caller },
    'decision_snapshot JSONB failed validation; using sentinel snapshot',
  );
  return CORRUPTED_SNAPSHOT_SENTINEL;
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

/** Empty evidence array sentinel for validation failures. */
const EMPTY_EVIDENCE: readonly EvidenceItem[] = Object.freeze([]);

/**
 * Validate JSONB evidence_items column at read time.
 * Returns an empty array on failure (graceful degradation).
 */
export function parseEvidenceItemsJsonb(raw: unknown, caller: string): readonly EvidenceItem[] {
  if (!Array.isArray(raw)) {
    if (raw != null) {
      jsonbLog.warn({ caller, rawType: typeof raw }, 'evidence_items JSONB is not an array; returning empty');
    }
    return EMPTY_EVIDENCE;
  }
  const validated: EvidenceItem[] = [];
  for (const item of raw) {
    const result = EvidenceItemJsonbSchema.safeParse(item);
    if (result.success) {
       
      validated.push(result.data as unknown as EvidenceItem);
    } else {
      jsonbLog.warn(
        { issues: result.error.issues.slice(0, 3), caller },
        'evidence_items element failed validation; skipping item',
      );
    }
  }
  return validated;
}

// ---------------------------------------------------------------------------
// EntityRow (for snapshot rollback in pg-entity-repository)
// ---------------------------------------------------------------------------

/**
 * Runtime schema for an EntityRow persisted as JSONB in entity_snapshots.
 * Only validates the structural fields needed for rollback restoration.
 * Uses `.passthrough()` so JSONB columns (relations, attributes, metadata)
 * are forwarded as-is to the INSERT statement.
 */
export const EntityRowSnapshotJsonbSchema = z.object({
  entity_id: z.string().min(1),
  entity_type: z.string().min(1),
  canonical_label: z.string(),
  identity_signature: z.string(),
  relations: z.unknown(),
  attributes: z.unknown(),
  metadata: z.unknown(),
  created_at: z.unknown(), // Date or ISO string depending on serialization
  updated_at: z.unknown(),
}).passthrough();

export type ValidatedEntityRowSnapshot = z.infer<typeof EntityRowSnapshotJsonbSchema>;

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

/** Empty Relations fallback returned on parse failure. */
const EMPTY_RELATIONS: Relations = Object.freeze({});

/**
 * Validate a Relations JSONB value at read time.
 * Returns an empty Relations object on validation failure so downstream code
 * never iterates a corrupted payload.
 */
export function parseRelationsJsonb(raw: unknown, caller: string): Relations {
  const result = RelationsJsonbSchema.safeParse(raw);
  if (result.success) {

    return result.data as unknown as Relations;
  }
  jsonbLog.warn(
    { issues: result.error.issues.slice(0, 3), caller, rawType: typeof raw },
    `${JSONB_WARN_PREFIX}: relations JSONB; using empty Relations`,
  );
  return EMPTY_RELATIONS;
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
  grapes: z.array(z.string()).optional(),
  style: z.string().optional(),
  body: z.number().finite().optional(),
  sweetness: z.number().finite().optional(),
  acidity: z.number().finite().optional(),
  tannin: z.number().finite().optional(),
  region: z.string().optional(),
  priceBand: z.string().optional(),
  vintage: z.number().int().optional(),
  pairing: z.array(z.string()).optional(),
  occasion: z.array(z.string()).optional(),
}).passthrough();

/** Empty EntityAttributes fallback returned on parse failure. */
const EMPTY_ENTITY_ATTRIBUTES: EntityAttributes = Object.freeze({});

/**
 * Validate an EntityAttributes JSONB value at read time.
 * Returns an empty attributes object on failure so Entity consumers do not
 * crash on wrong-typed or corrupted payloads.
 */
export function parseEntityAttributesJsonb(raw: unknown, caller: string): EntityAttributes {
  const result = EntityAttributesJsonbSchema.safeParse(raw);
  if (result.success) {

    return result.data as unknown as EntityAttributes;
  }
  jsonbLog.warn(
    { issues: result.error.issues.slice(0, 3), caller, rawType: typeof raw },
    `${JSONB_WARN_PREFIX}: attributes JSONB; using empty EntityAttributes`,
  );
  return EMPTY_ENTITY_ATTRIBUTES;
}
