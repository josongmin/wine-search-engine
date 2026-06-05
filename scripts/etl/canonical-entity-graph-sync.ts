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
import { chunkArray } from './etl-utils.js';

/** Rows ingested from the automated snapshot pipeline before human review. */
export const CANONICAL_ENTITY_APPROVAL_SNAPSHOT_PROJECTED = 'snapshot_projected' as const;

/** Silver NDJSON row → canonical graph link. */
export const ENTITY_SOURCE_LINK_KIND_SILVER_ROW = 'etl_silver_row' as const;

/** Automated ETL link confidence (deterministic join, not a learned score). */
const AUTOMATED_ENTITY_LINK_CONFIDENCE = 1.0;
const CANONICAL_GRAPH_ENTITY_BATCH_SIZE = 1_000;
// Canonical alias projection runs inside the same publish-time transaction
// budget as runtime substrate staging. Keep alias batches aligned with the
// bounded runtime publish batch so canonical sync does not reintroduce minute-
// long jsonb_to_recordset statements on the same ~80k alias plane.
const CANONICAL_GRAPH_ALIAS_BATCH_SIZE = 500;
const CANONICAL_GRAPH_LINK_BATCH_SIZE = 1_000;
const CANONICAL_GRAPH_AMBIGUITY_BATCH_SIZE = 1_000;

const SourceRefSchema = z
  .object({
    sourceSystem: z.string().min(1).max(200),
    sourceRecordId: z.string().min(1).max(500),
  })
  .strict();

const GraphSyncMetadataSchema = z
  .object({
    identityResolution: z.enum(['gold_overlay', 'identity_signature']),
    benchmarkEntityId: z.string().min(1).optional(),
    sourceRecordRefs: z.array(SourceRefSchema).min(1).max(32),
  })
  .passthrough();

