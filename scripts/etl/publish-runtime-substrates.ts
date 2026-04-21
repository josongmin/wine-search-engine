#!/usr/bin/env tsx

import fs from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { loadConfig } from '../../src/config/env.js';
import { createPgPool, shouldUsePgPool } from '../../src/infrastructure/db/pg-pool.js';
import { loadSearchSnapshotRuntimeState } from '../../src/infrastructure/health/search-snapshot-readiness.js';
import { atomicWriteFile } from './etl-utils.js';
import { parseNdjson } from './ndjson.js';
import {
  type AliasSnapshotRecord,
  type AmbiguityRegistrySnapshotRow,
  type EntitySnapshotRecord,
  type SearchSnapshotManifest,
  type SearchSnapshotRuntimeState,
  hashStableJson,
  parseManifest,
} from './search-snapshot-schema.js';
import { SEARCH_SNAPSHOT_STATE_VERSION } from '../../src/shared/constants/search-snapshot.js';
import { resolveDataPath } from '../../src/shared/utils/data-paths.js';
import { applyFullCanonicalGraphSync } from './canonical-entity-graph-sync.js';
import { pgTableHasColumn } from '../../src/infrastructure/db/pg-schema-capabilities.js';

const DEFAULT_RUNTIME_STATE_PATH = resolveDataPath('data/runtime-search-snapshot.json');
const DEFAULT_RUNTIME_NL_MAPPINGS_PATH = resolveDataPath('data/nl-mappings.json');
const RUNTIME_SUBSTRATE_PUBLISH_STATEMENT_TIMEOUT_MS = 5 * 60_000;

interface Args {
  readonly manifestPath: string;
  readonly runtimeStatePath: string;
  readonly runtimeNlMappingsPath: string;
  readonly allowMissingLtr: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let manifestPath = '';
  let runtimeStatePath = DEFAULT_RUNTIME_STATE_PATH;
  let runtimeNlMappingsPath = DEFAULT_RUNTIME_NL_MAPPINGS_PATH;
  let allowMissingLtr = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--manifest' || arg === '-m') {
      manifestPath = argv[i + 1] ?? '';
      i += 1;
    } else if (arg === '--runtime-state') {
      runtimeStatePath = argv[i + 1] ?? DEFAULT_RUNTIME_STATE_PATH;
      i += 1;
    } else if (arg === '--runtime-nl-mappings') {
      runtimeNlMappingsPath = argv[i + 1] ?? DEFAULT_RUNTIME_NL_MAPPINGS_PATH;
      i += 1;
    } else if (arg === '--allow-missing-ltr') {
      allowMissingLtr = true;
    }
  }
  if (manifestPath.length === 0) {
    throw new Error('--manifest is required');
  }
  return { manifestPath, runtimeStatePath, runtimeNlMappingsPath, allowMissingLtr };
}

function buildSnapshotArtifactPath(basePath: string, snapshotId: string): string {
  const ext = path.extname(basePath);
  const stem = ext.length > 0 ? basePath.slice(0, -ext.length) : basePath;
  return `${stem}.${snapshotId}${ext}`;
}

function buildStagingPath(activePath: string, snapshotId: string): string {
  const ext = path.extname(activePath);
  const base = ext.length > 0 ? activePath.slice(0, -ext.length) : activePath;
  return `${base}.${snapshotId}.staging${ext}`;
}

export interface RuntimeSubstrateCutoverPaths {
  readonly stagedRuntimeStatePath: string;
  readonly activeRuntimeStatePath: string;
  readonly stagedRuntimeNlMappingsPath: string;
  readonly activeRuntimeNlMappingsPath: string;
}

export function resolveRuntimeSubstrateCutoverPaths(args: {
  readonly snapshotId: string;
  readonly runtimeStatePath: string;
  readonly runtimeNlMappingsPath: string;
}): RuntimeSubstrateCutoverPaths {
  return {
    stagedRuntimeStatePath: buildStagingPath(args.runtimeStatePath, args.snapshotId),
    activeRuntimeStatePath: args.runtimeStatePath,
    // NL mappings are already written as snapshot-bound artifacts during publish.
    stagedRuntimeNlMappingsPath: buildSnapshotArtifactPath(args.runtimeNlMappingsPath, args.snapshotId),
    activeRuntimeNlMappingsPath: args.runtimeNlMappingsPath,
  };
}

