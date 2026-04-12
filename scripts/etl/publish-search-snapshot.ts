#!/usr/bin/env tsx

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../../src/config/env.js';
import { createPgPool, shouldUsePgPool } from '../../src/infrastructure/db/pg-pool.js';
import { PgLtrModelRegistry } from '../../src/infrastructure/adapter/pg-ltr-model-registry.js';
import { VespaClient } from '../../src/infrastructure/vespa/vespa-client.js';
import { loadSearchSnapshotRuntimeState } from '../../src/infrastructure/health/search-snapshot-readiness.js';
import { getCurrentFeatureSchemaHash } from '../../src/domain/ranking/service/feature-parity-hash.js';
import { buildSearchSnapshot } from './build-search-snapshot.js';
import { publishRuntimeSubstrates } from './publish-runtime-substrates.js';
import { verifySearchSnapshotReadiness } from './verify-search-snapshot-readiness.js';
import { verifyRuntimeGoldCatalogCoverage } from './verify-runtime-gold-catalog-coverage.js';
import { resolveDefaultFixtureRepoRoot } from './snapshot-entity-identity.js';
import { atomicWriteFile } from './etl-utils.js';
import { resolveDataPath } from '../../src/shared/utils/data-paths.js';
import { parseNdjson } from './ndjson.js';
import { hashStableJson } from '../../src/shared/utils/stable-json.js';
import type { EntitySnapshotRecord, SearchSnapshotManifest } from './search-snapshot-schema.js';

const execFile = promisify(execFileCb);
const VESPA_NAMESPACE = 'wine';
const VESPA_DOC_TYPE = 'wine_entity';
const SNAPSHOT_PUBLISH_LOCK_A = 93721;
const SNAPSHOT_PUBLISH_LOCK_B = 6006;

interface Args {
  readonly input: string;
  readonly outputDir: string;
  readonly nlMappings: string;
  readonly runtimeStatePath: string;
  readonly runtimeNlMappingsPath: string;
  readonly allowMissingLtr: boolean;
  readonly fixtureRepoRoot?: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  let input = resolveDataPath('data/silver-docquery.ndjson');
  let outputDir = resolveDataPath('data/search-snapshots');
  let nlMappings = resolveDataPath('data/nl-mappings.json');
  let runtimeStatePath = resolveDataPath('data/runtime-search-snapshot.json');
  let runtimeNlMappingsPath = resolveDataPath('data/nl-mappings.json');
  let allowMissingLtr = false;
  let fixtureRepoRoot: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input' || arg === '-i') {
      input = argv[i + 1] ?? input;
      i += 1;
    } else if (arg === '--output-dir' || arg === '-o') {
      outputDir = argv[i + 1] ?? outputDir;
      i += 1;
    } else if (arg === '--nl-mappings') {
      nlMappings = argv[i + 1] ?? nlMappings;
      i += 1;
    } else if (arg === '--runtime-state') {
      runtimeStatePath = argv[i + 1] ?? runtimeStatePath;
      i += 1;
    } else if (arg === '--runtime-nl-mappings') {
      runtimeNlMappingsPath = argv[i + 1] ?? runtimeNlMappingsPath;
      i += 1;
    } else if (arg === '--allow-missing-ltr') {
      allowMissingLtr = true;
    } else if (arg === '--fixture-repo') {
      fixtureRepoRoot = argv[i + 1];
      i += 1;
    }
  }
  return {
    input,
    outputDir,
    nlMappings,
    runtimeStatePath,
    runtimeNlMappingsPath,
    allowMissingLtr,
    fixtureRepoRoot,
  };
}

