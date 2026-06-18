/** One-off: run a single query through the EntityLookupV2 authority and dump the full decision. */
import 'dotenv/config';
import process from 'node:process';
import { loadConfig } from '../../src/config/env.js';
import { createLookupDirectContainer } from '../../src/config/container-lookup.js';
import { getPgPool } from '../../src/infrastructure/db/pg-pool.js';
import { LOOKUP_V2_DEFAULT_MAX_CANDIDATES } from '../../src/interface/http/constants.js';
import {
  DEFAULT_RUNTIME_STATE_PATH,
  loadSearchSnapshotRuntimeState,
} from '../../src/infrastructure/health/search-snapshot-readiness.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== '--');
  let runtimeStatePath: string | undefined;
  let useActiveRuntime = false;
  const queryParts: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--runtime-state') {
      runtimeStatePath = argv[index + 1] ?? runtimeStatePath;
      index += 1;
      continue;
    }
    if (arg === '--use-active-runtime') {
      useActiveRuntime = true;
      continue;
    }
    queryParts.push(arg);
  }
  if (runtimeStatePath === undefined && !useActiveRuntime) {
    throw new Error('Explicit runtime binding required: pass --runtime-state <path> or --use-active-runtime');
  }
  const query = queryParts.join(' ') || '2018 Orin Swift Papillon';
  const config = loadConfig();
  const pool = getPgPool();
  const effectiveRuntimeStatePath = runtimeStatePath ?? DEFAULT_RUNTIME_STATE_PATH;
  const runtimeState = await loadSearchSnapshotRuntimeState(effectiveRuntimeStatePath);
  const container = await createLookupDirectContainer(config, {
    pool,
    searchSnapshotId: runtimeState.snapshotId,
    searchSnapshotManifestPath: runtimeState.manifestPath,
    searchSnapshotFieldAvailability: runtimeState.fieldAvailability,
  });

  process.stderr.write(`\n===== QUERY: ${query} =====\n`);
  process.stderr.write(`runtime_state=${effectiveRuntimeStatePath}\n`);
  process.stderr.write(`snapshot_id=${runtimeState.snapshotId}\n`);

  const v2 = await container.entityLookupV2UseCase.execute(
    { query, maxCandidates: LOOKUP_V2_DEFAULT_MAX_CANDIDATES, mode: 'default', requestId: 'debug-1' },
    {},
  );
  process.stderr.write(`V2 status=${v2.status}\n`);
  process.stderr.write(`V2 top=${v2.topCandidate ? `${String(v2.topCandidate.entityId)} (${v2.topCandidate.canonicalLabel})` : 'null'}\n`);
  process.stderr.write(`V2 full result:\n${JSON.stringify(v2, null, 2).slice(0, 4000)}\n`);

  // V2-only cutover: the legacy `/v1` lookup seam was removed — EntityLookupV2
  // (above) is the sole lookup authority, so there is no V1 path to dump.
  await pool.end();
}

main().catch((err: unknown) => {
  process.stderr.write(`debug failed: ${(err as Error).message}\n${(err as Error).stack ?? ''}\n`);
  process.exitCode = 1;
});