async function promoteStagedFile(stagingPath: string, activePath: string): Promise<void> {
  const raw = await fs.readFile(stagingPath, 'utf8');
  await atomicWriteFile(activePath, raw);
  await fs.rm(stagingPath, { force: true });
}

export async function promoteRuntimeSubstrateArtifacts(args: {
  readonly stagedRuntimeStatePath: string;
  readonly activeRuntimeStatePath: string;
  readonly stagedRuntimeNlMappingsPath: string;
  readonly activeRuntimeNlMappingsPath: string;
}): Promise<SearchSnapshotRuntimeState> {
  const stagedState = await loadSearchSnapshotRuntimeState(args.stagedRuntimeStatePath);
  const activeState: SearchSnapshotRuntimeState = {
    ...stagedState,
    nlMappingsRuntimePath: args.activeRuntimeNlMappingsPath,
  };

  await atomicWriteFile(args.stagedRuntimeStatePath, `${JSON.stringify(activeState, null, 2)}\n`);
  await promoteStagedFile(args.stagedRuntimeNlMappingsPath, args.activeRuntimeNlMappingsPath);
  await promoteStagedFile(args.stagedRuntimeStatePath, args.activeRuntimeStatePath);
  return activeState;
}

export async function restoreRuntimeSubstrateArtifacts(args: {
  readonly activeRuntimeStatePath: string;
  readonly previousRuntimeStateContents: string | undefined;
  readonly activeRuntimeNlMappingsPath: string;
  readonly previousRuntimeNlMappingsContents: string | undefined;
}): Promise<void> {
  if (args.previousRuntimeNlMappingsContents === undefined) {
    await fs.rm(args.activeRuntimeNlMappingsPath, { force: true });
  } else {
    await atomicWriteFile(args.activeRuntimeNlMappingsPath, args.previousRuntimeNlMappingsContents);
  }

  if (args.previousRuntimeStateContents === undefined) {
    await fs.rm(args.activeRuntimeStatePath, { force: true });
  } else {
    await atomicWriteFile(args.activeRuntimeStatePath, args.previousRuntimeStateContents);
  }
}

async function loadManifest(manifestPath: string): Promise<SearchSnapshotManifest> {
  const raw = await fs.readFile(manifestPath, 'utf8');
  return parseManifest(raw, manifestPath);
}

async function loadAliases(manifest: SearchSnapshotManifest): Promise<readonly AliasSnapshotRecord[]> {
  const raw = await fs.readFile(manifest.artifacts.aliasesNdjson, 'utf8');
  return parseNdjson<AliasSnapshotRecord>(raw, manifest.artifacts.aliasesNdjson).records;
}

async function loadEntities(manifest: SearchSnapshotManifest): Promise<readonly EntitySnapshotRecord[]> {
  const raw = await fs.readFile(manifest.artifacts.entitiesNdjson, 'utf8');
  return parseNdjson<EntitySnapshotRecord>(raw, manifest.artifacts.entitiesNdjson).records;
}

async function loadAmbiguityRows(manifest: SearchSnapshotManifest): Promise<readonly AmbiguityRegistrySnapshotRow[]> {
  const raw = await fs.readFile(manifest.artifacts.ambiguityRegistryNdjson, 'utf8');
  return parseNdjson<AmbiguityRegistrySnapshotRow>(raw, manifest.artifacts.ambiguityRegistryNdjson).records;
}

async function loadNlMappingsCount(runtimePath: string): Promise<number> {
  const raw = await fs.readFile(runtimePath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as Record<string, unknown>)['mappings'])) {
    return 0;
  }
  return ((parsed as Record<string, unknown>)['mappings'] as unknown[]).length;
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function restoreRuntimeNlMappings(
  runtimePath: string,
  previousContents: string | undefined,
): Promise<void> {
  if (previousContents === undefined) {
    await fs.rm(runtimePath, { force: true });
    return;
  }
  await atomicWriteFile(runtimePath, previousContents);
}

