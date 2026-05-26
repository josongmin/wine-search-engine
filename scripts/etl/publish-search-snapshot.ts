#!/usr/bin/env tsx

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../../src/config/env.js';
import { createPgPool, shouldUsePgPool } from '../../src/infrastructure/db/pg-pool.js';
import { PgLtrModelRegistry } from '../../src/infrastructure/adapter/pg-ltr-model-registry.js';
import { VespaClient } from '../../src/infrastructure/vespa/vespa-client.js';
import { loadSearchSnapshotRuntimeState } from '../../src/infrastructure/health/search-snapshot-readiness.js';
// Cache invalidation is handled automatically via WeakMap pool-keyed cache
// + 2s TTL. Publish creates a dedicated pool per pointer write, so its
// cache does not affect readiness probes running on separate pools.
import { getCurrentFeatureSchemaHash } from '../../src/domain/ranking/service/feature-parity-hash.js';
import { buildSearchSnapshot } from './build-search-snapshot.js';
import {
  promoteRuntimeSubstrateArtifacts,
  publishRuntimeSubstrates,
  resolveRuntimeSubstrateCutoverPaths,
  restoreRuntimeSubstrateArtifacts,
} from './publish-runtime-substrates.js';
import { verifySearchSnapshotReadiness } from './verify-search-snapshot-readiness.js';
import { verifyRuntimeGoldCatalogCoverage } from './verify-runtime-gold-catalog-coverage.js';
import { resolveDefaultFixtureRepoRoot } from './snapshot-entity-identity.js';
import { atomicWriteFile } from './etl-utils.js';
import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';
import { parseNdjson } from './ndjson.js';
import { hashStableJson } from '../../src/domain/shared/utils/stable-json.js';
import {
  parseManifest,
  type AliasSnapshotRecord,
  type EntitySnapshotRecord,
  type SearchSnapshotManifest,
} from './search-snapshot-schema.js';
import {
  ETL_ARTIFACT_FILES,
  assertCanonicalTrackCArtifactInput,
} from './artifact-contract.js';
import {
  materializePreparedVespaFeedArtifact,
  type PreparedVespaFeedDocument,
  parsePreparedVespaFeedDocuments,
} from './index-to-vespa.js';
import {
  createSnapshotPublishStateMachine,
  hasSnapshotPublishReachedPhase,
  type SnapshotPublishPhase,
} from './snapshot-publish-state-machine.js';
export {
  createSnapshotPublishStateMachine,
  hasSnapshotPublishReachedPhase,
  SNAPSHOT_PUBLISH_PHASES,
  type SnapshotPublishPhase,
  type SnapshotPublishStateMachine,
} from './snapshot-publish-state-machine.js';

const VESPA_NAMESPACE = 'wine';
const VESPA_DOC_TYPE = 'wine_entity';
const VESPA_SNAPSHOT_DOC_ID_QUERY_PAGE_SIZE = 400;
const SNAPSHOT_PUBLISH_LOCK_LEASE_MS = 60_000;
const SNAPSHOT_PUBLISH_LOCK_HEARTBEAT_MS = 10_000;
export const FIXTURE_REPO_REQUIRED_ERROR =
  'Fixture repo not found: set FIXTURE_REPO_PATH or --fixture-repo, or clone wine-engine-fixture as a sibling.';

interface Args {
  readonly input: string;
  readonly outputDir: string;
  readonly nlMappings: string;
  readonly runtimeStatePath: string;
  readonly runtimeNlMappingsPath: string;
  readonly skipIndex: boolean;
  readonly fixtureRepoRoot?: string | undefined;
}

interface CommandRunnerOptions {
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

type CriticalWineType = 'red' | 'white' | 'sparkling';
type CriticalWineTypeCoverage = Record<CriticalWineType, number>;
type CriticalWineTypeAliasCoverageEntry = {
  readonly entityCount: number;
  readonly entitiesWithAliases: number;
  readonly aliasCount: number;
};
type CriticalWineTypeAliasCoverage = Record<CriticalWineType, CriticalWineTypeAliasCoverageEntry>;

type CriticalWineTypeArtifactCoverage = {
  readonly entityCoverage: CriticalWineTypeCoverage;
  readonly vespaCoverage: CriticalWineTypeCoverage;
  readonly aliasCoverage: CriticalWineTypeAliasCoverage;
};

export const DEFAULT_INPUT = ETL_ARTIFACT_FILES.trackc;

function parseArgs(argv: readonly string[]): Args {
  let input = DEFAULT_INPUT;
  let outputDir = ETL_ARTIFACT_FILES.searchSnapshotsDir;
  let nlMappings = ETL_ARTIFACT_FILES.nlMappings;
  let runtimeStatePath = resolveDataPath('data/runtime-search-snapshot.json');
  let runtimeNlMappingsPath = ETL_ARTIFACT_FILES.nlMappings;
  let skipIndex = false;
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
      throw new Error('--allow-missing-ltr has been removed; canonical snapshot publish now hard-fails on missing active LTR models');
    } else if (arg === '--skip-index') {
      skipIndex = true;
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
    skipIndex,
    fixtureRepoRoot,
  };
}

type IndexerMode = 'input' | 'prepared-feed';

