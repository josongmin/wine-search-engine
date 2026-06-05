#!/usr/bin/env tsx

import fs from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { loadConfig } from '../../src/config/env.js';
import { isLtrServingEnabled } from '../../src/config/ltr-serving-mode.js';
import { createPgPool, shouldUsePgPool } from '../../src/infrastructure/db/pg-pool.js';
import { loadSearchSnapshotRuntimeState } from '../../src/infrastructure/health/search-snapshot-readiness.js';
import { atomicWriteFile, chunkArray } from './etl-utils.js';
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
import { SEARCH_SNAPSHOT_STATE_VERSION } from '../../src/domain/shared/constants/search-snapshot.js';
import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';
import {
  buildLookupAliasRuntimeArtifactHash,
  buildLookupAmbiguityRuntimeArtifactHash,
  buildLookupConceptRedirectRuntimeArtifactHash,
  buildLookupExactSafeRuntimeArtifactHash,
  buildLookupResolverProjectionArtifactHash,
  buildLookupEntityProjectionArtifactHash,
  parseLookupAliasRuntimeArtifact,
  parseLookupAmbiguityRuntimeArtifact,
  parseLookupConceptRedirectRuntimeArtifact,
  parseLookupExactSafeRuntimeArtifact,
  parseLookupResolverProjectionArtifact,
  parseLookupEntityProjectionArtifact,
} from '../../src/domain/shared/types/search-snapshot-lookup-runtime.js';
import { applyFullCanonicalGraphSync } from './canonical-entity-graph-sync.js';
import { pgTableHasColumn } from '../../src/infrastructure/db/pg-schema-capabilities.js';
import { createRuntimeSubstratePublishStateMachine } from './runtime-substrate-publish-state-machine.js';

const DEFAULT_RUNTIME_STATE_PATH = resolveDataPath('data/runtime-search-snapshot.json');
const DEFAULT_RUNTIME_NL_MAPPINGS_PATH = resolveDataPath('data/nl-mappings.json');
const RUNTIME_SUBSTRATE_PUBLISH_STATEMENT_TIMEOUT_MS = 5 * 60_000;
const RUNTIME_SUBSTRATE_PUBLISH_ADVISORY_LOCK_KEY = 864_209_317;
const RUNTIME_SUBSTRATE_ENTITY_STAGE_BATCH_SIZE = 2_000;
// Alias batches dominate runtime substrate publish cost. At ~80k aliases, a
// 2k-row jsonb_to_recordset statement held the transaction open for >1 minute
// per batch on the live publish path, eventually tripping publish-time limits.
// Keep entity batches large, but bound alias stage batches so each statement
// stays comfortably below the publish timeout budget.
const RUNTIME_SUBSTRATE_ALIAS_STAGE_BATCH_SIZE = 500;
const RUNTIME_SUBSTRATE_AMBIGUITY_STAGE_BATCH_SIZE = 1_000;

// ---------------------------------------------------------------------------
// Runtime substrate freshness / version constants
//
// These constants drive the maturity-3 contract for runtime substrate
// distribution: every published artifact advertises its schema identity
// (`SUBSTRATE_VERSION_PREFIX`) and a deterministic freshness window
// (`RUNTIME_SUBSTRATE_TTL_SECONDS`).
//
// The TTL is expressed in SECONDS because Redis EXPIRE and CDN Cache-Control
// both consume seconds. Do NOT switch units silently — `RUNTIME_SUBSTRATE_TTL_SECONDS`
// is grep-able and pinned by a regression test.
// ---------------------------------------------------------------------------
const SECONDS_PER_HOUR = 3600;
const HOURS_PER_DAY = 24;
const RUNTIME_SUBSTRATE_TTL_DAYS = 7;
export const RUNTIME_SUBSTRATE_TTL_SECONDS =
  RUNTIME_SUBSTRATE_TTL_DAYS * HOURS_PER_DAY * SECONDS_PER_HOUR;
export const SUBSTRATE_VERSION_PREFIX = 'runtime-substrate.v1' as const;

export type RuntimeSubstrateKind = 'aliases' | 'nl-mappings' | 'ambiguity-registry' | 'drinking-window';

export interface RuntimeSubstrateArtifactEnvelope {
  readonly schema_version: string;
  readonly snapshot_id: string;
  readonly generated_at: string;
  readonly ttl_seconds: number;
  readonly kind: RuntimeSubstrateKind;
  readonly sample?: string;
}