async function runIndexer(
  documentsPath: string,
  snapshotId: string,
  fixtureRepoRoot?: string | undefined,
): Promise<void> {
  const scriptPath = path.resolve(process.cwd(), 'scripts/etl/index-to-vespa.ts');
  const tail =
    fixtureRepoRoot != null && fixtureRepoRoot.length > 0
      ? ['--fixture-repo', fixtureRepoRoot]
      : [];
  await execFile(
    'npx',
    ['tsx', scriptPath, '--input', documentsPath, '--snapshot-id', snapshotId, ...tail],
    {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
}

function buildStagingPath(activePath: string, snapshotId: string): string {
  const ext = path.extname(activePath);
  const base = ext.length > 0 ? activePath.slice(0, -ext.length) : activePath;
  return `${base}.${snapshotId}.staging${ext}`;
}

async function promoteStagedFile(stagingPath: string, activePath: string): Promise<void> {
  const raw = await fs.readFile(stagingPath, 'utf8');
  await atomicWriteFile(activePath, raw);
  await fs.rm(stagingPath, { force: true });
}

async function rewriteRuntimeStateForActivePaths(args: {
  readonly stagedRuntimeStatePath: string;
  readonly activeRuntimeNlMappingsPath: string;
}): Promise<void> {
  const raw = await fs.readFile(args.stagedRuntimeStatePath, 'utf8');
  const parsed = JSON.parse(raw) as {
    readonly nlMappingsRuntimePath?: string;
  } & Record<string, unknown>;
  if (parsed.nlMappingsRuntimePath === args.activeRuntimeNlMappingsPath) {
    return;
  }
  const next = {
    ...parsed,
    nlMappingsRuntimePath: args.activeRuntimeNlMappingsPath,
  };
  await atomicWriteFile(args.stagedRuntimeStatePath, `${JSON.stringify(next, null, 2)}\n`);
}

async function loadPublishedRuntimeState(runtimeStatePath: string) {
  try {
    return await loadSearchSnapshotRuntimeState(runtimeStatePath);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT'
      || (error instanceof Error && error.message === 'Malformed runtime search snapshot state')
    ) {
      return undefined;
    }
    throw error;
  }
}

async function loadManifest(manifestPath: string): Promise<SearchSnapshotManifest> {
  return JSON.parse(await fs.readFile(manifestPath, 'utf8')) as SearchSnapshotManifest;
}

async function loadSnapshotEntityIds(entitiesPath: string): Promise<readonly string[]> {
  const raw = await fs.readFile(entitiesPath, 'utf8');
  return parseNdjson<EntitySnapshotRecord>(raw, entitiesPath).records
    .map((entity) => entity.entityId)
    .sort((left, right) => left.localeCompare(right));
}

async function loadCurrentRuntimeEntityIds(snapshotId: string): Promise<readonly string[]> {
  const config = loadConfig();
  if (!shouldUsePgPool(config.pg)) {
    throw new Error('Postgres configuration is required to load current runtime entity ids');
  }
  const pool = createPgPool(config.pg);
  try {
    const result = await pool.query<{ entity_id: string }>(
      `SELECT entity_id
       FROM entities
       WHERE search_snapshot_id = $1
       ORDER BY entity_id ASC`,
      [snapshotId],
    );
    return result.rows.map((row) => row.entity_id);
  } finally {
    await pool.end();
  }
}

async function deleteStaleVespaDocuments(docIds: readonly string[]): Promise<void> {
  if (docIds.length === 0) {
    return;
  }
  const config = loadConfig();
  const vespa = new VespaClient(config.vespa.url, VESPA_NAMESPACE, VESPA_DOC_TYPE);
  for (const docId of docIds) {
    await vespa.delete(docId);
  }
}

async function acquireSnapshotPublishLock() {
  const config = loadConfig();
  if (!shouldUsePgPool(config.pg)) {
    throw new Error('Postgres configuration is required to acquire search snapshot publish lock');
  }
  const pool = createPgPool(config.pg);
  const client = await pool.connect();
  await client.query('SELECT pg_advisory_lock($1, $2)', [SNAPSHOT_PUBLISH_LOCK_A, SNAPSHOT_PUBLISH_LOCK_B]);
  return {
    async release(): Promise<void> {
      try {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [SNAPSHOT_PUBLISH_LOCK_A, SNAPSHOT_PUBLISH_LOCK_B]);
      } finally {
        client.release();
        await pool.end();
      }
    },
  };
}