async function runCommand(
  command: string,
  args: readonly string[],
  errorLabel: string,
  options: CommandRunnerOptions = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdio: 'inherit',
    });

    child.once('error', (error) => {
      reject(error);
    });

    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${errorLabel} exited with code=${code ?? 'null'} signal=${signal ?? 'null'}`,
        ),
      );
    });
  });
}

async function runIndexer(
  documentsPath: string,
  snapshotId: string,
  mode: IndexerMode,
  fixtureRepoRoot?: string | undefined,
): Promise<void> {
  const scriptPath = path.resolve(process.cwd(), 'scripts/etl/index-to-vespa.ts');
  const tail: string[] = [];
  if (mode === 'prepared-feed') {
    tail.push('--prepared-feed', documentsPath);
  } else {
    tail.push('--input', documentsPath, '--snapshot-id', snapshotId);
  }
  if (fixtureRepoRoot != null && fixtureRepoRoot.length > 0) {
    tail.push('--fixture-repo', fixtureRepoRoot);
  }
  await runCommand(
    'npx',
    ['tsx', scriptPath, ...tail],
    'index-to-vespa',
  );
}

// Vespa application-package deploy is OUT OF SCOPE for this script as of
// 2026-05-25 (self-hosted-only topology). The schema / services.xml /
// rank-profiles live in `vespa/app/` and are deployed to the config server
// (port 19071) via direct REST POST or manual ops — NOT through this
// publish flow. The previous `deployVespaApplicationPackage` helper
// shelled out to the `vespa` CLI whose default target on developer
// machines may route to a hosted environment rather than the configured
// self-hosted cluster. Removed entirely to prevent that footgun. Schema
// deploy is now an operator step run separately against the
// self-hosted config server.

function _buildStagingPath(activePath: string, snapshotId: string): string {
  const ext = path.extname(activePath);
  const base = ext.length > 0 ? activePath.slice(0, -ext.length) : activePath;
  return `${base}.${snapshotId}.staging${ext}`;
}

/**
 * T-010/W1: atomic pointer promote.
 *
 * Single DB write that flips the read path to the new snapshot_id.
 *
 * Contract:
 *  - Writes the `active_search_snapshot` singleton row (id = 1) and appends
 *    to `active_search_snapshot_history` inside the same transaction.
 *  - Called AFTER: staged runtime substrates committed, Vespa doc plane
 *    indexed, readiness verified. Called BEFORE: runtime-state JSON promote.
 *  - If this step throws, nothing globally visible has changed — callers
 *    must drop the staged runtime-state file and treat the publish as failed.
 *  - Idempotent: setting the same active_snapshot_id is a no-op.
 */
export async function promoteActiveSearchSnapshotPointer(args: {
  readonly snapshotId: string;
  readonly previousSnapshotId?: string | undefined;
  readonly contentHash: string;
  readonly promoter?: string | undefined;
}): Promise<void> {
  const config = loadConfig();
  if (!shouldUsePgPool(config.pg)) {
    throw new Error('Postgres configuration is required to promote the active snapshot pointer');
  }
  const pool = createPgPool(config.pg);
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const existing = await client.query<{
        active_snapshot_id: string;
        previous_snapshot_id: string | null;
      }>(`SELECT active_snapshot_id, previous_snapshot_id FROM active_search_snapshot WHERE id = 1 FOR UPDATE`);
      const current = existing.rows[0];

      if (current?.active_snapshot_id === args.snapshotId) {
        // Idempotent: pointer already points here. No-op.
        await client.query('COMMIT');
        return;
      }

      const previousSnapshotId = args.previousSnapshotId ?? current?.active_snapshot_id ?? null;
      const promoter = args.promoter ?? 'publish-search-snapshot';

      if (current === undefined) {
        // First publish — insert singleton.
        await client.query(
          `INSERT INTO active_search_snapshot
             (id, active_snapshot_id, previous_snapshot_id, content_hash, promoted_at, promoter)
           VALUES (1, $1, $2, $3, NOW(), $4)`,
          [args.snapshotId, previousSnapshotId, args.contentHash, promoter],
        );
      } else {
        await client.query(
          `UPDATE active_search_snapshot
             SET active_snapshot_id = $1,
                 previous_snapshot_id = $2,
                 content_hash = $3,
                 promoted_at = NOW(),
                 promoter = $4
           WHERE id = 1`,
          [args.snapshotId, previousSnapshotId, args.contentHash, promoter],
        );
      }

      await client.query(
        `INSERT INTO active_search_snapshot_history
           (active_snapshot_id, previous_snapshot_id, content_hash, promoter)
         VALUES ($1, $2, $3, $4)`,
        [args.snapshotId, previousSnapshotId, args.contentHash, promoter],
      );

      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

/**
 * T-010/W1: pointer rollback.
 *
 * Flips the active snapshot back to previous_snapshot_id. Data on both
 * snapshots remains in place (snapshot-bound append-only) so rollback is
 * just a pointer swap. Fails if there is no previous snapshot.
 */
export async function rollbackActiveSearchSnapshotPointer(): Promise<{
  readonly rolledBackTo: string;
  readonly from: string;
}> {
  const config = loadConfig();
  if (!shouldUsePgPool(config.pg)) {
    throw new Error('Postgres configuration is required to rollback the active snapshot pointer');
  }
  const pool = createPgPool(config.pg);
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query<{
        active_snapshot_id: string;
        previous_snapshot_id: string | null;
        content_hash: string;
      }>(`SELECT active_snapshot_id, previous_snapshot_id, content_hash
          FROM active_search_snapshot WHERE id = 1 FOR UPDATE`);
      const row = res.rows[0];
      if (row === undefined) {
        throw new Error('No active_search_snapshot row exists; nothing to rollback');
      }
      if (row.previous_snapshot_id == null) {
        throw new Error(`Cannot rollback: no previous snapshot for ${row.active_snapshot_id}`);
      }
      const rolledBackTo = row.previous_snapshot_id;
      await client.query(
        `UPDATE active_search_snapshot
           SET active_snapshot_id = $1,
               previous_snapshot_id = $2,
               promoted_at = NOW(),
               promoter = 'rollback'
         WHERE id = 1`,
        [rolledBackTo, row.active_snapshot_id],
      );
      await client.query(
        `INSERT INTO active_search_snapshot_history
           (active_snapshot_id, previous_snapshot_id, content_hash, promoter)
         VALUES ($1, $2, $3, 'rollback')`,
        [rolledBackTo, row.active_snapshot_id, row.content_hash],
      );
      await client.query('COMMIT');
      return { rolledBackTo, from: row.active_snapshot_id };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

export async function loadPublishedRuntimeState(runtimeStatePath: string) {
  try {
    return await loadSearchSnapshotRuntimeState(runtimeStatePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function readOptionalTextFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export function resolvePublishFixtureRepoRoot(
  explicit: string | undefined,
  fallback: string | undefined = resolveDefaultFixtureRepoRoot(),
): string {
  if (explicit != null && explicit.length > 0) {
    return explicit;
  }
  if (fallback == null || fallback.length === 0) {
    throw new Error(FIXTURE_REPO_REQUIRED_ERROR);
  }
  return fallback;
}

function emptyCriticalWineTypeCoverage(): CriticalWineTypeCoverage {
  return { red: 0, white: 0, sparkling: 0 };
}

function emptyCriticalWineTypeAliasCoverage(): CriticalWineTypeAliasCoverage {
  return {
    red: { entityCount: 0, entitiesWithAliases: 0, aliasCount: 0 },
    white: { entityCount: 0, entitiesWithAliases: 0, aliasCount: 0 },
    sparkling: { entityCount: 0, entitiesWithAliases: 0, aliasCount: 0 },
  };
}

function toCriticalWineType(value: unknown): CriticalWineType | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'red' || normalized === 'white' || normalized === 'sparkling') {
    return normalized;
  }
  return undefined;
}

export function collectCriticalWineTypeCoverageFromEntities(
  entities: readonly EntitySnapshotRecord[],
): CriticalWineTypeCoverage {
  const coverage = emptyCriticalWineTypeCoverage();
  for (const entity of entities) {
    const wineType = toCriticalWineType(
      entity.attributes['wineType']
      ?? entity.attributes['wine_type']
      ?? entity.attributes['style'],
    );
    if (wineType !== undefined) {
      coverage[wineType] += 1;
    }
  }
  return coverage;
}

export function collectCriticalWineTypeCoverageFromPreparedFeed(
  docs: readonly PreparedVespaFeedDocument[],
): CriticalWineTypeCoverage {
  const coverage = emptyCriticalWineTypeCoverage();
  for (const doc of docs) {
    const wineType = toCriticalWineType(doc.fields['wine_type']);
    if (wineType !== undefined) {
      coverage[wineType] += 1;
    }
  }
  return coverage;
}

export function collectCriticalWineTypeAliasCoverage(
  entities: readonly EntitySnapshotRecord[],
  aliases: readonly AliasSnapshotRecord[],
): CriticalWineTypeAliasCoverage {
  const coverage = emptyCriticalWineTypeAliasCoverage();
  const wineTypeByEntityId = new Map<string, CriticalWineType>();
  const entitiesWithAliases = {
    red: new Set<string>(),
    white: new Set<string>(),
    sparkling: new Set<string>(),
  } satisfies Record<CriticalWineType, Set<string>>;

  for (const entity of entities) {
    const wineType = toCriticalWineType(
      entity.attributes['wineType']
      ?? entity.attributes['wine_type']
      ?? entity.attributes['style'],
    );
    if (wineType === undefined) {
      continue;
    }
    wineTypeByEntityId.set(entity.entityId, wineType);
    coverage[wineType] = {
      ...coverage[wineType],
      entityCount: coverage[wineType].entityCount + 1,
    };
  }

  for (const alias of aliases) {
    const wineType = wineTypeByEntityId.get(alias.entityId);
    if (wineType === undefined) {
      continue;
    }
    coverage[wineType] = {
      ...coverage[wineType],
      aliasCount: coverage[wineType].aliasCount + 1,
    };
    entitiesWithAliases[wineType].add(alias.entityId);
  }

  return {
    red: { ...coverage.red, entitiesWithAliases: entitiesWithAliases.red.size },
    white: { ...coverage.white, entitiesWithAliases: entitiesWithAliases.white.size },
    sparkling: { ...coverage.sparkling, entitiesWithAliases: entitiesWithAliases.sparkling.size },
  };
}

export function assertCriticalWineTypeCoverageForPublish(
  coverage: CriticalWineTypeCoverage,
  source: string,
  snapshotId: string,
): void {
  const missing = (Object.entries(coverage) as Array<[CriticalWineType, number]>)
    .filter(([, count]) => count <= 0)
    .map(([wineType]) => wineType);
  if (missing.length === 0) {
    return;
  }
  // Operator ack escape hatch (post-2026-05-25): the upstream Bronze
  // crawler may legitimately have collected only a subset of wine_types
  // (e.g. red-only corpus for an early-data restore). The default behavior
  // remains fail-loud because most publish runs SHOULD have full coverage
  // and a missing type is usually an ETL bug; but a single-type corpus is
  // a real operational state and the operator can acknowledge it
  // explicitly by exporting `ETL_PUBLISH_SINGLE_WINE_TYPE_ACK=YES`. We
  // log a WARN so the missing coverage shows up in the publish trail
  // even when ack is set.
  const ack = process.env['ETL_PUBLISH_SINGLE_WINE_TYPE_ACK'];
  if (ack === 'YES') {
    console.warn(
      `[publish] WARNING: snapshot ${snapshotId} is missing critical wine_type coverage in ${source}: ${missing.join(', ')}. `
      + `counts=${JSON.stringify(coverage)}. Proceeding because ETL_PUBLISH_SINGLE_WINE_TYPE_ACK=YES.`,
    );
    return;
  }
  throw new Error(
    `Snapshot ${snapshotId} is missing critical wine_type coverage in ${source}: ${missing.join(', ')}. `
    + `counts=${JSON.stringify(coverage)}. `
    + 'If the corpus is intentionally single-wine_type (e.g. red-only restore), '
    + 'set ETL_PUBLISH_SINGLE_WINE_TYPE_ACK=YES to acknowledge and proceed.',
  );
}

export async function assertSnapshotArtifactCriticalWineTypeCoverage(
  manifest: Pick<SearchSnapshotManifest, 'snapshotId' | 'artifacts'>,
): Promise<CriticalWineTypeArtifactCoverage> {
  const [entitiesRaw, aliasesRaw, vespaFeedRaw] = await Promise.all([
    fs.readFile(manifest.artifacts.entitiesNdjson, 'utf8'),
    fs.readFile(manifest.artifacts.aliasesNdjson, 'utf8'),
    fs.readFile(manifest.artifacts.vespaFeedNdjson, 'utf8'),
  ]);
  const entities = parseNdjson<EntitySnapshotRecord>(
    entitiesRaw,
    manifest.artifacts.entitiesNdjson,
  ).records;
  const aliases = parseNdjson<AliasSnapshotRecord>(
    aliasesRaw,
    manifest.artifacts.aliasesNdjson,
  ).records;
  const preparedDocs = parsePreparedVespaFeedDocuments(
    vespaFeedRaw,
    manifest.artifacts.vespaFeedNdjson,
  );

  const entityCoverage = collectCriticalWineTypeCoverageFromEntities(entities);
  const vespaCoverage = collectCriticalWineTypeCoverageFromPreparedFeed(preparedDocs);
  const aliasCoverage = collectCriticalWineTypeAliasCoverage(entities, aliases);
  assertCriticalWineTypeCoverageForPublish(entityCoverage, 'entities artifact', manifest.snapshotId);
  assertCriticalWineTypeCoverageForPublish(vespaCoverage, 'prepared Vespa feed', manifest.snapshotId);
  return { entityCoverage, vespaCoverage, aliasCoverage };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function writeCriticalWineTypeCoverageMetadata(
  manifest: Pick<SearchSnapshotManifest, 'artifacts'>,
  coverage: CriticalWineTypeArtifactCoverage,
): Promise<void> {
  let current: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(manifest.artifacts.metadataJson, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (isObjectRecord(parsed)) {
      current = parsed;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  await atomicWriteFile(
    manifest.artifacts.metadataJson,
    `${JSON.stringify(
      {
        ...current,
        criticalWineTypeCoverage: {
          entities: coverage.entityCoverage,
          preparedVespaFeed: coverage.vespaCoverage,
          aliases: coverage.aliasCoverage,
        },
      },
      null,
      2,
    )}\n`,
  );
}

async function loadManifest(manifestPath: string): Promise<SearchSnapshotManifest> {
  return parseManifest(await fs.readFile(manifestPath, 'utf8'), manifestPath);
}

async function rewriteSnapshotManifest(
  manifestPath: string,
  mutate: (manifest: SearchSnapshotManifest) => SearchSnapshotManifest,
): Promise<SearchSnapshotManifest> {
  const current = await loadManifest(manifestPath);
  const next = mutate(current);
  await atomicWriteFile(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export async function assertPreparedRollbackFeedAvailable(
  manifest: Pick<SearchSnapshotManifest, 'snapshotId' | 'artifacts'>,
): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(manifest.artifacts.vespaFeedNdjson, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Previous snapshot ${manifest.snapshotId} is missing an exact rollback artifact: ${message}`,
    );
  }

  try {
    parsePreparedVespaFeedDocuments(raw, manifest.artifacts.vespaFeedNdjson);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Previous snapshot ${manifest.snapshotId} does not have an exact rollback artifact: ${message}`,
    );
  }
}

export async function ensurePreparedRollbackFeedAvailable(args: {
  readonly manifest: SearchSnapshotManifest;
  readonly manifestPath: string;
  readonly fixtureRepoRoot?: string | undefined;
}): Promise<SearchSnapshotManifest> {
  try {
    await assertPreparedRollbackFeedAvailable(args.manifest);
    return args.manifest;
  } catch {
    return materializeExactVespaFeedForSnapshot({
      manifest: args.manifest,
      manifestPath: args.manifestPath,
      ...(args.fixtureRepoRoot !== undefined ? { fixtureRepoRoot: args.fixtureRepoRoot } : {}),
    });
  }
}

async function materializeExactVespaFeedForSnapshot(args: {
  readonly manifest: SearchSnapshotManifest;
  readonly manifestPath: string;
  readonly fixtureRepoRoot?: string | undefined;
  readonly previousPreparedManifest?: Pick<SearchSnapshotManifest, 'artifacts'> | undefined;
}): Promise<SearchSnapshotManifest> {
  try {
    await assertPreparedRollbackFeedAvailable(args.manifest);
    return args.manifest;
  } catch {
    // Fall through to exact-feed materialization when the artifact is absent or legacy.
  }
  const exactFeed = await materializePreparedVespaFeedArtifact({
    inputPath: args.manifest.artifacts.documentsNdjson,
    outputPath: args.manifest.artifacts.vespaFeedNdjson,
    snapshotId: args.manifest.snapshotId,
    ...(args.fixtureRepoRoot !== undefined ? { fixtureRepoRoot: args.fixtureRepoRoot } : {}),
    ...(args.previousPreparedManifest !== undefined
      ? { reuseEmbeddingFromPreparedFeedPath: args.previousPreparedManifest.artifacts.vespaFeedNdjson }
      : {}),
  });
  return rewriteSnapshotManifest(args.manifestPath, (manifest) => ({
    ...manifest,
    counts: {
      ...manifest.counts,
      vespaFeed: exactFeed.count,
    },
    hashes: {
      ...manifest.hashes,
      vespaFeed: exactFeed.hash,
    },
  }));
}

async function loadSnapshotEntityIds(entitiesPath: string): Promise<readonly string[]> {
  const raw = await fs.readFile(entitiesPath, 'utf8');
  return parseNdjson<EntitySnapshotRecord>(raw, entitiesPath).records
    .map((entity) => entity.entityId)
    .sort((left, right) => left.localeCompare(right));
}

async function loadPreparedFeedDocIds(preparedFeedPath: string): Promise<readonly string[]> {
  const raw = await fs.readFile(preparedFeedPath, 'utf8');
  return parsePreparedVespaFeedDocuments(raw, preparedFeedPath)
    .map((doc) => doc.id)
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

function createPublishVespaClient(): VespaClient {
  const config = loadConfig();
  const vespaMtls = config.vespa.certPath !== undefined && config.vespa.keyPath !== undefined
    ? { certPath: config.vespa.certPath, keyPath: config.vespa.keyPath }
    : undefined;
  return new VespaClient(config.vespa.url, VESPA_NAMESPACE, VESPA_DOC_TYPE, undefined, vespaMtls);
}

async function loadLiveVespaSnapshotDocIds(snapshotId: string): Promise<readonly string[]> {
  const vespa = createPublishVespaClient();
  const liveDocIds = new Set<string>();
  let offset = 0;
  let totalCount = Number.POSITIVE_INFINITY;

  while (offset < totalCount) {
    const response = await vespa.query(
      `select * from sources * where search_snapshot_id contains ${JSON.stringify(snapshotId)} `
      + `order by entity_id asc limit ${VESPA_SNAPSHOT_DOC_ID_QUERY_PAGE_SIZE} offset ${offset};`,
      { 'presentation.summary': 'full' },
    );
    totalCount = response.root.fields?.totalCount ?? 0;
    const hits = response.root.children ?? [];
    if (hits.length === 0) {
      break;
    }
    for (const hit of hits) {
      const entityId = typeof hit.fields['entity_id'] === 'string' ? hit.fields['entity_id'] : undefined;
      if (entityId === undefined || entityId.length === 0) {
        throw new Error(
          `Vespa live snapshot doc probe returned a hit without entity_id for snapshot ${snapshotId}`,
        );
      }
      liveDocIds.add(entityId);
    }
    offset += hits.length;
  }

  return [...liveDocIds].sort((left, right) => left.localeCompare(right));
}

export function diffSnapshotVespaDocIds(args: {
  readonly expectedDocIds: readonly string[];
  readonly liveDocIds: readonly string[];
}): {
  readonly missingDocIds: readonly string[];
  readonly staleDocIds: readonly string[];
} {
  const expectedSet = new Set(args.expectedDocIds);
  const liveSet = new Set(args.liveDocIds);
  return {
    missingDocIds: args.expectedDocIds.filter((docId) => !liveSet.has(docId)),
    staleDocIds: args.liveDocIds.filter((docId) => !expectedSet.has(docId)),
  };
}

async function deleteStaleVespaDocuments(docIds: readonly string[]): Promise<void> {
  if (docIds.length === 0) {
    return;
  }
  const vespa = createPublishVespaClient();
  for (const docId of docIds) {
    await vespa.delete(docId);
  }
}

async function reconcileTargetSnapshotVespaDocuments(
  snapshotId: string,
  expectedDocIds: readonly string[],
): Promise<void> {
  const liveDocIds = await loadLiveVespaSnapshotDocIds(snapshotId);
  const { staleDocIds } = diffSnapshotVespaDocIds({
    expectedDocIds,
    liveDocIds,
  });
  if (staleDocIds.length === 0) {
    return;
  }
  console.log(
    `🧹 Deleting ${staleDocIds.length} stale Vespa docs already present under target snapshot ${snapshotId}`,
  );
  await deleteStaleVespaDocuments(staleDocIds);
}

async function acquireSnapshotPublishLock() {
  const config = loadConfig();
  if (!shouldUsePgPool(config.pg)) {
    throw new Error('Postgres configuration is required to acquire search snapshot publish lock');
  }
  const pool = createPgPool(config.pg, {
    statementTimeoutMs: 15_000,
    idleInTransactionSessionTimeoutMs: 15_000,
    queryTimeoutMs: 20_000,
  });
  const ownerId = `publish-search-snapshot:${process.pid}:${Date.now()}:${randomUUID()}`;
  const leaseInterval = `${SNAPSHOT_PUBLISH_LOCK_LEASE_MS} milliseconds`;
  let lockConnectionError: Error | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let heartbeatInFlight = false;
  let released = false;

  const acquireLease = async (): Promise<void> => {
    await pool.query(
      `INSERT INTO search_snapshot_publish_lock (
         id,
         owner_id,
         fencing_token,
         lease_expires_at,
         acquired_at,
         heartbeat_at
       )
       VALUES (1, NULL, 0, NULL, NULL, NULL)
       ON CONFLICT (id) DO NOTHING`,
    );
    const acquired = await pool.query<{ fencing_token: string }>(
      `UPDATE search_snapshot_publish_lock
         SET owner_id = $1,
             fencing_token = CASE WHEN owner_id = $1 THEN fencing_token ELSE fencing_token + 1 END,
             lease_expires_at = NOW() + $2::interval,
             acquired_at = CASE WHEN owner_id = $1 THEN acquired_at ELSE NOW() END,
             heartbeat_at = NOW()
       WHERE id = 1
         AND (owner_id IS NULL OR lease_expires_at <= NOW() OR owner_id = $1)
       RETURNING fencing_token`,
      [ownerId, leaseInterval],
    );
    if (acquired.rowCount === 0) {
      const current = await pool.query<{ owner_id: string | null; lease_expires_at: string | null }>(
        `SELECT owner_id, lease_expires_at
         FROM search_snapshot_publish_lock
         WHERE id = 1`,
      );
      const heldBy = current.rows[0]?.owner_id ?? '<unknown-owner>';
      const expiresAt = current.rows[0]?.lease_expires_at ?? '<unknown-expiry>';
      throw new Error(
        `search snapshot publish lease is already held by ${heldBy} until ${expiresAt}`,
      );
    }
  };

  const renewLease = async (): Promise<void> => {
    if (released || heartbeatInFlight) {
      return;
    }
    heartbeatInFlight = true;
    try {
      const renewed = await pool.query(
        `UPDATE search_snapshot_publish_lock
           SET lease_expires_at = NOW() + $2::interval,
               heartbeat_at = NOW()
         WHERE id = 1
           AND owner_id = $1
         RETURNING fencing_token`,
        [ownerId, leaseInterval],
      );
      if (renewed.rowCount === 0 && lockConnectionError === undefined) {
        lockConnectionError = new Error('snapshot publish lease lost ownership');
        console.error(lockConnectionError.message);
      }
    } catch (error) {
      if (lockConnectionError === undefined) {
        lockConnectionError = error instanceof Error ? error : new Error(String(error));
        console.error(`snapshot publish lock heartbeat failed: ${lockConnectionError.message}`);
      }
    } finally {
      heartbeatInFlight = false;
    }
  };

  await acquireLease();
  heartbeatTimer = setInterval(() => {
    void renewLease();
  }, SNAPSHOT_PUBLISH_LOCK_HEARTBEAT_MS);
  return {
    assertHeld(): void {
      if (lockConnectionError !== undefined) {
        throw new Error(
          `snapshot publish lock lease was lost: ${lockConnectionError.message}`,
        );
      }
    },
    async release(): Promise<void> {
      released = true;
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      try {
        await pool.query(
          `UPDATE search_snapshot_publish_lock
             SET owner_id = NULL,
                 lease_expires_at = NULL,
                 acquired_at = NULL,
                 heartbeat_at = NULL
           WHERE id = 1
             AND owner_id = $1`,
          [ownerId],
        );
      } finally {
        await pool.end();
      }
    },
  };
}

async function rollbackToPreviousSnapshot(args: {
  readonly previousRuntimeState: Awaited<ReturnType<typeof loadPublishedRuntimeState>>;
  readonly previousManifest?: SearchSnapshotManifest | undefined;
  readonly runtimeStatePath: string;
  readonly newSnapshotEntityIds: readonly string[];
  readonly publishPhase: SnapshotPublishPhase;
  readonly fixtureRepoRoot?: string | undefined;
}): Promise<void> {
  // T-010/W2: phase-aware rollback. Pointer rollback is derived from the
  // publish state machine, not a separate boolean that can drift from phase.
  if (hasSnapshotPublishReachedPhase(args.publishPhase, 'pointer_promoted')) {
    try {
      const { rolledBackTo, from } = await rollbackActiveSearchSnapshotPointer();
      console.log(`↩️ Active snapshot pointer rolled back: ${from} → ${rolledBackTo}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/no previous snapshot|No active_search_snapshot/.test(msg)) {
        console.warn(`↩️ Pointer rollback non-fatal: ${msg}`);
      }
    }
  } else {
    console.log('↩️ Skipping pointer rollback: publish did not reach pointer promotion');
  }

  const previousState = args.previousRuntimeState;
  if (previousState === undefined || args.previousManifest === undefined) {
    await deleteStaleVespaDocuments(args.newSnapshotEntityIds);
    return;
  }
  const previousEntityIds = await loadSnapshotEntityIds(args.previousManifest.artifacts.entitiesNdjson);
  await runIndexer(
    args.previousManifest.artifacts.vespaFeedNdjson,
    args.previousManifest.snapshotId,
    'prepared-feed',
    args.fixtureRepoRoot,
  );
  const previousEntityIdSet = new Set(previousEntityIds);
  const staleDocIds = args.newSnapshotEntityIds.filter((entityId) => !previousEntityIdSet.has(entityId));
  await deleteStaleVespaDocuments(staleDocIds);
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

    if (candidateSnapshotIds.length === 0) {
      throw new Error(
        `No active LTR models found for snapshot ${args.nextManifest.snapshotId}; train LTR for the snapshot before publish`,
      );
    }
    throw new Error(
      `No compatible active snapshot-bound LTR source could be cloned into ${args.nextManifest.snapshotId}; retrain LTR for the new snapshot`,
    );
  } finally {
    await pool.end();
  }
}

