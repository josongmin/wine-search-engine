#!/usr/bin/env tsx

import { parseArgs } from 'node:util';
import {
  DEFAULT_RUNTIME_STATE_PATH,
  loadSearchSnapshotRuntimeState,
} from '../../src/infrastructure/health/search-snapshot-readiness.js';
import { backfillLookupRuntimeBundleCacheFromManifest } from '../../src/config/lookup-runtime-bundle.js';
import { deriveLookupRuntimeBundleCachePaths } from '../../src/config/lookup-runtime-bundle-cache.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      manifest: { type: 'string' },
      runtimeStatePath: { type: 'string', default: DEFAULT_RUNTIME_STATE_PATH },
    },
    strict: true,
    allowPositionals: false,
  });

  const manifestPath = values.manifest
    ?? (await loadSearchSnapshotRuntimeState(values.runtimeStatePath ?? DEFAULT_RUNTIME_STATE_PATH)).manifestPath;

  await backfillLookupRuntimeBundleCacheFromManifest(manifestPath);
  const paths = deriveLookupRuntimeBundleCachePaths(manifestPath);
  console.log(`lookup_runtime_bundle_cache_manifest=${manifestPath}`);
  console.log(`lookup_runtime_bundle_cache_v8=${paths.cachePath}`);
  console.log(`lookup_runtime_bundle_cache_meta=${paths.metaPath}`);
}

main().catch((error) => {
  console.error(
    `[build-lookup-runtime-bundle-cache] fatal: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
