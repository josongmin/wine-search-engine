import { loadConfig } from '../src/config/env.js';
import { createContainer } from '../src/config/container.js';
import { getPgPool } from '../src/infrastructure/db/pg-pool.js';
import { LOOKUP_V2_DEFAULT_MAX_CANDIDATES } from '../src/interface/http/constants.js';
async function main() {
  const config = loadConfig();
  const container = await createContainer(config, { pool: getPgPool(config.pg) });
  const res = await container.entityLookupV2UseCase.execute(
    { query: 'Viña Espectro Maipo Valley Carmenere', maxCandidates: LOOKUP_V2_DEFAULT_MAX_CANDIDATES, mode: 'diagnostic', requestId: 'x' },{});
  console.log('PRE-FIX:', res.status, '| top=', res.topCandidate?.canonicalLabel, '| calib=', res.topCandidate?.calibratedScore);
  process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
