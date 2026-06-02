/** One-off: run a single query through V2 (and V1) and dump the full decision. */
import 'dotenv/config';
import process from 'node:process';
import { loadConfig } from '../../src/config/env.js';
import { createContainer } from '../../src/config/container.js';
import { getPgPool } from '../../src/infrastructure/db/pg-pool.js';
import { LOOKUP_V2_DEFAULT_MAX_CANDIDATES } from '../../src/interface/http/constants.js';
import type { SearchRequest } from '../../src/application/search/search-request.dto.js';

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

  const v1Req: SearchRequest = { query, primitiveRoute: 'lookup_wine' };
  const v1 = await container.searchUseCase.execute(v1Req, 'debug-1', {});
  if (v1.queryType === 'search') {
    process.stderr.write(`\nV1 status=${v1.engineDecision.decisionStatus}\n`);
    process.stderr.write(`V1 reasons=${JSON.stringify(v1.engineDecision.degradationReasons ?? [])}\n`);
    process.stderr.write(`V1 results[0]=${v1.results[0] ? `${String(v1.results[0].entity.entityId)} (${v1.results[0].entity.canonicalLabel})` : 'none'}\n`);
    process.stderr.write(`V1 result count=${String(v1.results.length)}\n`);
  }
  await pool.end();
}

main().catch((err: unknown) => {
  process.stderr.write(`debug failed: ${(err as Error).message}\n${(err as Error).stack ?? ''}\n`);
  process.exitCode = 1;
});
