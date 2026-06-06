import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseManifest, type SearchSnapshotManifest, type SearchSnapshotRuntimeState } from './search-snapshot-schema.js';
import { loadSearchSnapshotRuntimeState } from '../../src/infrastructure/health/search-snapshot-readiness.js';
import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';
import { SEARCH_SNAPSHOT_STATE_VERSION } from '../../src/domain/shared/constants/search-snapshot.js';
import { hashStableJson } from '../../src/domain/shared/utils/stable-json.js';

const DEFAULT_RUNTIME_STATE_PATH = resolveDataPath('data/runtime-search-snapshot.json');
const DEFAULT_ACTIVE_NL_MAPPINGS_PATH = resolveDataPath('data/nl-mappings.json');

export interface RuntimeStateMigrationResult {
  readonly action: 'noop' | 'rewritten' | 'retired';
  readonly runtimeStatePath: string;
  readonly backupPath?: string | undefined;
  readonly snapshotId?: string | undefined;
  readonly reason?: string | undefined;
}

function parseArgs(argv: readonly string[]): {
  readonly runtimeStatePath: string;
  readonly activeNlMappingsPath: string;
  readonly manifestPath?: string;
} {
  let runtimeStatePath = DEFAULT_RUNTIME_STATE_PATH;
  let activeNlMappingsPath = DEFAULT_ACTIVE_NL_MAPPINGS_PATH;
  let manifestPath: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--runtime-state') {
      runtimeStatePath = argv[i + 1] ?? runtimeStatePath;
      i += 1;
      continue;
    }
    if (arg === '--active-nl-mappings') {
      activeNlMappingsPath = argv[i + 1] ?? activeNlMappingsPath;
      i += 1;
      continue;
    }
    if (arg === '--manifest') {
      manifestPath = argv[i + 1] ?? manifestPath;
      i += 1;
    }
  }
  return { runtimeStatePath, activeNlMappingsPath, manifestPath };
}