function buildEntityRowsJson(
  entities: readonly EntitySnapshotRecord[],
  searchSnapshotId: string,
): string {
  return JSON.stringify(entities.map((entity) => ({
    entity_id: entity.entityId,
    search_snapshot_id: searchSnapshotId,
    entity_type: entity.entityType,
    canonical_label: entity.canonicalLabel,
    identity_signature: entity.identitySignature,
    relations: entity.relations,
    attributes: entity.attributes,
    metadata: entity.metadata,
  })));
}

interface EntityIdentityRow {
  readonly entity_id: string;
  readonly identity_signature: string;
}

type LearnedFacetCoverage = {
  readonly giftSuitabilityScore: number;
  readonly beginnerSuitabilityScore: number;
};

function emptyLearnedFacetCoverage(): LearnedFacetCoverage {
  return {
    giftSuitabilityScore: 0,
    beginnerSuitabilityScore: 0,
  };
}

export function collectLearnedFacetCoverageFromEntities(
  entities: readonly EntitySnapshotRecord[],
): LearnedFacetCoverage {
  const coverage = emptyLearnedFacetCoverage();
  for (const entity of entities) {
    if (entity.attributes['giftSuitabilityScore'] != null) {
      coverage.giftSuitabilityScore += 1;
    }
    if (entity.attributes['beginnerSuitabilityScore'] != null) {
      coverage.beginnerSuitabilityScore += 1;
    }
  }
  return coverage;
}

export function assertLearnedFacetCoverageForPublish(
  coverage: LearnedFacetCoverage,
  source: string,
  snapshotId: string,
  total: number,
): void {
  const missing: string[] = [];
  if (coverage.giftSuitabilityScore !== total) {
    missing.push(`giftSuitabilityScore=${coverage.giftSuitabilityScore}/${total}`);
  }
  if (coverage.beginnerSuitabilityScore !== total) {
    missing.push(`beginnerSuitabilityScore=${coverage.beginnerSuitabilityScore}/${total}`);
  }
  if (missing.length === 0) {
    return;
  }
  throw new Error(
    `Snapshot ${snapshotId} is missing learned facet coverage in ${source}: ${missing.join(', ')}`,
  );
}

export async function assertSnapshotArtifactLearnedFacetCoverage(
  manifest: Pick<SearchSnapshotManifest, 'snapshotId' | 'artifacts'>,
): Promise<LearnedFacetCoverage> {
  const raw = await fs.readFile(manifest.artifacts.entitiesNdjson, 'utf8');
  const entities = parseNdjson<EntitySnapshotRecord>(raw, manifest.artifacts.entitiesNdjson).records;
  const coverage = collectLearnedFacetCoverageFromEntities(entities);
  assertLearnedFacetCoverageForPublish(
    coverage,
    'entities artifact',
    manifest.snapshotId,
    entities.length,
  );
  return coverage;
}

export async function assertEntityIdentitySignatureConsistency(
  client: Pick<PoolClient, 'query'>,
  entities: readonly EntitySnapshotRecord[],
): Promise<void> {
  if (entities.length === 0) {
    return;
  }

  const signatureByEntityId = new Map<string, string>();
  const entityIdBySignature = new Map<string, string>();
  for (const entity of entities) {
    const existingSignature = signatureByEntityId.get(entity.entityId);
    if (existingSignature !== undefined && existingSignature !== entity.identitySignature) {
      throw new Error(
        `entity_id ${entity.entityId} already maps to identity_signature ${existingSignature}; refusing to remap to ${entity.identitySignature}`,
      );
    }
    const existingEntityId = entityIdBySignature.get(entity.identitySignature);
    if (existingEntityId !== undefined && existingEntityId !== entity.entityId) {
      throw new Error(
        `identity_signature ${entity.identitySignature} already belongs to entity_id ${existingEntityId}; refusing to remap to ${entity.entityId}`,
      );
    }
    signatureByEntityId.set(entity.entityId, entity.identitySignature);
    entityIdBySignature.set(entity.identitySignature, entity.entityId);
  }

  const entityIds = [...signatureByEntityId.keys()];
  const identitySignatures = [...entityIdBySignature.keys()];
  const existing = await client.query<EntityIdentityRow>(
    `SELECT entity_id, identity_signature
     FROM entities
     WHERE entity_id = ANY($1::text[])
        OR identity_signature = ANY($2::text[])`,
    [entityIds, identitySignatures],
  );

  for (const row of existing.rows) {
    const expectedSignature = signatureByEntityId.get(row.entity_id);
    if (expectedSignature !== undefined && expectedSignature !== row.identity_signature) {
      throw new Error(
        `entity_id ${row.entity_id} already exists with identity_signature ${row.identity_signature}; refusing to remap to ${expectedSignature}`,
      );
    }

    const expectedEntityId = entityIdBySignature.get(row.identity_signature);
    if (expectedEntityId !== undefined && expectedEntityId !== row.entity_id) {
      throw new Error(
        `identity_signature ${row.identity_signature} already belongs to entity_id ${row.entity_id}; refusing to remap to ${expectedEntityId}`,
      );
    }
  }
}

