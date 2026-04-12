#!/usr/bin/env tsx

import fs from 'node:fs/promises';
import { loadConfig } from '../../src/config/env.js';
import { createPgPool, shouldUsePgPool } from '../../src/infrastructure/db/pg-pool.js';
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

const DEFAULT_RUNTIME_STATE_PATH = resolveDataPath('data/runtime-search-snapshot.json');
const DEFAULT_RUNTIME_NL_MAPPINGS_PATH = resolveDataPath('data/nl-mappings.json');

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
  readonly feature_schema_hash: string;
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
  const config = loadConfig();
  if (!shouldUsePgPool(config.pg)) {
    throw new Error('Postgres configuration is required to publish runtime substrates');
  }

  const [entities, aliases, ambiguityRows, nlMappingsRaw] = await Promise.all([
    loadEntities(manifest),
    loadAliases(manifest),
    loadAmbiguityRows(manifest),
    fs.readFile(manifest.artifacts.nlMappingsJson, 'utf8'),
  ]);
  const previousRuntimeNlMappings = await readOptionalFile(args.runtimeNlMappingsPath);

  if (entities.length === 0) {
    throw new Error('Refusing to publish runtime substrates with zero entities');
  }
  if (aliases.length === 0) {
    throw new Error('Refusing to publish runtime substrates with zero aliases');
  }
  if (ambiguityRows.length === 0) {
    throw new Error('Refusing to publish runtime substrates with zero ambiguity rows');
  }

  const pool = createPgPool(config.pg);
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
      await client.query('TRUNCATE TABLE aliases');
      await client.query('TRUNCATE TABLE ambiguity_registry');
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
         ON CONFLICT (entity_id) DO UPDATE SET
           search_snapshot_id = EXCLUDED.search_snapshot_id,
           entity_type = EXCLUDED.entity_type,
           canonical_label = EXCLUDED.canonical_label,
           identity_signature = EXCLUDED.identity_signature,
           relations = EXCLUDED.relations,
           attributes = EXCLUDED.attributes,
           metadata = EXCLUDED.metadata,
           updated_at = NOW()`,
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
         ON CONFLICT (snapshot_id) DO UPDATE SET
           entity_id = EXCLUDED.entity_id,
           snapshot_data = EXCLUDED.snapshot_data`,
        [entitySnapshotRowsJson],
      );
      await client.query(
        `DELETE FROM entity_snapshots
         WHERE NOT (entity_id = ANY($1::text[]))`,
        [entityIds],
      );
      await client.query(
        `DELETE FROM entities
         WHERE NOT (entity_id = ANY($1::text[]))`,
        [entityIds],
      );
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
         FROM input`,
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
         FROM input`,
        [ambiguityRowsJson],
      );

      await applyFullCanonicalGraphSync(client, {
        entities,
        aliases,
        ambiguityRows,
        searchSnapshotId: manifest.snapshotId,
      });

      const ltrActiveResult = await client.query<{
        count: string;
        query_class: string;
        model_version: number;
        eval_dataset_version: string;
        feature_schema_hash: string;
        weights: number[];
        bias: number;
      }>(
        `SELECT
           COUNT(*) OVER()::text AS count,
           query_class,
           model_version,
           eval_dataset_version,
           feature_schema_hash,
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

      await atomicWriteFile(args.runtimeNlMappingsPath, nlMappingsRaw);
      const runtimeNlMappingsCount = await loadNlMappingsCount(args.runtimeNlMappingsPath);
      const state: SearchSnapshotRuntimeState = {
        schemaVersion: SEARCH_SNAPSHOT_STATE_VERSION,
        snapshotId: manifest.snapshotId,
        contentHash: manifest.contentHash,
        publishedAt: new Date().toISOString(),
        manifestPath: args.manifestPath,
        nlMappingsRuntimePath: args.runtimeNlMappingsPath,
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
        await restoreRuntimeNlMappings(args.runtimeNlMappingsPath, previousRuntimeNlMappings);
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
  const state = await publishRuntimeSubstrates(args);
  console.log(`Published runtime substrates for ${state.snapshotId}`);
  console.log(`runtime_state=${args.runtimeStatePath}`);
  console.log(`runtime_nl_mappings=${args.runtimeNlMappingsPath}`);
  console.log(`entities=${state.counts.entities}`);
  console.log(`aliases=${state.counts.aliases}`);
  console.log(`ambiguity_registry=${state.counts.ambiguityRegistry}`);
  console.log(`nl_mappings=${state.counts.nlMappings}`);
  console.log(`active_ltr_models=${state.counts.activeLtrModels}`);
  console.log(`allow_missing_ltr=${state.allowMissingLtr}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${message}`);
    process.exit(1);
  });
}