function buildBackupPath(runtimeStatePath: string): string {
  const timestamp = new Date().toISOString().replaceAll(':', '-');
  const ext = path.extname(runtimeStatePath);
  const stem = ext.length > 0
    ? runtimeStatePath.slice(0, -ext.length)
    : runtimeStatePath;
  return `${stem}.legacy-${timestamp}${ext.length > 0 ? ext : '.json'}`;
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

function synthesizeRuntimeStateFromManifest(args: {
  readonly manifest: SearchSnapshotManifest;
  readonly manifestPath: string;
  readonly activeNlMappingsPath: string;
}): SearchSnapshotRuntimeState {
  return {
    schemaVersion: SEARCH_SNAPSHOT_STATE_VERSION,
    snapshotId: args.manifest.snapshotId,
    contentHash: args.manifest.contentHash,
    publishedAt: new Date().toISOString(),
    manifestPath: args.manifestPath,
    nlMappingsRuntimePath: args.activeNlMappingsPath,
    lookupAliasRuntimePath: args.manifest.artifacts.lookupAliasRuntimeJson,
    ...(args.manifest.artifacts.lookupAliasBroadRecallRuntimeJson !== undefined
      ? { lookupAliasBroadRecallRuntimePath: args.manifest.artifacts.lookupAliasBroadRecallRuntimeJson }
      : {}),
    lookupExactSafeRuntimePath: args.manifest.artifacts.lookupExactSafeRuntimeJson,
    lookupResolverProjectionPath: args.manifest.artifacts.lookupResolverProjectionJson,
    lookupEntityProjectionPath: args.manifest.artifacts.lookupEntityProjectionJson,
    lookupSemanticScopeRuntimePath: args.manifest.artifacts.lookupSemanticScopeRuntimeJson,
    lookupReviewedFamilyRecallRuntimePath: args.manifest.artifacts.lookupReviewedFamilyRecallRuntimeJson,
    lookupScopeGraphRuntimePath: args.manifest.artifacts.lookupScopeGraphRuntimeJson,
    lookupAmbiguityRuntimePath: args.manifest.artifacts.lookupAmbiguityRuntimeJson,
    lookupConceptRedirectRuntimePath: args.manifest.artifacts.lookupConceptRedirectRuntimeJson,
    quality: args.manifest.quality,
    fieldAvailability: args.manifest.fieldAvailability,
    counts: {
      entities: args.manifest.counts.entities,
      aliases: args.manifest.counts.aliases,
      lookupAliasRuntimeAliases: args.manifest.counts.lookupAliasRuntimeAliases,
      ...(args.manifest.counts.lookupAliasBroadRecallRuntimeEntries !== undefined
        ? { lookupAliasBroadRecallRuntimeEntries: args.manifest.counts.lookupAliasBroadRecallRuntimeEntries }
        : {}),
      lookupExactSafeRuntimeEntries: args.manifest.counts.lookupExactSafeRuntimeEntries,
      lookupResolverProjectionDocuments: args.manifest.counts.lookupResolverProjectionDocuments,
      lookupEntityProjectionDocuments: args.manifest.counts.lookupEntityProjectionDocuments,
      lookupSemanticScopeRuntimeEntries: args.manifest.counts.lookupSemanticScopeRuntimeEntries,
      lookupReviewedFamilyRecallRuntimeEntries: args.manifest.counts.lookupReviewedFamilyRecallRuntimeEntries,
      lookupScopeGraphRuntimeEdges: args.manifest.counts.lookupScopeGraphRuntimeEdges,
      lookupAmbiguityRuntimeEntries: args.manifest.counts.lookupAmbiguityRuntimeEntries,
      lookupConceptRedirectRuntimeEntries: args.manifest.counts.lookupConceptRedirectRuntimeEntries,
      ambiguityRegistry: args.manifest.counts.ambiguityRegistry,
      nlMappings: args.manifest.counts.nlMappings,
      activeLtrModels: 0,
    },
    hashes: {
      entities: args.manifest.hashes.entities,
      aliases: args.manifest.hashes.aliases,
      lookupAliasRuntime: args.manifest.hashes.lookupAliasRuntime,
      ...(args.manifest.hashes.lookupAliasBroadRecallRuntime !== undefined
        ? { lookupAliasBroadRecallRuntime: args.manifest.hashes.lookupAliasBroadRecallRuntime }
        : {}),
      lookupExactSafeRuntime: args.manifest.hashes.lookupExactSafeRuntime,
      lookupResolverProjection: args.manifest.hashes.lookupResolverProjection,
      lookupEntityProjection: args.manifest.hashes.lookupEntityProjection,
      lookupSemanticScopeRuntime: args.manifest.hashes.lookupSemanticScopeRuntime,
      lookupReviewedFamilyRecallRuntime: args.manifest.hashes.lookupReviewedFamilyRecallRuntime,
      lookupScopeGraphRuntime: args.manifest.hashes.lookupScopeGraphRuntime,
      lookupAmbiguityRuntime: args.manifest.hashes.lookupAmbiguityRuntime,
      lookupConceptRedirectRuntime: args.manifest.hashes.lookupConceptRedirectRuntime,
      ambiguityRegistry: args.manifest.hashes.ambiguityRegistry,
      nlMappings: args.manifest.hashes.nlMappings,
      activeLtrModels: hashStableJson([]),
    },
  };
}

export async function migrateRuntimeSearchSnapshotState(args?: {
  readonly runtimeStatePath?: string | undefined;
  readonly activeNlMappingsPath?: string | undefined;
  readonly manifestPath?: string | undefined;
}): Promise<RuntimeStateMigrationResult> {
  const runtimeStatePath = args?.runtimeStatePath ?? DEFAULT_RUNTIME_STATE_PATH;
  const activeNlMappingsPath = args?.activeNlMappingsPath ?? DEFAULT_ACTIVE_NL_MAPPINGS_PATH;
  const explicitManifestPath = args?.manifestPath;

  if (explicitManifestPath !== undefined) {
    const existing = await readOptionalFile(runtimeStatePath);
    const backupPath = existing === undefined ? undefined : buildBackupPath(runtimeStatePath);
    if (backupPath !== undefined) {
      await fs.copyFile(runtimeStatePath, backupPath);
    }
    const manifestRaw = await fs.readFile(explicitManifestPath, 'utf8');
    const manifest = parseManifest(manifestRaw, explicitManifestPath);
    const nextState = synthesizeRuntimeStateFromManifest({
      manifest,
      manifestPath: explicitManifestPath,
      activeNlMappingsPath,
    });
    await fs.writeFile(runtimeStatePath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
    return {
      action: 'rewritten',
      runtimeStatePath,
      backupPath,
      snapshotId: nextState.snapshotId,
      reason: 'explicit_manifest_promote',
    };
  }

  try {
    const state = await loadSearchSnapshotRuntimeState(runtimeStatePath);
    return {
      action: 'noop',
      runtimeStatePath,
      snapshotId: state.snapshotId,
      reason: 'already_current_contract',
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        action: 'noop',
        runtimeStatePath,
        reason: 'missing_runtime_state',
      };
    }
  }

  const raw = await readOptionalFile(runtimeStatePath);
  if (raw === undefined) {
    return {
      action: 'noop',
      runtimeStatePath,
      reason: 'missing_runtime_state',
    };
  }

  let manifestPath: string | undefined;
  try {
    const parsed = JSON.parse(raw) as { manifestPath?: unknown };
    if (typeof parsed.manifestPath === 'string' && parsed.manifestPath.length > 0) {
      manifestPath = parsed.manifestPath;
    }
  } catch {
    manifestPath = undefined;
  }

  const backupPath = buildBackupPath(runtimeStatePath);
  await fs.copyFile(runtimeStatePath, backupPath);

  if (manifestPath !== undefined) {
    try {
      const manifestRaw = await fs.readFile(manifestPath, 'utf8');
      const manifest = parseManifest(manifestRaw, manifestPath);
      const nextState = synthesizeRuntimeStateFromManifest({
        manifest,
        manifestPath,
        activeNlMappingsPath,
      });
      await fs.writeFile(runtimeStatePath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
      return {
        action: 'rewritten',
        runtimeStatePath,
        backupPath,
        snapshotId: nextState.snapshotId,
      };
    } catch {
      // Fall through to retire the active pointer when the previous manifest
      // cannot satisfy the current contract.
    }
  }

  await fs.unlink(runtimeStatePath);
  return {
    action: 'retired',
    runtimeStatePath,
    backupPath,
    reason: manifestPath === undefined
      ? 'missing_manifest_path'
      : 'manifest_not_current_contract',
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await migrateRuntimeSearchSnapshotState(args);
  console.log(JSON.stringify(result, null, 2));
}

const invokedAsMain = process.argv[1] !== undefined
  && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedAsMain) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
