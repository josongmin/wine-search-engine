import { loadConfig } from '../src/config/env.js';
import { createContainer } from '../src/config/container.js';
import { getPgPool } from '../src/infrastructure/db/pg-pool.js';
import { LOOKUP_V2_DEFAULT_MAX_CANDIDATES } from '../src/interface/http/constants.js';
async function main() {
  const config = loadConfig();
  const container = await createContainer(config, { pool: getPgPool(config.pg) });
  for (const q of ['돔페리뇽','Dom Perignon','Dom Pérignon']) {
    const res = await container.entityLookupV2UseCase.execute(
      { query: q, maxCandidates: LOOKUP_V2_DEFAULT_MAX_CANDIDATES, mode: 'diagnostic', requestId: 'd' },{});
    const cands = res.candidates ?? [];
    const dp = cands.filter(c => /rignon/i.test(c.canonicalLabel));
    console.log('\nQ', JSON.stringify(q), 'poolSize=', cands.length, 'status=', res.status);
    console.log('  domaine@top calib:', cands.slice(0,3).map(c=>c.calibratedScore).join(','));
    console.log('  Pérignon candidates in pool:', dp.length ? dp.map(c=>`${c.canonicalLabel}@${c.calibratedScore}`).join(' ; ') : 'NONE');
  }
  process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