export interface CanonicalEntityGraphSyncRow {
  readonly search_snapshot_id: string;
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

interface CanonicalEntityIdentityRow {
  readonly canonical_entity_id: string;
  readonly identity_signature: string;
}

interface CanonicalLegacySnapshotRow {
  readonly legacy_rows: string;
}

export interface EntitySourceLinkSyncRow {
  readonly search_snapshot_id: string;
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
  readonly search_snapshot_id: string;
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
  readonly search_snapshot_id: string;
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
  readonly searchSnapshotId: string;
}

export function buildCanonicalAliasSyncRows(
  aliases: readonly AliasSnapshotRecord[],
  searchSnapshotId: string,
): readonly CanonicalAliasSyncRow[] {
  const seenAliasIds = new Set<string>();
  return aliases.map((alias) => {
    if (seenAliasIds.has(alias.aliasId)) {
      throw new Error(`duplicate alias_id in snapshot batch: ${alias.aliasId}`);
    }
    seenAliasIds.add(alias.aliasId);
    return {
      search_snapshot_id: searchSnapshotId,
      alias_id: alias.aliasId,
      canonical_entity_id: alias.entityId,
      surface_form: alias.value,
      normalized_surface: alias.normalizedValue,
      alias_type: alias.type,
      scope: alias.scope,
      approval_state: CANONICAL_ENTITY_APPROVAL_SNAPSHOT_PROJECTED,
      source: alias.source,
      source_trust: alias.sourceTrust,
    };
  });
}

export function buildCanonicalAmbiguitySyncRows(
  rows: readonly AmbiguityRegistrySnapshotRow[],
  searchSnapshotId: string,
): readonly CanonicalAmbiguitySyncRow[] {
  const seenRegistryIds = new Set<string>();
  return rows.map((row) => {
    if (seenRegistryIds.has(row.registryId)) {
      throw new Error(`duplicate registry_id in snapshot batch: ${row.registryId}`);
    }
    seenRegistryIds.add(row.registryId);
    return {
      search_snapshot_id: searchSnapshotId,
      registry_id: row.registryId,
      normalized_form: row.normalizedForm,
      canonical_entity_ids: row.entityIds,
      ambiguity_types: row.ambiguityTypes,
      severity: row.severity,
      approval_state: CANONICAL_ENTITY_APPROVAL_SNAPSHOT_PROJECTED,
    };
  });
}

export interface ApplyFullCanonicalGraphSyncArgs extends ApplyCanonicalEntityGraphSyncArgs {
  readonly aliases: readonly AliasSnapshotRecord[];
  readonly ambiguityRows: readonly AmbiguityRegistrySnapshotRow[];
}

async function assertCanonicalProjectionSnapshotPlaneIntegrity(
  client: Pick<PoolClient, 'query'>,
): Promise<void> {
  const legacyRows = await client.query<{ legacy_rows: string }>(
    `SELECT COUNT(*)::text AS legacy_rows
       FROM (
         SELECT search_snapshot_id FROM canonical_aliases
         UNION ALL
         SELECT search_snapshot_id FROM canonical_ambiguity_registry
       ) projection_rows
      WHERE search_snapshot_id IS NULL
         OR search_snapshot_id = ''`,
  );

  const legacyCount = Number.parseInt(legacyRows.rows[0]?.legacy_rows ?? '0', 10);
  if (legacyCount > 0) {
    throw new Error(
      `canonical projection tables contain ${legacyCount} legacy row(s) without search_snapshot_id; ` +
      `refusing to mix live projection rows with snapshot-bound canonical projection`,
    );
  }
}

async function assertCanonicalRootSnapshotPlaneIntegrity(
  client: Pick<PoolClient, 'query'>,
): Promise<void> {
  const legacyRows = await client.query<CanonicalLegacySnapshotRow>(
    `SELECT COUNT(*)::text AS legacy_rows
       FROM (
         SELECT search_snapshot_id FROM canonical_entities
         UNION ALL
         SELECT search_snapshot_id FROM entity_source_links
       ) root_rows
      WHERE search_snapshot_id IS NULL
         OR search_snapshot_id = ''`,
  );

  const legacyCount = Number.parseInt(legacyRows.rows[0]?.legacy_rows ?? '0', 10);
  if (legacyCount > 0) {
    throw new Error(
      `canonical root graph tables contain ${legacyCount} legacy row(s) without search_snapshot_id; ` +
      `refusing to mix live canonical root rows with snapshot-bound canonical graph`,
    );
  }
}

async function reconcileCanonicalAliases(
  client: PoolClient,
  searchSnapshotId: string,
  aliasRows: readonly CanonicalAliasSyncRow[],
): Promise<void> {
  await client.query(
    `DELETE FROM canonical_aliases
      WHERE search_snapshot_id = $1`,
    [searchSnapshotId],
  );

  for (const aliasBatch of chunkArray(aliasRows, CANONICAL_GRAPH_ALIAS_BATCH_SIZE)) {
    await client.query(
      `WITH input AS (
         SELECT *
         FROM jsonb_to_recordset($1::jsonb) AS rows(
           search_snapshot_id text,
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
         search_snapshot_id, alias_id, canonical_entity_id, surface_form, normalized_surface,
         alias_type, scope, approval_state, source, source_trust
       )
       SELECT
         search_snapshot_id, alias_id, canonical_entity_id, surface_form, normalized_surface,
         alias_type, scope, approval_state, source, source_trust
       FROM input`,
      [JSON.stringify(aliasBatch)],
    );
  }
}

async function reconcileCanonicalEntities(
  client: PoolClient,
  searchSnapshotId: string,
  canonicalRows: readonly CanonicalEntityGraphSyncRow[],
): Promise<void> {
  const canonicalEntityIds = canonicalRows.map((row) => row.canonical_entity_id);
  if (canonicalRows.length === 0) {
    await client.query(
      `DELETE FROM canonical_entities
        WHERE search_snapshot_id = $1`,
      [searchSnapshotId],
    );
    return;
  }

  await client.query(
    `DELETE FROM canonical_entities
      WHERE search_snapshot_id = $1
        AND NOT (canonical_entity_id = ANY($2::text[]))`,
    [searchSnapshotId, canonicalEntityIds],
  );

  for (const canonicalBatch of chunkArray(canonicalRows, CANONICAL_GRAPH_ENTITY_BATCH_SIZE)) {
    await client.query(
      `WITH input AS (
         SELECT *
         FROM jsonb_to_recordset($1::jsonb) AS rows(
           search_snapshot_id text,
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
         search_snapshot_id, canonical_entity_id, entity_type, canonical_label, identity_signature,
         producer_ref, region_ref, vintage, attributes, approval_state, source_provenance
       )
       SELECT
         search_snapshot_id, canonical_entity_id, entity_type, canonical_label, identity_signature,
         producer_ref, region_ref, vintage, attributes, approval_state, source_provenance
       FROM input
       ON CONFLICT (search_snapshot_id, canonical_entity_id) DO UPDATE SET
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
      [JSON.stringify(canonicalBatch)],
    );
  }
}

async function reconcileEntitySourceLinks(
  client: PoolClient,
  searchSnapshotId: string,
  linkRows: readonly EntitySourceLinkSyncRow[],
): Promise<void> {
  if (linkRows.length === 0) {
    await client.query(
      `DELETE FROM entity_source_links
        WHERE search_snapshot_id = $1`,
      [searchSnapshotId],
    );
    return;
  }

  const linkKeys = linkRows.map((row) => ({
    source_system: row.source_system,
    source_record_id: row.source_record_id,
  }));
  await client.query(
    `DELETE FROM entity_source_links
      WHERE search_snapshot_id = $1
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset($2::jsonb) AS rows(source_system text, source_record_id text)
          WHERE rows.source_system = entity_source_links.source_system
            AND rows.source_record_id = entity_source_links.source_record_id
        )`,
    [searchSnapshotId, JSON.stringify(linkKeys)],
  );

  for (const linkBatch of chunkArray(linkRows, CANONICAL_GRAPH_LINK_BATCH_SIZE)) {
    await client.query(
      `WITH input AS (
         SELECT *
         FROM jsonb_to_recordset($1::jsonb) AS rows(
           search_snapshot_id text,
           canonical_entity_id text,
           source_system text,
           source_record_id text,
           link_kind text,
           confidence double precision,
           approved boolean
         )
       )
       INSERT INTO entity_source_links (
         search_snapshot_id, canonical_entity_id, source_system, source_record_id, link_kind, confidence, approved
       )
       SELECT
         search_snapshot_id, canonical_entity_id, source_system, source_record_id, link_kind, confidence, approved
       FROM input
       ON CONFLICT (search_snapshot_id, source_system, source_record_id) DO UPDATE SET
         -- T-011/W3: canonical_entity_id is INTENTIONALLY NOT in the SET list.
         -- Any remap attempt is blocked pre-flight by assertSourceLinkRemapBlocked
         -- above; here we only update mutable metadata (link_kind / confidence /
         -- approved / linked_at).
         link_kind = EXCLUDED.link_kind,
         confidence = EXCLUDED.confidence,
         approved = EXCLUDED.approved,
         linked_at = NOW()`,
      [JSON.stringify(linkBatch)],
    );
  }
}

async function reconcileCanonicalAmbiguityRegistry(
  client: PoolClient,
  searchSnapshotId: string,
  ambiguityRows: readonly CanonicalAmbiguitySyncRow[],
): Promise<void> {
  await client.query(
    `DELETE FROM canonical_ambiguity_registry
      WHERE search_snapshot_id = $1`,
    [searchSnapshotId],
  );

  const serializable = ambiguityRows.map((row) => ({
    search_snapshot_id: row.search_snapshot_id,
    registry_id: row.registry_id,
    normalized_form: row.normalized_form,
    canonical_entity_ids: row.canonical_entity_ids,
    ambiguity_types: row.ambiguity_types,
    severity: row.severity,
    approval_state: row.approval_state,
  }));
  for (const ambiguityBatch of chunkArray(serializable, CANONICAL_GRAPH_AMBIGUITY_BATCH_SIZE)) {
    await client.query(
      `WITH input AS (
         SELECT *
         FROM jsonb_to_recordset($1::jsonb) AS rows(
           search_snapshot_id text,
           registry_id text,
           normalized_form text,
           canonical_entity_ids jsonb,
           ambiguity_types jsonb,
           severity text,
           approval_state text
         )
       )
       INSERT INTO canonical_ambiguity_registry (
         search_snapshot_id, registry_id, normalized_form, canonical_entity_ids, ambiguity_types, severity, approval_state
       )
       SELECT
         search_snapshot_id, registry_id, normalized_form, canonical_entity_ids, ambiguity_types, severity, approval_state
       FROM input`,
      [JSON.stringify(ambiguityBatch)],
    );
  }
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
  const canonicalBySignature = new Map<string, string>();
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
      search_snapshot_id: searchSnapshotId,
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
        ...(meta.benchmarkEntityId != null ? { benchmark_entity_id: meta.benchmarkEntityId } : {}),
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
    const existingEntityId = canonicalBySignature.get(entity.identitySignature);
    if (existingEntityId !== undefined && existingEntityId !== entity.entityId) {
      throw new Error(
        `duplicate identity_signature in snapshot batch: ${entity.identitySignature} maps to both ${existingEntityId} and ${entity.entityId}`,
      );
    }
    canonicalById.set(entity.entityId, canonicalRow);
    canonicalBySignature.set(entity.identitySignature, entity.entityId);

    linkRows.push({
      search_snapshot_id: searchSnapshotId,
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

export async function assertCanonicalEntityIdentitySignatureConsistency(
  client: Pick<PoolClient, 'query'>,
  canonicalRows: readonly CanonicalEntityGraphSyncRow[],
): Promise<void> {
  if (canonicalRows.length === 0) {
    return;
  }

  const expectedSignatureByEntityId = new Map<string, string>();
  const expectedEntityIdBySignature = new Map<string, string>();
  for (const row of canonicalRows) {
    expectedSignatureByEntityId.set(row.canonical_entity_id, row.identity_signature);
    expectedEntityIdBySignature.set(row.identity_signature, row.canonical_entity_id);
  }

  const entityIds = [...expectedSignatureByEntityId.keys()];
  const identitySignatures = [...expectedEntityIdBySignature.keys()];
  const existing = await client.query<CanonicalEntityIdentityRow>(
    `SELECT canonical_entity_id, identity_signature
     FROM canonical_identity_authority
     WHERE canonical_entity_id = ANY($1::text[])
        OR identity_signature = ANY($2::text[])
     GROUP BY canonical_entity_id, identity_signature`,
    [entityIds, identitySignatures],
  );

  for (const row of existing.rows) {
    const expectedSignature = expectedSignatureByEntityId.get(row.canonical_entity_id);
    if (expectedSignature !== undefined && expectedSignature !== row.identity_signature) {
      throw new Error(
        `canonical_entity_id ${row.canonical_entity_id} already exists with identity_signature ${row.identity_signature}; refusing to remap to ${expectedSignature}`,
      );
    }

    const expectedEntityId = expectedEntityIdBySignature.get(row.identity_signature);
    if (expectedEntityId !== undefined && expectedEntityId !== row.canonical_entity_id) {
      throw new Error(
        `identity_signature ${row.identity_signature} already belongs to canonical_entity_id ${row.canonical_entity_id}; refusing to remap to ${expectedEntityId}`,
      );
    }
  }
}

async function upsertCanonicalIdentityAuthority(
  client: Pick<PoolClient, 'query'>,
  canonicalRows: readonly CanonicalEntityGraphSyncRow[],
): Promise<void> {
  if (canonicalRows.length === 0) {
    return;
  }

  const authorityRows = canonicalRows.map((row) => ({
    identity_signature: row.identity_signature,
    canonical_entity_id: row.canonical_entity_id,
  }));
  await client.query(
    `WITH input AS (
       SELECT *
       FROM jsonb_to_recordset($1::jsonb) AS rows(
         identity_signature text,
         canonical_entity_id text
       )
     )
     INSERT INTO canonical_identity_authority (
       identity_signature,
       canonical_entity_id
     )
     SELECT
       identity_signature,
       canonical_entity_id
     FROM input
     ON CONFLICT (identity_signature) DO UPDATE SET
       canonical_entity_id = EXCLUDED.canonical_entity_id,
       updated_at = NOW()`,
    [JSON.stringify(authorityRows)],
  );
}

/**
 * T-011/W3: source link remap blocker.
 *
 * entity_source_links is now snapshot-bound, so the same
 * (source_system, source_record_id) can exist in multiple snapshots. The
 * publish path must therefore detect both:
 *   1. multiple canonical_entity_id values across any snapshots for the
 *      same source key, and
 *   2. a single existing canonical_entity_id that differs from the incoming
 *      row.
 *
 * Any of those cases is a hard fail. Operators must explicitly delete-then-
 * relink via a dedicated migration tool instead of the publish path.
 */
export async function assertSourceLinkRemapBlocked(
  client: Pick<PoolClient, 'query'>,
  linkRows: readonly { canonical_entity_id: string; source_system: string; source_record_id: string }[],
): Promise<void> {
  if (linkRows.length === 0) return;

  const keyTuples = linkRows.map((r) => ({
    system: r.source_system,
    record: r.source_record_id,
    incoming: r.canonical_entity_id,
  }));

  const rows = await client.query<{
    source_system: string;
    source_record_id: string;
    canonical_entity_ids: string[];
  }>(
    `SELECT
       source_system,
       source_record_id,
       ARRAY_AGG(DISTINCT canonical_entity_id ORDER BY canonical_entity_id) AS canonical_entity_ids
     FROM entity_source_links
     WHERE (source_system, source_record_id) IN (
       SELECT system, record
       FROM jsonb_to_recordset($1::jsonb) AS rows(system text, record text)
     )
     GROUP BY source_system, source_record_id`,
    [JSON.stringify(keyTuples.map((t) => ({ system: t.system, record: t.record })))],
  );

  for (const row of rows.rows) {
    if (row.canonical_entity_ids.length > 1) {
      throw new Error(
        `entity_source_links: source link (${row.source_system}, ${row.source_record_id}) already maps to multiple canonical_entity_id values across snapshots: ${row.canonical_entity_ids.join(', ')}. ` +
        `Use a dedicated re-link migration tool; do not re-bind through the publish path.`,
      );
    }
  }

  const existingByKey = new Map<string, string>();
  for (const row of rows.rows) {
    const existing = row.canonical_entity_ids[0];
    if (existing !== undefined) {
      existingByKey.set(`${row.source_system}|${row.source_record_id}`, existing);
    }
  }

  for (const t of keyTuples) {
    const key = `${t.system}|${t.record}`;
    const existing = existingByKey.get(key);
    if (existing !== undefined && existing !== t.incoming) {
      throw new Error(
        `entity_source_links: source link (${t.system}, ${t.record}) already maps to ` +
        `canonical_entity_id=${existing}; refusing to remap to ${t.incoming}. ` +
        `Use a dedicated re-link migration tool; do not re-bind through the publish path.`,
      );
    }
  }
}

/**
 * Exact-reconciles the canonical graph root plane from a published search
 * snapshot entity plane.
 *
 * Stale rows for the current snapshot are deleted first so cascades clear
 * orphaned child rows, then the current root rows are upserted back.
 * Caller must supply an open transaction on `client`.
 */
export async function applyCanonicalEntityGraphSync(
  client: PoolClient,
  args: ApplyCanonicalEntityGraphSyncArgs,
): Promise<void> {
  const { canonicalRows, linkRows } = buildCanonicalGraphSyncPayloads(args.entities, args.searchSnapshotId);

  await assertCanonicalRootSnapshotPlaneIntegrity(client);
  await assertCanonicalEntityIdentitySignatureConsistency(client, canonicalRows);
  await assertSourceLinkRemapBlocked(client, linkRows);
  await upsertCanonicalIdentityAuthority(client, canonicalRows);

  await reconcileCanonicalEntities(client, args.searchSnapshotId, canonicalRows);
  await reconcileEntitySourceLinks(client, args.searchSnapshotId, linkRows);
}

/**
 * Projects canonical alias / ambiguity rows into snapshot-bound immutable planes.
 * Must run after {@link applyCanonicalEntityGraphSync} (FK: canonical_aliases → canonical_entities).
 */
export async function applyCanonicalAliasAmbiguitySync(
  client: PoolClient,
  args: ApplyCanonicalAliasAmbiguitySyncArgs,
): Promise<void> {
  await assertCanonicalProjectionSnapshotPlaneIntegrity(client);

  const aliasRows = buildCanonicalAliasSyncRows(args.aliases, args.searchSnapshotId);
  await reconcileCanonicalAliases(client, args.searchSnapshotId, aliasRows);

  const ambiguityRows = buildCanonicalAmbiguitySyncRows(args.ambiguityRows, args.searchSnapshotId);
  await reconcileCanonicalAmbiguityRegistry(client, args.searchSnapshotId, ambiguityRows);
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
    searchSnapshotId: args.searchSnapshotId,
  });
}
