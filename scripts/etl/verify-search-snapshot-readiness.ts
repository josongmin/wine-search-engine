#!/usr/bin/env tsx

import fs from 'node:fs/promises';
import { loadConfig } from '../../src/config/env.js';
import { createPgPool, shouldUsePgPool } from '../../src/infrastructure/db/pg-pool.js';
import { resolveDataPath } from '../../src/shared/utils/data-paths.js';
import {
  loadSearchSnapshotRuntimeState,
  verifySearchSnapshotRuntimeStateLive,
} from '../../src/infrastructure/health/search-snapshot-readiness.js';
import {
  parseManifest,
} from './search-snapshot-schema.js';
import {
  SEARCH_SNAPSHOT_SCHEMA_VERSION,
  SEARCH_SNAPSHOT_STATE_VERSION,
} from '../../src/shared/constants/search-snapshot.js';

const DEFAULT_RUNTIME_STATE_PATH = resolveDataPath('data/runtime-search-snapshot.json');

interface Args {
  readonly runtimeStatePath: string;
  readonly manifestPath?: string;
  /** T-010/W2: when true, assert active_search_snapshot pointer = runtime state snapshotId. */
  readonly requirePointerParity?: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let runtimeStatePath = DEFAULT_RUNTIME_STATE_PATH;
  let manifestPath: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--runtime-state') {
      runtimeStatePath = argv[i + 1] ?? DEFAULT_RUNTIME_STATE_PATH;
      i += 1;
    } else if (arg === '--manifest' || arg === '-m') {
      manifestPath = argv[i + 1];
      i += 1;
    }
  }
  return manifestPath !== undefined
    ? { runtimeStatePath, manifestPath }
    : { runtimeStatePath };
}

export async function verifySearchSnapshotReadiness(args: Args): Promise<void> {
  const config = loadConfig();
  if (!shouldUsePgPool(config.pg)) {
    throw new Error('Postgres configuration is required for readiness verification');
  }

  const runtimeState = await loadSearchSnapshotRuntimeState(args.runtimeStatePath);
  const manifest = args.manifestPath !== undefined
    ? parseManifest(await fs.readFile(args.manifestPath, 'utf8'), args.manifestPath)
    : parseManifest(await fs.readFile(runtimeState.manifestPath, 'utf8'), runtimeState.manifestPath);

  if (runtimeState.schemaVersion !== SEARCH_SNAPSHOT_STATE_VERSION) {
    throw new Error(`Runtime state schema version ${runtimeState.schemaVersion} != expected ${SEARCH_SNAPSHOT_STATE_VERSION}`);
  }
  if (manifest.schemaVersion !== SEARCH_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`Manifest schema version ${manifest.schemaVersion} != expected ${SEARCH_SNAPSHOT_SCHEMA_VERSION}`);
  }

  if (runtimeState.snapshotId !== manifest.snapshotId) {
    throw new Error(`Runtime state snapshot_id ${runtimeState.snapshotId} != manifest ${manifest.snapshotId}`);
  }
  if (runtimeState.contentHash !== manifest.contentHash) {
    throw new Error(`Runtime state content hash ${runtimeState.contentHash} != manifest ${manifest.contentHash}`);
  }

  const pool = createPgPool(config.pg);
  try {
    await verifySearchSnapshotRuntimeStateLive({
      pool,
      vespaUrl: config.vespa.url,
      runtimeState,
      strictHashes: true,
      ...(args.requirePointerParity === true ? { requirePointerParity: true } : {}),
    });

    if (runtimeState.counts.aliases !== manifest.counts.aliases) {
      throw new Error(`Alias state/manifest mismatch: state=${runtimeState.counts.aliases}, manifest=${manifest.counts.aliases}`);
    }
    if (runtimeState.counts.entities !== manifest.counts.entities) {
      throw new Error(`Entity state/manifest mismatch: state=${runtimeState.counts.entities}, manifest=${manifest.counts.entities}`);
    }
    if (runtimeState.counts.ambiguityRegistry !== manifest.counts.ambiguityRegistry) {
      throw new Error(`Ambiguity state/manifest mismatch: state=${runtimeState.counts.ambiguityRegistry}, manifest=${manifest.counts.ambiguityRegistry}`);
    }
    if (runtimeState.counts.nlMappings !== manifest.counts.nlMappings) {
      throw new Error(`NL mapping state/manifest mismatch: state=${runtimeState.counts.nlMappings}, manifest=${manifest.counts.nlMappings}`);
    }
    if (runtimeState.hashes.entities !== manifest.hashes.entities) {
      throw new Error(`Entity state/manifest hash mismatch: state=${runtimeState.hashes.entities}, manifest=${manifest.hashes.entities}`);
    }
    if (runtimeState.hashes.aliases !== manifest.hashes.aliases) {
      throw new Error(`Alias state/manifest hash mismatch: state=${runtimeState.hashes.aliases}, manifest=${manifest.hashes.aliases}`);
    }
    if (runtimeState.hashes.ambiguityRegistry !== manifest.hashes.ambiguityRegistry) {
      throw new Error(`Ambiguity state/manifest hash mismatch: state=${runtimeState.hashes.ambiguityRegistry}, manifest=${manifest.hashes.ambiguityRegistry}`);
    }
    if (runtimeState.hashes.nlMappings !== manifest.hashes.nlMappings) {
      throw new Error(`NL mapping state/manifest hash mismatch: state=${runtimeState.hashes.nlMappings}, manifest=${manifest.hashes.nlMappings}`);
    }
    if (runtimeState.counts.activeLtrModels <= 0 && !runtimeState.allowMissingLtr) {
      throw new Error('Active LTR model count is zero and runtime state does not explicitly allow no-LTR mode');
    }
  } finally {
    await pool.end();
  }
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await verifySearchSnapshotReadiness(args);
  console.log('search_snapshot_readiness=passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${message}`);
    process.exit(1);
  });
}