async function rollbackToPreviousSnapshot(args: {
  readonly previousRuntimeState: Awaited<ReturnType<typeof loadPublishedRuntimeState>>;
  readonly previousManifest?: SearchSnapshotManifest | undefined;
  readonly runtimeStatePath: string;
  readonly runtimeNlMappingsPath: string;
  readonly newSnapshotEntityIds: readonly string[];
  readonly fixtureRepoRoot?: string | undefined;
}): Promise<void> {
  const previousState = args.previousRuntimeState;
  if (previousState === undefined || args.previousManifest === undefined) {
    await deleteStaleVespaDocuments(args.newSnapshotEntityIds);
    return;
  }
  const previousEntityIds = await loadSnapshotEntityIds(args.previousManifest.artifacts.entitiesNdjson);
  await runIndexer(
    args.previousManifest.artifacts.documentsNdjson,
    args.previousManifest.snapshotId,
    args.fixtureRepoRoot,
  );
  const previousEntityIdSet = new Set(previousEntityIds);
  const staleDocIds = args.newSnapshotEntityIds.filter((entityId) => !previousEntityIdSet.has(entityId));
  await deleteStaleVespaDocuments(staleDocIds);
  await publishRuntimeSubstrates({
    manifestPath: previousState.manifestPath,
    runtimeStatePath: args.runtimeStatePath,
    runtimeNlMappingsPath: args.runtimeNlMappingsPath,
    allowMissingLtr: previousState.allowMissingLtr,
  });
  await verifySearchSnapshotReadiness({
    runtimeStatePath: args.runtimeStatePath,
    manifestPath: previousState.manifestPath,
  });
}

async function computeCanonicalEntityArtifactHash(manifest: SearchSnapshotManifest): Promise<string> {
  const raw = await fs.readFile(manifest.artifacts.entitiesNdjson, 'utf8');
  const records = parseNdjson<EntitySnapshotRecord>(raw, manifest.artifacts.entitiesNdjson).records;
  return hashStableJson(records);
}

async function areSnapshotsLtrCompatible(
  previousManifest: SearchSnapshotManifest | undefined,
  nextManifest: SearchSnapshotManifest,
): Promise<boolean> {
  if (previousManifest === undefined) {
    return false;
  }
  if (previousManifest.hashes.documents !== nextManifest.hashes.documents) {
    return false;
  }
  const [previousEntityHash, nextEntityHash] = await Promise.all([
    computeCanonicalEntityArtifactHash(previousManifest),
    computeCanonicalEntityArtifactHash(nextManifest),
  ]);
  return previousEntityHash === nextEntityHash;
}