/**
 * T-010/W1: Refuse to re-publish the same snapshot_id.
 *
 * Snapshot ids are immutable once the active pointer has been flipped to
 * them. A second publish run with the same snapshot_id would silently no-op
 * every INSERT (due to ON CONFLICT DO NOTHING) and the operator would
 * mistake "nothing happened" for success. Fail loudly instead.
 *
 * An idempotent re-run of a FAILED publish (pointer not yet promoted) must
 * use a fresh snapshot_id. The cheapest way is to re-run the manifest
 * pipeline which re-generates snapshot_id from content hash.
 */
export async function assertSnapshotNotAlreadyPublished(
  client: Pick<PoolClient, 'query'>,
  snapshotId: string,
): Promise<void> {
  const res = await client.query<{ active_snapshot_id: string; previous_snapshot_id: string | null }>(
    `SELECT active_snapshot_id, previous_snapshot_id FROM active_search_snapshot WHERE id = 1`,
  );
  const row = res.rows[0];
  if (row === undefined) {
    // First publish — pointer row does not exist yet. publish-search-snapshot
    // will INSERT the row as part of the atomic promote step.
    return;
  }
  if (row.active_snapshot_id === snapshotId) {
    throw new Error(
      `Snapshot ${snapshotId} is already the active snapshot; refusing to re-publish. ` +
      `Use a fresh snapshot_id (re-run manifest) or rollback first.`,
    );
  }
  // Previous snapshot can re-appear (rollback → re-publish). No error there.
}

function buildEntitySnapshotRowsJson(
  entities: readonly EntitySnapshotRecord[],
  snapshotId: string,
  generatedAt: string,
): string {
  return JSON.stringify(entities.map((entity) => ({
    snapshot_id: `${snapshotId}:${entity.entityId}`,
    entity_id: entity.entityId,
    snapshot_data: {
      entity_id: entity.entityId,
      entity_type: entity.entityType,
      canonical_label: entity.canonicalLabel,
      identity_signature: entity.identitySignature,
      relations: entity.relations,
      attributes: entity.attributes,
      metadata: entity.metadata,
      created_at: generatedAt,
      updated_at: generatedAt,
    },
  })));
}

function buildAliasRowsJson(
  aliases: readonly AliasSnapshotRecord[],
  searchSnapshotId: string,
): string {
  return JSON.stringify(aliases.map((alias) => ({
    alias_id: alias.aliasId,
    search_snapshot_id: searchSnapshotId,
    entity_id: alias.entityId,
    alias_type: alias.type,
    alias_scope: alias.scope,
    surface_form: alias.value,
    normalized_value: alias.normalizedValue,
    source: alias.source,
    source_trust: alias.sourceTrust,
    confidence: alias.confidencePrior,
  })));
}

function buildAmbiguityRowsJson(
  rows: readonly AmbiguityRegistrySnapshotRow[],
  searchSnapshotId: string,
): string {
  return JSON.stringify(rows.map((row) => ({
    registry_id: row.registryId,
    search_snapshot_id: searchSnapshotId,
    normalized_form: row.normalizedForm,
    entity_ids: row.entityIds,
    ambiguity_types: row.ambiguityTypes,
    severity: row.severity,
  })));
}

