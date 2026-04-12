/**
 * ADR-007: project search snapshot entities into `canonical_entities` +
 * `entity_source_links` using validated snapshot metadata (no source id as
 * public entity_id — lineage lives in source_record_refs + links).
 */

import type { PoolClient } from 'pg';
import { z } from 'zod';

import type {
  AliasSnapshotRecord,
  AmbiguityRegistrySnapshotRow,
  EntitySnapshotRecord,
} from './search-snapshot-schema.js';

/** Rows ingested from the automated snapshot pipeline before human review. */
export const CANONICAL_ENTITY_APPROVAL_SNAPSHOT_PROJECTED = 'snapshot_projected' as const;

/** Silver NDJSON row → canonical graph link. */
export const ENTITY_SOURCE_LINK_KIND_SILVER_ROW = 'etl_silver_row' as const;

/** Automated ETL link confidence (deterministic join, not a learned score). */
const AUTOMATED_ENTITY_LINK_CONFIDENCE = 1.0;

const SourceRefSchema = z
  .object({
    sourceSystem: z.string().min(1).max(200),
    sourceRecordId: z.string().min(1).max(500),
  })
  .strict();

const GraphSyncMetadataSchema = z
  .object({
    identityResolution: z.enum(['gold_overlay', 'identity_signature']),
    sourceRecordRefs: z.array(SourceRefSchema).min(1).max(32),
  })
  .passthrough();

export interface CanonicalEntityGraphSyncRow {
  readonly canonical_entity_id: string;
  readonly entity_type: string;
  readonly canonical_label: string;
  readonly identity_signature: string;
  readonly producer_ref: string | null;
  readonly region_ref: string | null;
  readonly vintage: number | null;
  readonly attributes: Record<string, unknown>;
  readonly approval_state: string;
  readonly source_provenance: Record<string, unknown>;
}

export interface EntitySourceLinkSyncRow {
  readonly canonical_entity_id: string;
  readonly source_system: string;
  readonly source_record_id: string;
  readonly link_kind: string;
  readonly confidence: number;
  readonly approved: boolean;
}

export interface ApplyCanonicalEntityGraphSyncArgs {
  readonly entities: readonly EntitySnapshotRecord[];
  readonly searchSnapshotId: string;
}

export interface CanonicalAliasSyncRow {
  readonly alias_id: string;
  readonly canonical_entity_id: string;
  readonly surface_form: string;
  readonly normalized_surface: string;
  readonly alias_type: string;
  readonly scope: string;
  readonly approval_state: string;
  readonly source: string;
  readonly source_trust: number;
}

export interface CanonicalAmbiguitySyncRow {
  readonly registry_id: string;
  readonly normalized_form: string;
  readonly canonical_entity_ids: readonly string[];
  readonly ambiguity_types: readonly string[];
  readonly severity: string;
  readonly approval_state: string;
}

export interface ApplyCanonicalAliasAmbiguitySyncArgs {
  readonly aliases: readonly AliasSnapshotRecord[];
  readonly ambiguityRows: readonly AmbiguityRegistrySnapshotRow[];
}

export function buildCanonicalAliasSyncRows(
  aliases: readonly AliasSnapshotRecord[],
): readonly CanonicalAliasSyncRow[] {
  return aliases.map((alias) => ({
    alias_id: alias.aliasId,
    canonical_entity_id: alias.entityId,
    surface_form: alias.value,
    normalized_surface: alias.normalizedValue,
    alias_type: alias.type,
    scope: alias.scope,
    approval_state: CANONICAL_ENTITY_APPROVAL_SNAPSHOT_PROJECTED,
    source: alias.source,
    source_trust: alias.sourceTrust,
  }));
}

export function buildCanonicalAmbiguitySyncRows(
  rows: readonly AmbiguityRegistrySnapshotRow[],
): readonly CanonicalAmbiguitySyncRow[] {
  return rows.map((row) => ({
    registry_id: row.registryId,
    normalized_form: row.normalizedForm,
    canonical_entity_ids: row.entityIds,
    ambiguity_types: row.ambiguityTypes,
    severity: row.severity,
    approval_state: CANONICAL_ENTITY_APPROVAL_SNAPSHOT_PROJECTED,
  }));
}

export interface ApplyFullCanonicalGraphSyncArgs extends ApplyCanonicalEntityGraphSyncArgs {
  readonly aliases: readonly AliasSnapshotRecord[];
  readonly ambiguityRows: readonly AmbiguityRegistrySnapshotRow[];
}

function readVintageYear(attributes: Readonly<Record<string, unknown>>): number | null {
  const raw = attributes['vintage'];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return null;
  }
  return Math.trunc(raw);
}