async function ensureSnapshotBoundLtrModels(args: {
  readonly previousRuntimeState: Awaited<ReturnType<typeof loadPublishedRuntimeState>>;
  readonly previousManifest?: SearchSnapshotManifest | undefined;
  readonly nextManifest: SearchSnapshotManifest;
  readonly snapshotRootDir: string;
  readonly allowMissingLtr: boolean;
}): Promise<void> {
  console.log(`🔍 Checking snapshot-bound LTR for ${args.nextManifest.snapshotId}`);
  const config = loadConfig();
  if (!shouldUsePgPool(config.pg)) {
    throw new Error('Postgres configuration is required to clone snapshot-bound LTR models');
  }
  const pool = createPgPool(config.pg);
  try {
    const registry = new PgLtrModelRegistry(pool);
    const existingTargetModels = await registry.getAllModels(args.nextManifest.snapshotId);
    if (existingTargetModels.size > 0) {
      console.log(`✅ Found ${existingTargetModels.size} active snapshot-bound LTR models for ${args.nextManifest.snapshotId}`);
      return;
    }

    const featureSchemaHash = getCurrentFeatureSchemaHash();
    const activeSnapshotIds = await registry.listActiveSnapshotIds(featureSchemaHash);
    const candidateSnapshotIds = [
      ...(args.previousRuntimeState !== undefined ? [args.previousRuntimeState.snapshotId] : []),
      ...activeSnapshotIds,
    ].filter((snapshotId, index, all) =>
      snapshotId !== args.nextManifest.snapshotId
      && all.indexOf(snapshotId) === index,
    );

    for (const candidateSnapshotId of candidateSnapshotIds) {
      const candidateManifestPath = path.join(args.snapshotRootDir, candidateSnapshotId, 'manifest.json');
      let candidateManifest: SearchSnapshotManifest | undefined;
      if (
        args.previousManifest !== undefined
        && args.previousRuntimeState?.snapshotId === candidateSnapshotId
      ) {
        candidateManifest = args.previousManifest;
      } else {
        try {
          candidateManifest = await loadManifest(candidateManifestPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            continue;
          }
          throw error;
        }
      }

      if (!(await areSnapshotsLtrCompatible(candidateManifest, args.nextManifest))) {
        continue;
      }

      console.log(
        `🔁 Cloning active LTR models from compatible snapshot ${candidateSnapshotId} -> ${args.nextManifest.snapshotId}`,
      );
      const clonedCount = await registry.cloneActiveModelsToSnapshot(
        candidateSnapshotId,
        args.nextManifest.snapshotId,
        { featureSchemaHash },
      );
      if (clonedCount > 0) {
        const activatedCount = await registry.activateSnapshot(args.nextManifest.snapshotId);
        if (activatedCount !== clonedCount) {
          throw new Error(
            `Snapshot-bound LTR activation mismatch after clone: cloned=${clonedCount}, activated=${activatedCount}`,
          );
        }
        console.log(`✅ Cloned and activated ${activatedCount} snapshot-bound LTR models`);
        return;
      }
    }

    if (!args.allowMissingLtr) {
      if (candidateSnapshotIds.length === 0) {
        throw new Error(
          `No active LTR models found for snapshot ${args.nextManifest.snapshotId}; train LTR for the snapshot or pass --allow-missing-ltr explicitly`,
        );
      }
      throw new Error(
        `No compatible active snapshot-bound LTR source could be cloned into ${args.nextManifest.snapshotId}; retrain LTR for the new snapshot`,
      );
    }
  } finally {
    await pool.end();
  }
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const built = await buildSearchSnapshot({
    input: args.input,
    outputDir: args.outputDir,
    nlMappings: args.nlMappings,
    fixtureRepoRoot: args.fixtureRepoRoot,
  });
  console.log(`🧱 Built search snapshot ${built.manifest.snapshotId}`);

  const stagedRuntimeStatePath = buildStagingPath(args.runtimeStatePath, built.manifest.snapshotId);
  const stagedRuntimeNlMappingsPath = buildStagingPath(
    args.runtimeNlMappingsPath,
    built.manifest.snapshotId,
  );
  const snapshotRootDir = path.dirname(path.dirname(built.manifest.artifacts.documentsNdjson));
  const [previousRuntimeState, newSnapshotEntityIds] = await Promise.all([
    loadPublishedRuntimeState(args.runtimeStatePath),
    loadSnapshotEntityIds(built.manifest.artifacts.entitiesNdjson),
  ]);
  const previousManifest = previousRuntimeState !== undefined
    ? await loadManifest(previousRuntimeState.manifestPath)
    : undefined;
  const publishLock = await acquireSnapshotPublishLock();

  let runtimeState;
  try {
    console.log('🚦 Ensuring snapshot-bound LTR readiness');
    await ensureSnapshotBoundLtrModels({
      previousRuntimeState,
      previousManifest,
      nextManifest: built.manifest,
      snapshotRootDir,
      allowMissingLtr: args.allowMissingLtr,
    });
    console.log('📥 Indexing document plane into Vespa');
    await runIndexer(built.manifest.artifacts.documentsNdjson, built.manifest.snapshotId, args.fixtureRepoRoot);
    if (
      previousRuntimeState !== undefined
      && previousRuntimeState.snapshotId !== built.manifest.snapshotId
    ) {
      console.log(`🧹 Deleting stale Vespa docs from previous snapshot ${previousRuntimeState.snapshotId}`);
      const currentRuntimeEntityIds = await loadCurrentRuntimeEntityIds(previousRuntimeState.snapshotId);
      const nextEntityIdSet = new Set(newSnapshotEntityIds);
      const staleDocIds = currentRuntimeEntityIds.filter((entityId) => !nextEntityIdSet.has(entityId));
      await deleteStaleVespaDocuments(staleDocIds);
    }
    console.log('🗄️ Publishing runtime substrates');
    runtimeState = await publishRuntimeSubstrates({
      manifestPath: built.manifestPath,
      runtimeStatePath: stagedRuntimeStatePath,
      runtimeNlMappingsPath: stagedRuntimeNlMappingsPath,
      allowMissingLtr: args.allowMissingLtr,
    });
    console.log('✅ Verifying search snapshot readiness');
    await verifySearchSnapshotReadiness({
      runtimeStatePath: stagedRuntimeStatePath,
      manifestPath: built.manifestPath,
    });
    const fixtureRoot = args.fixtureRepoRoot ?? resolveDefaultFixtureRepoRoot();
    if (fixtureRoot != null) {
      console.log('🎯 Verifying runtime gold catalog coverage');
      const config = loadConfig();
      if (!shouldUsePgPool(config.pg)) {
        throw new Error('Postgres configuration is required for runtime gold coverage verification');
      }
      const coveragePool = createPgPool(config.pg);
      try {
        const coverage = await verifyRuntimeGoldCatalogCoverage({
          pool: coveragePool,
          snapshotId: built.manifest.snapshotId,
          fixtureRepoRoot: fixtureRoot,
        });
        console.log(
          `🎯 Runtime gold coverage passed: ${coverage.requiredCanonicalIds} canonical id(s) confirmed`,
        );
      } finally {
        await coveragePool.end();
      }
    } else {
      console.log('🎯 Runtime gold coverage skipped: no fixture repo resolved (set FIXTURE_REPO_PATH to enforce)');
    }
    console.log('📌 Promoting staged runtime files');
    await promoteStagedFile(stagedRuntimeNlMappingsPath, args.runtimeNlMappingsPath);
    await rewriteRuntimeStateForActivePaths({
      stagedRuntimeStatePath,
      activeRuntimeNlMappingsPath: args.runtimeNlMappingsPath,
    });
    await promoteStagedFile(stagedRuntimeStatePath, args.runtimeStatePath);
  } catch (error) {
    console.error('↩️ Publish failed; attempting rollback');
    await Promise.all([
      fs.rm(stagedRuntimeStatePath, { force: true }),
      fs.rm(stagedRuntimeNlMappingsPath, { force: true }),
    ]);
    try {
      await rollbackToPreviousSnapshot({
        previousRuntimeState,
        previousManifest,
        runtimeStatePath: args.runtimeStatePath,
        runtimeNlMappingsPath: args.runtimeNlMappingsPath,
        newSnapshotEntityIds,
        fixtureRepoRoot: args.fixtureRepoRoot,
      });
    } catch (rollbackError) {
      const publishMessage = error instanceof Error ? error.message : String(error);
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new Error(`search snapshot publish failed: ${publishMessage}; rollback failed: ${rollbackMessage}`);
    } finally {
      await publishLock.release();
    }
    throw error;
  }
  await publishLock.release();

  console.log(`Published search snapshot ${runtimeState.snapshotId}`);
  console.log(`manifest=${built.manifestPath}`);
  console.log(`runtime_state=${args.runtimeStatePath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${message}`);
    process.exit(1);
  });
}