/**
 * Build the artifact envelope attached to every published runtime substrate.
 *
 * The envelope carries:
 *  - `schema_version`: `${SUBSTRATE_VERSION_PREFIX}:${snapshotId}` — the
 *    snapshot id acts as the version-increment suffix, so a fresh publish
 *    deterministically yields a fresh schema_version (cache-busting key).
 *  - `ttl_seconds`: the freshness window in seconds (named constant).
 *  - `generated_at`: ISO-8601 timestamp; rejected if not parseable.
 *  - `kind`: which substrate this envelope describes.
 *  - `sample` (optional): caller-supplied content, normalized to NFC so
 *    Korean (precomposed) and accented Latin survive the round trip.
 */
export function buildRuntimeSubstrateArtifactEnvelope(args: {
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly kind: RuntimeSubstrateKind;
  readonly sample?: string;
}): RuntimeSubstrateArtifactEnvelope {
  const parsed = new Date(args.generatedAt).getTime();
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `Invalid generated_at timestamp: "${args.generatedAt}" is not parseable as ISO-8601`,
    );
  }
  const base = {
    schema_version: `${SUBSTRATE_VERSION_PREFIX}:${args.snapshotId}`,
    snapshot_id: args.snapshotId,
    generated_at: args.generatedAt,
    ttl_seconds: RUNTIME_SUBSTRATE_TTL_SECONDS,
    kind: args.kind,
  } as const;
  // Conditional spread to respect exactOptionalPropertyTypes — omit `sample`
  // entirely when not supplied rather than setting it to `undefined`.
  return args.sample === undefined
    ? base
    : { ...base, sample: args.sample.normalize('NFC') };
}

interface Args {
  readonly manifestPath: string;
  readonly runtimeStatePath: string;
  readonly runtimeNlMappingsPath: string;
  readonly refreshActiveRuntimeSubstrates: boolean;
  readonly artifactOnlyPromote: boolean;
}

interface StageSnapshotRuntimeSubstratesArgs {
  readonly manifestPath: string;
  readonly allowExistingActiveSnapshot?: boolean;
}

interface StagedSnapshotRuntimeSubstratesResult {
  readonly snapshotId: string;
  readonly entities: number;
  readonly aliases: number;
  readonly ambiguityRegistry: number;
}

function parseArgs(argv: readonly string[]): Args {
  let manifestPath = '';
  let runtimeStatePath = DEFAULT_RUNTIME_STATE_PATH;
  let runtimeNlMappingsPath = DEFAULT_RUNTIME_NL_MAPPINGS_PATH;
  let refreshActiveRuntimeSubstrates = false;
  let artifactOnlyPromote = false;
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
    } else if (arg === '--refresh-active-runtime-substrates') {
      refreshActiveRuntimeSubstrates = true;
    } else if (arg === '--artifact-only-promote') {
      artifactOnlyPromote = true;
    } else if (arg === '--allow-missing-ltr') {
      throw new Error('--allow-missing-ltr has been removed; LTR is now optional for canonical runtime publish and the flag is obsolete');
    }
  }
  if (manifestPath.length === 0) {
    throw new Error('--manifest is required');
  }
  return {
    manifestPath,
    runtimeStatePath,
    runtimeNlMappingsPath,
    refreshActiveRuntimeSubstrates,
    artifactOnlyPromote,
  };
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

export async function acquireRuntimeSubstratePublishAdvisoryLock(
  client: Pick<PoolClient, 'query'>,
): Promise<void> {
  const result = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock($1)::bool AS locked',
    [RUNTIME_SUBSTRATE_PUBLISH_ADVISORY_LOCK_KEY],
  );
  if (result.rows[0]?.locked !== true) {
    throw new Error('runtime substrate publish advisory lock already held');
  }
}

