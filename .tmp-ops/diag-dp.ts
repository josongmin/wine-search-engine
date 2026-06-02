import { loadConfig } from '../src/config/env.js';
import { createContainer } from '../src/config/container.js';
import { getPgPool } from '../src/infrastructure/db/pg-pool.js';
import { LOOKUP_V2_DEFAULT_MAX_CANDIDATES } from '../src/interface/http/constants.js';

async function main() {
  const config = loadConfig();
  const pool = getPgPool(config.pg);
  const container = await createContainer(config, { pool });
  for (const q of ['돔페리뇽', 'Dom Perignon']) {
    const res = await container.entityLookupV2UseCase.execute(
      { query: q, maxCandidates: LOOKUP_V2_DEFAULT_MAX_CANDIDATES, mode: 'diagnostic', requestId: 'diag-'+q },
      {},
    );
    console.log('\n##### QUERY:', JSON.stringify(q));
    console.log('status=', res.status, ' reasonCode=', res.decisionReasonCode ?? res.meta?.decisionReasonCode);
    console.log('top=', res.topCandidate ? `${res.topCandidate.entityId} | ${res.topCandidate.canonicalLabel} | calib=${res.topCandidate.calibratedScore}` : 'null');
    const cands = (res.candidates ?? []).slice(0, 6);
    for (const c of cands) {
      console.log('  cand', c.entityId, '|', c.canonicalLabel, '| calib=', c.calibratedScore, '| channels=', JSON.stringify(c.channels ?? c.provenance ?? []));
    }
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