function readStringField(meta: Readonly<Record<string, unknown>>, key: string): string | null {
  const v = meta[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Maps validated snapshot entity rows to canonical graph upsert payloads.
 * Throws if metadata is missing ADR-007 lineage fields (fail-closed).
 */
export function buildCanonicalGraphSyncPayloads(
  entities: readonly EntitySnapshotRecord[],
  searchSnapshotId: string,
): { readonly canonicalRows: readonly CanonicalEntityGraphSyncRow[]; readonly linkRows: readonly EntitySourceLinkSyncRow[] } {
  const canonicalById = new Map<string, CanonicalEntityGraphSyncRow>();
  const linkRows: EntitySourceLinkSyncRow[] = [];

  for (const entity of entities) {
    const metaUnknown: unknown = entity.metadata;
    if (typeof metaUnknown !== 'object' || metaUnknown === null) {
      throw new Error(`entity ${entity.entityId}: metadata must be an object`);
    }
    const metaParsed = GraphSyncMetadataSchema.safeParse(metaUnknown);
    if (!metaParsed.success) {
      throw new Error(
        `entity ${entity.entityId}: invalid graph sync metadata: ${metaParsed.error.message}`,
      );
    }
    const meta = metaParsed.data;
    const primaryRef = meta.sourceRecordRefs[0];
    if (primaryRef === undefined) {
      throw new Error(`entity ${entity.entityId}: sourceRecordRefs[0] is required`);
    }

    const attrs =
      typeof entity.attributes === 'object' && entity.attributes !== null && !Array.isArray(entity.attributes)
        ? { ...entity.attributes }
        : {};

    const producerRef = readStringField(meta as Record<string, unknown>, 'producer');
    const regionRef = readStringField(meta as Record<string, unknown>, 'region');

    const canonicalRow: CanonicalEntityGraphSyncRow = {
      canonical_entity_id: entity.entityId,
      entity_type: entity.entityType,
      canonical_label: entity.canonicalLabel,
      identity_signature: entity.identitySignature,
      producer_ref: producerRef,
      region_ref: regionRef,
      vintage: readVintageYear(attrs),
      attributes: attrs,
      approval_state: CANONICAL_ENTITY_APPROVAL_SNAPSHOT_PROJECTED,
      source_provenance: {
        search_snapshot_id: searchSnapshotId,
        identity_resolution: meta.identityResolution,
        primary_source: {
          source_system: primaryRef.sourceSystem,
          source_record_id: primaryRef.sourceRecordId,
        },
        source_record_refs: meta.sourceRecordRefs,
      },
    };

    if (canonicalById.has(entity.entityId)) {
      throw new Error(`duplicate canonical_entity_id in snapshot batch: ${entity.entityId}`);
    }
    canonicalById.set(entity.entityId, canonicalRow);

    linkRows.push({
      canonical_entity_id: entity.entityId,
      source_system: primaryRef.sourceSystem,
      source_record_id: primaryRef.sourceRecordId,
      link_kind: ENTITY_SOURCE_LINK_KIND_SILVER_ROW,
      confidence: AUTOMATED_ENTITY_LINK_CONFIDENCE,
      approved: true,
    });
  }

  return {
    canonicalRows: [...canonicalById.values()],
    linkRows,
  };
}

/**
 * Upserts canonical graph tables from a published search snapshot entity plane.
 * Caller must supply an open transaction on `client`.
 */
export async function applyCanonicalEntityGraphSync(
  client: PoolClient,
  args: ApplyCanonicalEntityGraphSyncArgs,
): Promise<void> {
  const { canonicalRows, linkRows } = buildCanonicalGraphSyncPayloads(args.entities, args.searchSnapshotId);

  if (canonicalRows.length === 0) {
    return;
  }

  const canonicalJson = JSON.stringify(canonicalRows);
  await client.query(
    `WITH input AS (
       SELECT *
       FROM jsonb_to_recordset($1::jsonb) AS rows(
         canonical_entity_id text,
         entity_type text,
         canonical_label text,
         identity_signature text,
         producer_ref text,
         region_ref text,
         vintage integer,
         attributes jsonb,
         approval_state text,
         source_provenance jsonb
       )
     )
     INSERT INTO canonical_entities (
       canonical_entity_id, entity_type, canonical_label, identity_signature,
       producer_ref, region_ref, vintage, attributes, approval_state, source_provenance
     )
     SELECT
       canonical_entity_id, entity_type, canonical_label, identity_signature,
       producer_ref, region_ref, vintage, attributes, approval_state, source_provenance
     FROM input
     ON CONFLICT (canonical_entity_id) DO UPDATE SET
       entity_type = EXCLUDED.entity_type,
       canonical_label = EXCLUDED.canonical_label,
       identity_signature = EXCLUDED.identity_signature,
       producer_ref = EXCLUDED.producer_ref,
       region_ref = EXCLUDED.region_ref,
       vintage = EXCLUDED.vintage,
       attributes = EXCLUDED.attributes,
       approval_state = EXCLUDED.approval_state,
       source_provenance = EXCLUDED.source_provenance,
       updated_at = NOW()`,
    [canonicalJson],
  );

  const linkJson = JSON.stringify(linkRows);
  await client.query(
    `WITH input AS (
       SELECT *
       FROM jsonb_to_recordset($1::jsonb) AS rows(
         canonical_entity_id text,
         source_system text,
         source_record_id text,
         link_kind text,
         confidence double precision,
         approved boolean
       )
     )
     INSERT INTO entity_source_links (
       canonical_entity_id, source_system, source_record_id, link_kind, confidence, approved
     )
     SELECT
       canonical_entity_id, source_system, source_record_id, link_kind, confidence, approved
     FROM input
     ON CONFLICT (source_system, source_record_id) DO UPDATE SET
       canonical_entity_id = EXCLUDED.canonical_entity_id,
       link_kind = EXCLUDED.link_kind,
       confidence = EXCLUDED.confidence,
       approved = EXCLUDED.approved,
       linked_at = NOW()`,
    [linkJson],
  );
}

/**
 * Replaces canonical alias / ambiguity projection tables from the active snapshot.
 * Must run after {@link applyCanonicalEntityGraphSync} (FK: canonical_aliases → canonical_entities).
 */
export async function applyCanonicalAliasAmbiguitySync(
  client: PoolClient,
  args: ApplyCanonicalAliasAmbiguitySyncArgs,
): Promise<void> {
  await client.query('TRUNCATE TABLE canonical_aliases');
  const aliasRows = buildCanonicalAliasSyncRows(args.aliases);
  if (aliasRows.length > 0) {
    const aliasJson = JSON.stringify(aliasRows);
    await client.query(
      `WITH input AS (
         SELECT *
         FROM jsonb_to_recordset($1::jsonb) AS rows(
           alias_id text,
           canonical_entity_id text,
           surface_form text,
           normalized_surface text,
           alias_type text,
           scope text,
           approval_state text,
           source text,
           source_trust double precision
         )
       )
       INSERT INTO canonical_aliases (
         alias_id, canonical_entity_id, surface_form, normalized_surface,
         alias_type, scope, approval_state, source, source_trust
       )
       SELECT
         alias_id, canonical_entity_id, surface_form, normalized_surface,
         alias_type, scope, approval_state, source, source_trust
       FROM input`,
      [aliasJson],
    );
  }

  await client.query('TRUNCATE TABLE canonical_ambiguity_registry');
  const ambiguityRows = buildCanonicalAmbiguitySyncRows(args.ambiguityRows);
  if (ambiguityRows.length > 0) {
    const serializable = ambiguityRows.map((row) => ({
      registry_id: row.registry_id,
      normalized_form: row.normalized_form,
      canonical_entity_ids: row.canonical_entity_ids,
      ambiguity_types: row.ambiguity_types,
      severity: row.severity,
      approval_state: row.approval_state,
    }));
    const ambiguityJson = JSON.stringify(serializable);
    await client.query(
      `WITH input AS (
         SELECT *
         FROM jsonb_to_recordset($1::jsonb) AS rows(
           registry_id text,
           normalized_form text,
           canonical_entity_ids jsonb,
           ambiguity_types jsonb,
           severity text,
           approval_state text
         )
       )
       INSERT INTO canonical_ambiguity_registry (
         registry_id, normalized_form, canonical_entity_ids, ambiguity_types, severity, approval_state
       )
       SELECT
         registry_id, normalized_form, canonical_entity_ids, ambiguity_types, severity, approval_state
       FROM input`,
      [ambiguityJson],
    );
  }
}

export async function applyFullCanonicalGraphSync(
  client: PoolClient,
  args: ApplyFullCanonicalGraphSyncArgs,
): Promise<void> {
  await applyCanonicalEntityGraphSync(client, {
    entities: args.entities,
    searchSnapshotId: args.searchSnapshotId,
  });
  await applyCanonicalAliasAmbiguitySync(client, {
    aliases: args.aliases,
    ambiguityRows: args.ambiguityRows,
  });
}