export async function releaseRuntimeSubstratePublishAdvisoryLock(
  client: Pick<PoolClient, 'query'>,
): Promise<void> {
  await client.query('SELECT pg_advisory_unlock($1)', [RUNTIME_SUBSTRATE_PUBLISH_ADVISORY_LOCK_KEY]);
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

export async function ensureSnapshotScopedAmbiguityRegistryIndexes(
  client: PoolClient,
): Promise<void> {
  const legacyIndexResult = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'ambiguity_registry'
         AND indexname = 'idx_ambiguity_normalized'
     ) AS exists`,
  );
  if (legacyIndexResult.rows[0]?.exists === true) {
    await client.query('DROP INDEX IF EXISTS idx_ambiguity_normalized');
  }
  await client.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_ambiguity_snapshot_normalized ON ambiguity_registry(search_snapshot_id, normalized_form)',
  );
  await client.query(
    'CREATE INDEX IF NOT EXISTS idx_ambiguity_registry_search_snapshot ON ambiguity_registry(search_snapshot_id)',
  );
}

async function isSnapshotRuntimeSubstratePlaneAlreadyStaged(args: {
  readonly client: PoolClient;
  readonly manifest: SearchSnapshotManifest;
}): Promise<boolean> {
  const snapshotId = args.manifest.snapshotId;
  const entityCount = await args.client.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM entities WHERE search_snapshot_id = $1',
    [snapshotId],
  );
  const aliasCount = await args.client.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM aliases WHERE search_snapshot_id = $1',
    [snapshotId],
  );
  const ambiguityCount = await args.client.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM ambiguity_registry WHERE search_snapshot_id = $1',
    [snapshotId],
  );

  return Number(entityCount.rows[0]?.count ?? '0') === args.manifest.counts.entities
    && Number(aliasCount.rows[0]?.count ?? '0') === args.manifest.counts.aliases
    && Number(ambiguityCount.rows[0]?.count ?? '0') === args.manifest.counts.ambiguityRegistry;
}

async function stageSnapshotRuntimeRowsInPg(args: {
  readonly client: PoolClient;
  readonly manifest: SearchSnapshotManifest;
  readonly entities: readonly EntitySnapshotRecord[];
  readonly aliases: readonly AliasSnapshotRecord[];
  readonly ambiguityRows: readonly AmbiguityRegistrySnapshotRow[];
  readonly allowExistingActiveSnapshot: boolean;
}): Promise<void> {
  await ensureSnapshotScopedAmbiguityRegistryIndexes(args.client);
  if (await isSnapshotRuntimeSubstratePlaneAlreadyStaged(args)) {
    return;
  }
  await assertEntityIdentitySignatureConsistency(args.client, args.entities);
  await assertSnapshotNotAlreadyPublished(args.client, args.manifest.snapshotId, {
    allowExistingActiveSnapshot: args.allowExistingActiveSnapshot,
  });
  for (const entityBatch of chunkArray(args.entities, RUNTIME_SUBSTRATE_ENTITY_STAGE_BATCH_SIZE)) {
    await args.client.query(
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
       ON CONFLICT (search_snapshot_id, entity_id) DO NOTHING`,
      [buildEntityRowsJson(entityBatch, args.manifest.snapshotId)],
    );
    await args.client.query(
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
       ON CONFLICT (snapshot_id) DO NOTHING`,
      [buildEntitySnapshotRowsJson(
        entityBatch,
        args.manifest.snapshotId,
        args.manifest.generatedAt,
      )],
    );
  }
  for (const aliasBatch of chunkArray(args.aliases, RUNTIME_SUBSTRATE_ALIAS_STAGE_BATCH_SIZE)) {
    await args.client.query(
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
       ON CONFLICT (search_snapshot_id, alias_id) DO NOTHING`,
      [buildAliasRowsJson(aliasBatch, args.manifest.snapshotId)],
    );
  }
  for (const ambiguityBatch of chunkArray(args.ambiguityRows, RUNTIME_SUBSTRATE_AMBIGUITY_STAGE_BATCH_SIZE)) {
    await args.client.query(
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
       ON CONFLICT (search_snapshot_id, registry_id) DO NOTHING`,
      [buildAmbiguityRowsJson(ambiguityBatch, args.manifest.snapshotId)],
    );
  }

}

async function syncCanonicalGraphForSnapshot(args: {
  readonly client: PoolClient;
  readonly manifest: SearchSnapshotManifest;
  readonly entities: readonly EntitySnapshotRecord[];
  readonly aliases: readonly AliasSnapshotRecord[];
  readonly ambiguityRows: readonly AmbiguityRegistrySnapshotRow[];
}): Promise<void> {
  await applyFullCanonicalGraphSync(args.client, {
    entities: args.entities,
    aliases: args.aliases,
    ambiguityRows: args.ambiguityRows,
    searchSnapshotId: args.manifest.snapshotId,
  });
}

export async function stageSnapshotRuntimeSubstratesToPg(
  args: StageSnapshotRuntimeSubstratesArgs,
): Promise<StagedSnapshotRuntimeSubstratesResult> {
  const manifest = await loadManifest(args.manifestPath);
  await assertSnapshotArtifactLearnedFacetCoverage(manifest);
  const config = loadConfig();
  if (!shouldUsePgPool(config.pg)) {
    throw new Error('Postgres configuration is required to stage search snapshot runtime substrates');
  }

  const [entities, aliases, ambiguityRows] = await Promise.all([
    loadEntities(manifest),
    loadAliases(manifest),
    loadAmbiguityRows(manifest),
  ]);

  if (entities.length === 0) {
    throw new Error('Refusing to stage runtime substrates with zero entities');
  }
  if (aliases.length === 0) {
    throw new Error('Refusing to stage runtime substrates with zero aliases');
  }

  const pool = createPgPool(config.pg, {
    statementTimeoutMs: RUNTIME_SUBSTRATE_PUBLISH_STATEMENT_TIMEOUT_MS,
    idleInTransactionSessionTimeoutMs: RUNTIME_SUBSTRATE_PUBLISH_STATEMENT_TIMEOUT_MS,
    queryTimeoutMs: RUNTIME_SUBSTRATE_PUBLISH_STATEMENT_TIMEOUT_MS + 5_000,
  });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await stageSnapshotRuntimeRowsInPg({
        client,
        manifest,
        entities,
        aliases,
        ambiguityRows,
        allowExistingActiveSnapshot: args.allowExistingActiveSnapshot ?? false,
      });
      await client.query('COMMIT');
      return {
        snapshotId: manifest.snapshotId,
        entities: entities.length,
        aliases: aliases.length,
        ambiguityRegistry: ambiguityRows.length,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
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

async function assertLookupRuntimeArtifactsReady(
  manifest: SearchSnapshotManifest,
): Promise<void> {
  const [
    aliasRuntimeRaw,
    exactSafeRuntimeRaw,
    resolverProjectionRaw,
    entityProjectionRaw,
    ambiguityRuntimeRaw,
    conceptRedirectRuntimeRaw,
  ] = await Promise.all([
    fs.readFile(manifest.artifacts.lookupAliasRuntimeJson, 'utf8'),
    fs.readFile(manifest.artifacts.lookupExactSafeRuntimeJson, 'utf8'),
    fs.readFile(manifest.artifacts.lookupResolverProjectionJson, 'utf8'),
    fs.readFile(manifest.artifacts.lookupEntityProjectionJson, 'utf8'),
    fs.readFile(manifest.artifacts.lookupAmbiguityRuntimeJson, 'utf8'),
    fs.readFile(manifest.artifacts.lookupConceptRedirectRuntimeJson, 'utf8'),
  ]);
  const aliasRuntime = parseLookupAliasRuntimeArtifact(
    aliasRuntimeRaw,
    manifest.artifacts.lookupAliasRuntimeJson,
  );
  const exactSafeRuntime = parseLookupExactSafeRuntimeArtifact(
    exactSafeRuntimeRaw,
    manifest.artifacts.lookupExactSafeRuntimeJson,
  );
  const resolverProjection = parseLookupResolverProjectionArtifact(
    resolverProjectionRaw,
    manifest.artifacts.lookupResolverProjectionJson,
  );
  const entityProjection = parseLookupEntityProjectionArtifact(
    entityProjectionRaw,
    manifest.artifacts.lookupEntityProjectionJson,
  );
  const ambiguityRuntime = parseLookupAmbiguityRuntimeArtifact(
    ambiguityRuntimeRaw,
    manifest.artifacts.lookupAmbiguityRuntimeJson,
  );
  const conceptRedirectRuntime = parseLookupConceptRedirectRuntimeArtifact(
    conceptRedirectRuntimeRaw,
    manifest.artifacts.lookupConceptRedirectRuntimeJson,
  );

  if (aliasRuntime.aliases.length !== manifest.counts.lookupAliasRuntimeAliases) {
    throw new Error(
      `Lookup alias runtime count mismatch: manifest=${manifest.counts.lookupAliasRuntimeAliases} artifact=${aliasRuntime.aliases.length}`,
    );
  }
  const exactSafeRuntimeEntryCount =
    Object.keys(exactSafeRuntime.exactEntries).length
    + Object.keys(exactSafeRuntime.compactEntries).length;
  if (exactSafeRuntimeEntryCount !== manifest.counts.lookupExactSafeRuntimeEntries) {
    throw new Error(
      `Lookup exact-safe runtime count mismatch: manifest=${manifest.counts.lookupExactSafeRuntimeEntries} artifact=${exactSafeRuntimeEntryCount}`,
    );
  }
  if (resolverProjection.documents.length !== manifest.counts.lookupResolverProjectionDocuments) {
    throw new Error(
      `Lookup resolver projection count mismatch: manifest=${manifest.counts.lookupResolverProjectionDocuments} artifact=${resolverProjection.documents.length}`,
    );
  }
  if (entityProjection.documents.length !== manifest.counts.lookupEntityProjectionDocuments) {
    throw new Error(
      `Lookup entity projection count mismatch: manifest=${manifest.counts.lookupEntityProjectionDocuments} artifact=${entityProjection.documents.length}`,
    );
  }
  if (Object.keys(ambiguityRuntime.entries).length !== manifest.counts.lookupAmbiguityRuntimeEntries) {
    throw new Error(
      `Lookup ambiguity runtime count mismatch: manifest=${manifest.counts.lookupAmbiguityRuntimeEntries} artifact=${Object.keys(ambiguityRuntime.entries).length}`,
    );
  }
  if (Object.keys(conceptRedirectRuntime.entries).length !== manifest.counts.lookupConceptRedirectRuntimeEntries) {
    throw new Error(
      `Lookup concept redirect runtime count mismatch: manifest=${manifest.counts.lookupConceptRedirectRuntimeEntries} artifact=${Object.keys(conceptRedirectRuntime.entries).length}`,
    );
  }

  const aliasRuntimeHash = buildLookupAliasRuntimeArtifactHash(aliasRuntime);
  if (aliasRuntimeHash !== manifest.hashes.lookupAliasRuntime) {
    throw new Error(
      `Lookup alias runtime hash mismatch: manifest=${manifest.hashes.lookupAliasRuntime} artifact=${aliasRuntimeHash}`,
    );
  }
  const exactSafeRuntimeHash = buildLookupExactSafeRuntimeArtifactHash(exactSafeRuntime);
  if (exactSafeRuntimeHash !== manifest.hashes.lookupExactSafeRuntime) {
    throw new Error(
      `Lookup exact-safe runtime hash mismatch: manifest=${manifest.hashes.lookupExactSafeRuntime} artifact=${exactSafeRuntimeHash}`,
    );
  }
  const resolverProjectionHash = buildLookupResolverProjectionArtifactHash(resolverProjection);
  if (resolverProjectionHash !== manifest.hashes.lookupResolverProjection) {
    throw new Error(
      `Lookup resolver projection hash mismatch: manifest=${manifest.hashes.lookupResolverProjection} artifact=${resolverProjectionHash}`,
    );
  }
  const entityProjectionHash = buildLookupEntityProjectionArtifactHash(entityProjection);
  if (entityProjectionHash !== manifest.hashes.lookupEntityProjection) {
    throw new Error(
      `Lookup entity projection hash mismatch: manifest=${manifest.hashes.lookupEntityProjection} artifact=${entityProjectionHash}`,
    );
  }
  const ambiguityRuntimeHash = buildLookupAmbiguityRuntimeArtifactHash(ambiguityRuntime);
  if (ambiguityRuntimeHash !== manifest.hashes.lookupAmbiguityRuntime) {
    throw new Error(
      `Lookup ambiguity runtime hash mismatch: manifest=${manifest.hashes.lookupAmbiguityRuntime} artifact=${ambiguityRuntimeHash}`,
    );
  }
  const conceptRedirectRuntimeHash = buildLookupConceptRedirectRuntimeArtifactHash(conceptRedirectRuntime);
  if (conceptRedirectRuntimeHash !== manifest.hashes.lookupConceptRedirectRuntime) {
    throw new Error(
      `Lookup concept redirect runtime hash mismatch: manifest=${manifest.hashes.lookupConceptRedirectRuntime} artifact=${conceptRedirectRuntimeHash}`,
    );
  }
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

function buildArtifactOnlyRuntimeState(args: {
  readonly manifest: SearchSnapshotManifest;
  readonly manifestPath: string;
  readonly runtimeNlMappingsPath: string;
  readonly runtimeNlMappingsCount: number;
}): SearchSnapshotRuntimeState {
  return {
    schemaVersion: SEARCH_SNAPSHOT_STATE_VERSION,
    snapshotId: args.manifest.snapshotId,
    contentHash: args.manifest.contentHash,
    publishedAt: new Date().toISOString(),
    manifestPath: args.manifestPath,
    nlMappingsRuntimePath: args.runtimeNlMappingsPath,
    lookupAliasRuntimePath: args.manifest.artifacts.lookupAliasRuntimeJson,
    lookupExactSafeRuntimePath: args.manifest.artifacts.lookupExactSafeRuntimeJson,
    lookupResolverProjectionPath: args.manifest.artifacts.lookupResolverProjectionJson,
    lookupEntityProjectionPath: args.manifest.artifacts.lookupEntityProjectionJson,
    lookupAmbiguityRuntimePath: args.manifest.artifacts.lookupAmbiguityRuntimeJson,
    lookupConceptRedirectRuntimePath: args.manifest.artifacts.lookupConceptRedirectRuntimeJson,
    quality: args.manifest.quality,
    fieldAvailability: args.manifest.fieldAvailability,
    counts: {
      entities: args.manifest.counts.entities,
      aliases: args.manifest.counts.aliases,
      lookupAliasRuntimeAliases: args.manifest.counts.lookupAliasRuntimeAliases,
      lookupExactSafeRuntimeEntries: args.manifest.counts.lookupExactSafeRuntimeEntries,
      lookupResolverProjectionDocuments: args.manifest.counts.lookupResolverProjectionDocuments,
      lookupEntityProjectionDocuments: args.manifest.counts.lookupEntityProjectionDocuments,
      lookupAmbiguityRuntimeEntries: args.manifest.counts.lookupAmbiguityRuntimeEntries,
      lookupConceptRedirectRuntimeEntries: args.manifest.counts.lookupConceptRedirectRuntimeEntries,
      ambiguityRegistry: args.manifest.counts.ambiguityRegistry,
      nlMappings: args.runtimeNlMappingsCount,
      activeLtrModels: 0,
    },
    hashes: {
      entities: args.manifest.hashes.entities,
      aliases: args.manifest.hashes.aliases,
      lookupAliasRuntime: args.manifest.hashes.lookupAliasRuntime,
      lookupExactSafeRuntime: args.manifest.hashes.lookupExactSafeRuntime,
      lookupResolverProjection: args.manifest.hashes.lookupResolverProjection,
      lookupEntityProjection: args.manifest.hashes.lookupEntityProjection,
      lookupAmbiguityRuntime: args.manifest.hashes.lookupAmbiguityRuntime,
      lookupConceptRedirectRuntime: args.manifest.hashes.lookupConceptRedirectRuntime,
      ambiguityRegistry: args.manifest.hashes.ambiguityRegistry,
      nlMappings: args.manifest.hashes.nlMappings,
      activeLtrModels: hashStableJson([]),
    },
  };
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
  giftSuitabilityScore: number;
  beginnerSuitabilityScore: number;
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
  options?: {
    readonly allowExistingActiveSnapshot?: boolean;
  },
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
    if (options?.allowExistingActiveSnapshot === true) {
      return;
    }
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
  const phases = createRuntimeSubstratePublishStateMachine();
  await assertSnapshotArtifactLearnedFacetCoverage(manifest);
  await assertLookupRuntimeArtifactsReady(manifest);
  phases.advance('pg_stage');
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
    let activeLtrModels = 0;
    let activeLtrHash = '';
    try {
      await acquireRuntimeSubstratePublishAdvisoryLock(client);
      await client.query('BEGIN');
      await stageSnapshotRuntimeRowsInPg({
        client,
        manifest,
        entities,
        aliases,
        ambiguityRows,
        allowExistingActiveSnapshot: args.refreshActiveRuntimeSubstrates,
      });
      phases.advance('graph_sync');
      phases.advance('pg_verify');

      const ltrFeatureSchemaHashSupported = await pgTableHasColumn(
        client,
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
      activeLtrModels = Number(ltrActiveResult.rows[0]?.count ?? '0');
      activeLtrHash = buildActiveLtrModelHash(
        ltrActiveResult.rows.map((row) => ({
          query_class: row.query_class,
          model_version: row.model_version,
          eval_dataset_version: row.eval_dataset_version,
          feature_schema_hash: row.feature_schema_hash,
          weights: row.weights,
          bias: row.bias,
        })),
      );
      await client.query('COMMIT');
      committed = true;
    } catch (error) {
      if (!committed) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      await releaseRuntimeSubstratePublishAdvisoryLock(client).catch(() => undefined);
      client.release();
    }

    try {
      phases.advance('runtime_state_stage');
      await atomicWriteFile(runtimeNlMappingsPath, nlMappingsRaw);
      const runtimeNlMappingsCount = await loadNlMappingsCount(runtimeNlMappingsPath);
      const state: SearchSnapshotRuntimeState = {
        schemaVersion: SEARCH_SNAPSHOT_STATE_VERSION,
        snapshotId: manifest.snapshotId,
        contentHash: manifest.contentHash,
        publishedAt: new Date().toISOString(),
        manifestPath: args.manifestPath,
        nlMappingsRuntimePath: runtimeNlMappingsPath,
        lookupAliasRuntimePath: manifest.artifacts.lookupAliasRuntimeJson,
        lookupExactSafeRuntimePath: manifest.artifacts.lookupExactSafeRuntimeJson,
        lookupResolverProjectionPath: manifest.artifacts.lookupResolverProjectionJson,
        lookupEntityProjectionPath: manifest.artifacts.lookupEntityProjectionJson,
        lookupAmbiguityRuntimePath: manifest.artifacts.lookupAmbiguityRuntimeJson,
        lookupConceptRedirectRuntimePath: manifest.artifacts.lookupConceptRedirectRuntimeJson,
        quality: manifest.quality,
        fieldAvailability: manifest.fieldAvailability,
        counts: {
          entities: entities.length,
          aliases: aliases.length,
          lookupAliasRuntimeAliases: manifest.counts.lookupAliasRuntimeAliases,
          lookupExactSafeRuntimeEntries: manifest.counts.lookupExactSafeRuntimeEntries,
          lookupResolverProjectionDocuments: manifest.counts.lookupResolverProjectionDocuments,
          lookupEntityProjectionDocuments: manifest.counts.lookupEntityProjectionDocuments,
          lookupAmbiguityRuntimeEntries: manifest.counts.lookupAmbiguityRuntimeEntries,
          lookupConceptRedirectRuntimeEntries: manifest.counts.lookupConceptRedirectRuntimeEntries,
          ambiguityRegistry: ambiguityRows.length,
          nlMappings: runtimeNlMappingsCount,
          activeLtrModels,
        },
        hashes: {
          entities: manifest.hashes.entities,
          aliases: manifest.hashes.aliases,
          lookupAliasRuntime: manifest.hashes.lookupAliasRuntime,
          lookupExactSafeRuntime: manifest.hashes.lookupExactSafeRuntime,
          lookupResolverProjection: manifest.hashes.lookupResolverProjection,
          lookupEntityProjection: manifest.hashes.lookupEntityProjection,
          lookupAmbiguityRuntime: manifest.hashes.lookupAmbiguityRuntime,
          lookupConceptRedirectRuntime: manifest.hashes.lookupConceptRedirectRuntime,
          ambiguityRegistry: manifest.hashes.ambiguityRegistry,
          nlMappings: manifest.hashes.nlMappings,
          activeLtrModels: activeLtrHash,
        },
      };
      await atomicWriteFile(args.runtimeStatePath, `${JSON.stringify(state, null, 2)}\n`);
      return state;
    } catch (error) {
      await restoreRuntimeNlMappings(runtimeNlMappingsPath, previousRuntimeNlMappings);
      throw error;
    }
  } finally {
    await pool.end();
  }
}

export async function publishRuntimeSubstratesArtifactOnly(
  args: Pick<Args, 'manifestPath' | 'runtimeStatePath' | 'runtimeNlMappingsPath'>,
): Promise<SearchSnapshotRuntimeState> {
  const manifest = await loadManifest(args.manifestPath);
  await assertSnapshotArtifactLearnedFacetCoverage(manifest);
  await assertLookupRuntimeArtifactsReady(manifest);
  const config = loadConfig();
  if (isLtrServingEnabled(config)) {
    throw new Error(
      'artifact-only runtime substrate promote requires LTR_SERVING_ENABLED=false; live registry-backed LTR verification is unavailable in offline mode',
    );
  }

  const nlMappingsRaw = await fs.readFile(manifest.artifacts.nlMappingsJson, 'utf8');
  await atomicWriteFile(args.runtimeNlMappingsPath, nlMappingsRaw);
  const runtimeNlMappingsCount = await loadNlMappingsCount(args.runtimeNlMappingsPath);
  const state = buildArtifactOnlyRuntimeState({
    manifest,
    manifestPath: args.manifestPath,
    runtimeNlMappingsPath: args.runtimeNlMappingsPath,
    runtimeNlMappingsCount,
  });
  await atomicWriteFile(args.runtimeStatePath, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const previousRuntimeStateContents = await readOptionalFile(args.runtimeStatePath);
  const previousRuntimeNlMappingsContents = await readOptionalFile(args.runtimeNlMappingsPath);
  const manifest = await loadManifest(args.manifestPath);
  const phases = createRuntimeSubstratePublishStateMachine();
  const cutoverPaths = resolveRuntimeSubstrateCutoverPaths({
    snapshotId: manifest.snapshotId,
    runtimeStatePath: args.runtimeStatePath,
    runtimeNlMappingsPath: args.runtimeNlMappingsPath,
  });
  if (args.artifactOnlyPromote) {
    await publishRuntimeSubstratesArtifactOnly({
      manifestPath: args.manifestPath,
      runtimeStatePath: cutoverPaths.stagedRuntimeStatePath,
      runtimeNlMappingsPath: cutoverPaths.stagedRuntimeNlMappingsPath,
    });
  } else {
    await publishRuntimeSubstrates({
      ...args,
      runtimeStatePath: cutoverPaths.stagedRuntimeStatePath,
      runtimeNlMappingsPath: args.runtimeNlMappingsPath,
    });
  }
  try {
    phases.advance('pg_stage');
    phases.advance('graph_sync');
    phases.advance('pg_verify');
    phases.advance('runtime_state_stage');
    phases.advance('promote');
    const promotedState = await promoteRuntimeSubstrateArtifacts(cutoverPaths);
    phases.advance('post_promote_verify');
    const verifiedState = await loadSearchSnapshotRuntimeState(args.runtimeStatePath);
    if (verifiedState.snapshotId !== manifest.snapshotId) {
      throw new Error(
        `post-promote verify failed: runtime snapshot mismatch ${verifiedState.snapshotId} != ${manifest.snapshotId}`,
      );
    }
    if (verifiedState.hashes.lookupAliasRuntime !== manifest.hashes.lookupAliasRuntime) {
      throw new Error('post-promote verify failed: lookupAliasRuntime hash mismatch');
    }
    if (verifiedState.hashes.lookupResolverProjection !== manifest.hashes.lookupResolverProjection) {
      throw new Error('post-promote verify failed: lookupResolverProjection hash mismatch');
    }
    if (verifiedState.hashes.lookupEntityProjection !== manifest.hashes.lookupEntityProjection) {
      throw new Error('post-promote verify failed: lookupEntityProjection hash mismatch');
    }
    if (verifiedState.hashes.lookupAmbiguityRuntime !== manifest.hashes.lookupAmbiguityRuntime) {
      throw new Error('post-promote verify failed: lookupAmbiguityRuntime hash mismatch');
    }
    if (verifiedState.hashes.lookupConceptRedirectRuntime !== manifest.hashes.lookupConceptRedirectRuntime) {
      throw new Error('post-promote verify failed: lookupConceptRedirectRuntime hash mismatch');
    }
    if (verifiedState.counts.entities !== manifest.counts.entities) {
      throw new Error('post-promote verify failed: entity count mismatch');
    }
    if (verifiedState.counts.lookupConceptRedirectRuntimeEntries !== manifest.counts.lookupConceptRedirectRuntimeEntries) {
      throw new Error('post-promote verify failed: lookupConceptRedirectRuntime entry count mismatch');
    }
    console.log(`Published runtime substrates for ${promotedState.snapshotId}`);
    console.log(`runtime_state=${args.runtimeStatePath}`);
    console.log(`runtime_nl_mappings=${args.runtimeNlMappingsPath}`);
    console.log(`entities=${promotedState.counts.entities}`);
    console.log(`aliases=${promotedState.counts.aliases}`);
    console.log(`ambiguity_registry=${promotedState.counts.ambiguityRegistry}`);
    console.log(`nl_mappings=${promotedState.counts.nlMappings}`);
    console.log(`active_ltr_models=${promotedState.counts.activeLtrModels}`);
    console.log(`quality_status=${promotedState.quality.status}`);
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