function buildActiveLtrModelHash(rows: readonly {
  readonly query_class: string;
  readonly model_version: number;
  readonly eval_dataset_version: string;
  readonly feature_schema_hash: string | null;
  readonly weights: readonly number[];
  readonly bias: number;
}[]): string {
  return hashStableJson(
    [...rows].sort((left, right) =>
      left.query_class.localeCompare(right.query_class)
      || left.model_version - right.model_version,
    ),
  );
}

export async function publishRuntimeSubstrates(args: Args): Promise<SearchSnapshotRuntimeState> {
  const manifest = await loadManifest(args.manifestPath);
  await assertSnapshotArtifactLearnedFacetCoverage(manifest);
  const config = loadConfig();
  if (!shouldUsePgPool(config.pg)) {
    throw new Error('Postgres configuration is required to publish runtime substrates');
  }
  const runtimeNlMappingsPath = buildSnapshotArtifactPath(args.runtimeNlMappingsPath, manifest.snapshotId);

  const [entities, aliases, ambiguityRows, nlMappingsRaw] = await Promise.all([
    loadEntities(manifest),
    loadAliases(manifest),
    loadAmbiguityRows(manifest),
    fs.readFile(manifest.artifacts.nlMappingsJson, 'utf8'),
  ]);
  const previousRuntimeNlMappings = await readOptionalFile(runtimeNlMappingsPath);

  if (entities.length === 0) {
    throw new Error('Refusing to publish runtime substrates with zero entities');
  }
  if (aliases.length === 0) {
    throw new Error('Refusing to publish runtime substrates with zero aliases');
  }

  const pool = createPgPool(config.pg, {
    statementTimeoutMs: RUNTIME_SUBSTRATE_PUBLISH_STATEMENT_TIMEOUT_MS,
    idleInTransactionSessionTimeoutMs: RUNTIME_SUBSTRATE_PUBLISH_STATEMENT_TIMEOUT_MS,
    queryTimeoutMs: RUNTIME_SUBSTRATE_PUBLISH_STATEMENT_TIMEOUT_MS + 5_000,
  });
  try {
    const client = await pool.connect();
    let committed = false;
    try {
      const entityRowsJson = buildEntityRowsJson(entities, manifest.snapshotId);
      const entitySnapshotRowsJson = buildEntitySnapshotRowsJson(
        entities,
        manifest.snapshotId,
        manifest.generatedAt,
      );
      const aliasRowsJson = buildAliasRowsJson(aliases, manifest.snapshotId);
      const ambiguityRowsJson = buildAmbiguityRowsJson(ambiguityRows, manifest.snapshotId);
      const entityIds = entities.map((entity) => entity.entityId);

      await client.query('BEGIN');
      await assertEntityIdentitySignatureConsistency(client, entities);
      // T-010/W1: Snapshot-bound append-only publish.
      // No TRUNCATE/DELETE — old snapshot rows stay in place so rollback is
      // a pointer-swap only (see active_search_snapshot). Read path filters
      // by the active snapshot_id. Old snapshots are reaped by a separate
      // GC step after the pointer has been promoted off of them.
      await assertSnapshotNotAlreadyPublished(client, manifest.snapshotId);
      await client.query(
        `WITH input AS (
           SELECT *
         FROM jsonb_to_recordset($1::jsonb) AS rows(
             entity_id text,
             search_snapshot_id text,
             entity_type text,
             canonical_label text,
             identity_signature text,
             relations jsonb,
             attributes jsonb,
             metadata jsonb
           )
         )
         INSERT INTO entities (
           entity_id, search_snapshot_id, entity_type, canonical_label, identity_signature,
           relations, attributes, metadata
         )
         SELECT
           entity_id, search_snapshot_id, entity_type, canonical_label, identity_signature,
           relations, attributes, metadata
         FROM input
         -- Composite PK conflict target (migration 016). Re-publishing the same
         -- snapshot is idempotent; cross-snapshot writes append new rows without
         -- touching other snapshots' data.
         ON CONFLICT (search_snapshot_id, entity_id) DO NOTHING`,
        [entityRowsJson],
      );
      await client.query(
        `WITH input AS (
           SELECT *
           FROM jsonb_to_recordset($1::jsonb) AS rows(
             snapshot_id text,
             entity_id text,
             snapshot_data jsonb
           )
         )
         INSERT INTO entity_snapshots (snapshot_id, entity_id, snapshot_data)
         SELECT snapshot_id, entity_id, snapshot_data
         FROM input
         -- Archive is append-only. Rewriting an existing archive row indicates
         -- a publisher bug, not an idempotent retry. If this path starts throwing
         -- in production, debug the publisher — don't re-enable DO UPDATE.
         ON CONFLICT (snapshot_id) DO NOTHING`,
        [entitySnapshotRowsJson],
      );
      // T-010/W1: No cleanup DELETE. Old-snapshot rows remain in place for
      // rollback. A separate GC step (ops: reap-snapshots) removes rows whose
      // search_snapshot_id is older than active+previous after the pointer
      // swap has been green for a grace period.
      void entityIds; // retained for readability; no longer used as a cleanup filter
      await client.query(
        `WITH input AS (
           SELECT *
           FROM jsonb_to_recordset($1::jsonb) AS rows(
             alias_id text,
             search_snapshot_id text,
             entity_id text,
             alias_type text,
             alias_scope text,
             surface_form text,
             normalized_value text,
             source text,
             source_trust double precision,
             confidence double precision
           )
         )
         INSERT INTO aliases (
           alias_id, search_snapshot_id, entity_id, alias_type, alias_scope, surface_form,
           normalized_value, source, source_trust, confidence, is_suppressed
         )
         SELECT
           alias_id, search_snapshot_id, entity_id, alias_type, alias_scope, surface_form,
           normalized_value, source, source_trust, confidence, FALSE
         FROM input
         -- Composite PK conflict target (migration 016).
         ON CONFLICT (search_snapshot_id, alias_id) DO NOTHING`,
        [aliasRowsJson],
      );
      await client.query(
        `WITH input AS (
           SELECT *
           FROM jsonb_to_recordset($1::jsonb) AS rows(
             registry_id text,
             search_snapshot_id text,
             normalized_form text,
             entity_ids jsonb,
             ambiguity_types jsonb,
             severity text
           )
         )
         INSERT INTO ambiguity_registry (
           registry_id, search_snapshot_id, normalized_form, entity_ids, ambiguity_types, severity
         )
         SELECT
           registry_id,
           search_snapshot_id,
           normalized_form,
           ARRAY(SELECT jsonb_array_elements_text(entity_ids)),
           ARRAY(SELECT jsonb_array_elements_text(ambiguity_types)),
           severity
         FROM input
         -- Composite PK conflict target (migration 016).
         ON CONFLICT (search_snapshot_id, registry_id) DO NOTHING`,
        [ambiguityRowsJson],
      );

      await applyFullCanonicalGraphSync(client, {
        entities,
        aliases,
        ambiguityRows,
        searchSnapshotId: manifest.snapshotId,
      });

      const ltrFeatureSchemaHashSupported = await pgTableHasColumn(
        pool,
        'ltr_model_registry',
        'feature_schema_hash',
      );
      const ltrActiveResult = await client.query<{
        count: string;
        query_class: string;
        model_version: number;
        eval_dataset_version: string;
        feature_schema_hash: string | null;
        weights: number[];
        bias: number;
      }>(
        ltrFeatureSchemaHashSupported
          ? `SELECT
               COUNT(*) OVER()::text AS count,
               query_class,
               model_version,
               eval_dataset_version,
               feature_schema_hash,
               weights,
               bias
             FROM ltr_model_registry
             WHERE is_active = TRUE AND search_snapshot_id = $1
             ORDER BY query_class ASC, model_version ASC`
          : `SELECT
               COUNT(*) OVER()::text AS count,
               query_class,
               model_version,
               eval_dataset_version,
               NULL::text AS feature_schema_hash,
               weights,
               bias
             FROM ltr_model_registry
             WHERE is_active = TRUE AND search_snapshot_id = $1
             ORDER BY query_class ASC, model_version ASC`,
        [manifest.snapshotId],
      );
      const activeLtrModels = Number(ltrActiveResult.rows[0]?.count ?? '0');
      if (activeLtrModels <= 0 && !args.allowMissingLtr) {
        throw new Error('Refusing to publish runtime substrates with zero active LTR models (pass --allow-missing-ltr only for explicit no-LTR mode)');
      }
      const activeLtrHash = buildActiveLtrModelHash(
        ltrActiveResult.rows.map((row) => ({
          query_class: row.query_class,
          model_version: row.model_version,
          eval_dataset_version: row.eval_dataset_version,
          feature_schema_hash: row.feature_schema_hash,
          weights: row.weights,
          bias: row.bias,
        })),
      );

      await atomicWriteFile(runtimeNlMappingsPath, nlMappingsRaw);
      const runtimeNlMappingsCount = await loadNlMappingsCount(runtimeNlMappingsPath);
      const state: SearchSnapshotRuntimeState = {
        schemaVersion: SEARCH_SNAPSHOT_STATE_VERSION,
        snapshotId: manifest.snapshotId,
        contentHash: manifest.contentHash,
        publishedAt: new Date().toISOString(),
        manifestPath: args.manifestPath,
        nlMappingsRuntimePath: runtimeNlMappingsPath,
        allowMissingLtr: args.allowMissingLtr,
        counts: {
          entities: entities.length,
          aliases: aliases.length,
          ambiguityRegistry: ambiguityRows.length,
          nlMappings: runtimeNlMappingsCount,
          activeLtrModels,
        },
        hashes: {
          entities: manifest.hashes.entities,
          aliases: manifest.hashes.aliases,
          ambiguityRegistry: manifest.hashes.ambiguityRegistry,
          nlMappings: manifest.hashes.nlMappings,
          activeLtrModels: activeLtrHash,
        },
      };
      await atomicWriteFile(args.runtimeStatePath, `${JSON.stringify(state, null, 2)}\n`);
      await client.query('COMMIT');
      committed = true;
      return state;
    } catch (error) {
      if (!committed) {
        await client.query('ROLLBACK');
        await restoreRuntimeNlMappings(runtimeNlMappingsPath, previousRuntimeNlMappings);
      }
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const previousRuntimeStateContents = await readOptionalFile(args.runtimeStatePath);
  const previousRuntimeNlMappingsContents = await readOptionalFile(args.runtimeNlMappingsPath);
  const manifest = await loadManifest(args.manifestPath);
  const cutoverPaths = resolveRuntimeSubstrateCutoverPaths({
    snapshotId: manifest.snapshotId,
    runtimeStatePath: args.runtimeStatePath,
    runtimeNlMappingsPath: args.runtimeNlMappingsPath,
  });
  await publishRuntimeSubstrates({
    ...args,
    runtimeStatePath: cutoverPaths.stagedRuntimeStatePath,
    runtimeNlMappingsPath: args.runtimeNlMappingsPath,
  });
  try {
    const promotedState = await promoteRuntimeSubstrateArtifacts(cutoverPaths);
    console.log(`Published runtime substrates for ${promotedState.snapshotId}`);
    console.log(`runtime_state=${args.runtimeStatePath}`);
    console.log(`runtime_nl_mappings=${args.runtimeNlMappingsPath}`);
    console.log(`entities=${promotedState.counts.entities}`);
    console.log(`aliases=${promotedState.counts.aliases}`);
    console.log(`ambiguity_registry=${promotedState.counts.ambiguityRegistry}`);
    console.log(`nl_mappings=${promotedState.counts.nlMappings}`);
    console.log(`active_ltr_models=${promotedState.counts.activeLtrModels}`);
    console.log(`allow_missing_ltr=${promotedState.allowMissingLtr}`);
  } catch (error) {
    try {
      await restoreRuntimeSubstrateArtifacts({
        activeRuntimeStatePath: args.runtimeStatePath,
        previousRuntimeStateContents,
        activeRuntimeNlMappingsPath: args.runtimeNlMappingsPath,
        previousRuntimeNlMappingsContents,
      });
    } catch (restoreError) {
      const publishMessage = error instanceof Error ? error.message : String(error);
      const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
      throw new Error(`runtime substrate publish failed: ${publishMessage}; restore failed: ${restoreMessage}`);
    }
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${message}`);
    process.exit(1);
  });
}
