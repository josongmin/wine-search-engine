/** One-off: run a single query through the EntityLookupV2 authority and dump the full decision. */
import 'dotenv/config';
import process from 'node:process';
import { loadConfig } from '../../src/config/env.js';
import { createContainer } from '../../src/config/container.js';
import { getPgPool } from '../../src/infrastructure/db/pg-pool.js';
import { LOOKUP_V2_DEFAULT_MAX_CANDIDATES } from '../../src/interface/http/constants.js';

async function main(): Promise<void> {
  const query = process.argv.slice(2).filter((a) => a !== '--').join(' ') || '2018 Orin Swift Papillon';
  const config = loadConfig();
  const pool = getPgPool();
  const container = await createContainer(config, pool);

  process.stderr.write(`\n===== QUERY: ${query} =====\n`);

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