function assertManifestQualityForCanonicalPublish(manifest: SearchSnapshotManifest): void {
  if (manifest.quality.experimentalInputsPresent) {
    throw new Error(
      `Refusing canonical publish for ${manifest.snapshotId}: experimental inputs present`,
    );
  }
  if (manifest.quality.blockers.length > 0) {
    throw new Error(
      `Refusing canonical publish for ${manifest.snapshotId}: quality blockers=${manifest.quality.blockers.join(', ')}`,
    );
  }
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  assertCanonicalTrackCArtifactInput(args.input, 'publish-search-snapshot');
  const built = await buildSearchSnapshot({
    input: args.input,
    outputDir: args.outputDir,
    nlMappings: args.nlMappings,
    fixtureRepoRoot: args.fixtureRepoRoot,
    runtimeStatePath: args.runtimeStatePath,
  });
  assertManifestQualityForCanonicalPublish(built.manifest);
  console.log(`🧱 Built search snapshot ${built.manifest.snapshotId}`);

  if (args.skipIndex) {
    console.log('📥 Skipping Vespa indexing and runtime cutover (--skip-index)');
    console.log(`Built search snapshot ${built.manifest.snapshotId} without cutover`);
    return;
  }

  const fixtureRoot = resolvePublishFixtureRepoRoot(args.fixtureRepoRoot);
  const cutoverPaths = resolveRuntimeSubstrateCutoverPaths({
    snapshotId: built.manifest.snapshotId,
    runtimeStatePath: args.runtimeStatePath,
    runtimeNlMappingsPath: args.runtimeNlMappingsPath,
  });
  const { stagedRuntimeStatePath, stagedRuntimeNlMappingsPath } = cutoverPaths;
  const snapshotRootDir = path.dirname(path.dirname(built.manifest.artifacts.vespaFeedNdjson));
  const [previousRuntimeState, newSnapshotEntityIds] = await Promise.all([
    loadPublishedRuntimeState(args.runtimeStatePath),
    loadSnapshotEntityIds(built.manifest.artifacts.entitiesNdjson),
  ]);
  const [previousRuntimeStateContents, previousRuntimeNlMappingsContents] = await Promise.all([
    readOptionalTextFile(args.runtimeStatePath),
    readOptionalTextFile(args.runtimeNlMappingsPath),
  ]);
  const previousManifest = previousRuntimeState !== undefined
    ? await loadManifest(previousRuntimeState.manifestPath)
    : undefined;
  const previousPreparedManifest = previousManifest !== undefined
    ? await ensurePreparedRollbackFeedAvailable({
      manifest: previousManifest,
      manifestPath: previousRuntimeState!.manifestPath,
      fixtureRepoRoot: fixtureRoot,
    })
    : undefined;

  const publishLock = await acquireSnapshotPublishLock();
  let runtimeState: Awaited<ReturnType<typeof publishRuntimeSubstrates>> | undefined;
  const publishState = createSnapshotPublishStateMachine();
  try {
    try {
      // Schema / application-package deploy is OUT OF SCOPE for this
      // script. Self-hosted Vespa schemas are deployed separately against
      // the config server (typically `POST :19071/application/v2/tenant/
      // default/prepareandactivate` with the `vespa/app/` zip). Keeping
      // it out of this path prevents the `vespa` CLI default-cloud-target
      // footgun that wiped the corpus on 2026-05-25.
      console.log('🧾 Materializing exact Vespa replay artifact');
      const manifestWithExactFeed = await materializeExactVespaFeedForSnapshot({
        manifest: built.manifest,
        manifestPath: built.manifestPath,
        fixtureRepoRoot: fixtureRoot,
        previousPreparedManifest,
      });
      const newSnapshotPreparedDocIds = await loadPreparedFeedDocIds(
        manifestWithExactFeed.artifacts.vespaFeedNdjson,
      );
      const artifactCoverage = await assertSnapshotArtifactCriticalWineTypeCoverage(
        manifestWithExactFeed,
      );
      await writeCriticalWineTypeCoverageMetadata(manifestWithExactFeed, artifactCoverage);
      console.log(
        `🍇 Verified critical wine_type artifact coverage: entities=${JSON.stringify(artifactCoverage.entityCoverage)} `
        + `vespa=${JSON.stringify(artifactCoverage.vespaCoverage)} `
        + `aliases=${JSON.stringify(artifactCoverage.aliasCoverage)}`,
      );
      console.log('🚦 Ensuring snapshot-bound LTR readiness');
      await ensureSnapshotBoundLtrModels({
        previousRuntimeState,
        previousManifest: previousPreparedManifest,
        nextManifest: manifestWithExactFeed,
        snapshotRootDir,
      });
      console.log('📥 Indexing document plane into Vespa');
      await runIndexer(
        manifestWithExactFeed.artifacts.vespaFeedNdjson,
        manifestWithExactFeed.snapshotId,
        'prepared-feed',
        fixtureRoot,
      );
      publishLock.assertHeld();
      publishState.advance('vespa_indexed');
      if (
        previousRuntimeState !== undefined
        && previousRuntimeState.snapshotId !== manifestWithExactFeed.snapshotId
      ) {
        console.log(`🧹 Deleting stale Vespa docs from previous snapshot ${previousRuntimeState.snapshotId}`);
        const currentRuntimeEntityIds = await loadCurrentRuntimeEntityIds(previousRuntimeState.snapshotId);
        const nextEntityIdSet = new Set(newSnapshotEntityIds);
        const staleDocIds = currentRuntimeEntityIds.filter((entityId) => !nextEntityIdSet.has(entityId));
        await deleteStaleVespaDocuments(staleDocIds);
      }
      await reconcileTargetSnapshotVespaDocuments(
        manifestWithExactFeed.snapshotId,
        newSnapshotPreparedDocIds,
      );
      console.log('🗄️ Publishing runtime substrates');
      runtimeState = await publishRuntimeSubstrates({
        manifestPath: built.manifestPath,
        runtimeStatePath: stagedRuntimeStatePath,
        runtimeNlMappingsPath: args.runtimeNlMappingsPath,
      });
      publishState.advance('runtime_substrates_published');
      console.log('✅ Verifying search snapshot readiness');
      await verifySearchSnapshotReadiness({
        runtimeStatePath: stagedRuntimeStatePath,
        manifestPath: built.manifestPath,
        requirePointerParity: false,
      });
      console.log('🎯 Verifying runtime gold catalog coverage');
      const config = loadConfig();
      if (!shouldUsePgPool(config.pg)) {
        throw new Error('Postgres configuration is required for runtime gold coverage verification');
      }
      const coveragePool = createPgPool(config.pg);
      try {
        const coverage = await verifyRuntimeGoldCatalogCoverage({
          pool: coveragePool,
          snapshotId: manifestWithExactFeed.snapshotId,
          fixtureRepoRoot: fixtureRoot,
        });
        console.log(
          `🎯 Runtime gold coverage passed: ${coverage.requiredCanonicalIds} canonical id(s) confirmed`,
        );
      } finally {
        await coveragePool.end();
      }
      console.log('🔁 Atomic DB pointer promote — active_search_snapshot');
      await promoteActiveSearchSnapshotPointer({
        snapshotId: manifestWithExactFeed.snapshotId,
        previousSnapshotId: previousRuntimeState?.snapshotId,
        contentHash: runtimeState.contentHash ?? manifestWithExactFeed.snapshotId,
      });
      publishState.advance('pointer_promoted');
      console.log('🔁 Re-verifying readiness with pointer parity (post-promote)');
      await verifySearchSnapshotReadiness({
        runtimeStatePath: stagedRuntimeStatePath,
        manifestPath: built.manifestPath,
        requirePointerParity: true,
      });
      console.log('📌 Promoting runtime substrate files');
      runtimeState = await promoteRuntimeSubstrateArtifacts(cutoverPaths);
      publishState.advance('runtime_artifacts_promoted');
      console.log('✅ Verifying readiness after runtime substrate promotion');
      await verifySearchSnapshotReadiness({
        runtimeStatePath: args.runtimeStatePath,
        manifestPath: built.manifestPath,
        requirePointerParity: true,
      });
    } catch (error) {
      console.error(`↩️ Publish failed during phase=${publishState.current}; attempting rollback`);
      const publishMessage = error instanceof Error ? error.message : String(error);
      const rollbackFailures: string[] = [];
      await Promise.all([
        fs.rm(stagedRuntimeStatePath, { force: true }),
        fs.rm(stagedRuntimeNlMappingsPath, { force: true }),
      ]);
      try {
        await rollbackToPreviousSnapshot({
          previousRuntimeState,
          previousManifest,
          runtimeStatePath: args.runtimeStatePath,
          newSnapshotEntityIds,
          publishPhase: publishState.current,
          fixtureRepoRoot: fixtureRoot,
        });
      } catch (rollbackError) {
        rollbackFailures.push(
          `pointer/Vespa rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
      try {
        await restoreRuntimeSubstrateArtifacts({
          activeRuntimeStatePath: args.runtimeStatePath,
          previousRuntimeStateContents,
          activeRuntimeNlMappingsPath: args.runtimeNlMappingsPath,
          previousRuntimeNlMappingsContents,
        });
      } catch (restoreError) {
        rollbackFailures.push(
          `runtime substrate restore failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
        );
      }
      if (rollbackFailures.length > 0) {
        throw new Error(`search snapshot publish failed: ${publishMessage}; ${rollbackFailures.join('; ')}`);
      }
      throw error;
    }
    if (runtimeState === undefined) {
      throw new Error('Publish state machine completed without producing a runtime state');
    }
  } finally {
    await publishLock.release();
  }

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
