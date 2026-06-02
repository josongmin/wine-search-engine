import { loadConfig } from '../src/config/env.js';
import { createContainer } from '../src/config/container.js';
import { getPgPool } from '../src/infrastructure/db/pg-pool.js';
import { LOOKUP_V2_DEFAULT_MAX_CANDIDATES } from '../src/interface/http/constants.js';
async function main() {
  const config = loadConfig();
  const container = await createContainer(config, { pool: getPgPool(config.pg) });
  const res = await container.entityLookupV2UseCase.execute(
    { query: 'Viña Espectro Maipo Valley Carmenere', maxCandidates: LOOKUP_V2_DEFAULT_MAX_CANDIDATES, mode: 'diagnostic', requestId: 'x' },{});
  const top = res.topCandidate;
  console.log('status=', res.status, 'reason=', res.evidenceSummary?.decisionReasonCode);
  console.log('TOP label=', top?.canonicalLabel, 'calib=', top?.calibratedScore);
  console.log('TOP channelHits=', JSON.stringify(top?.channelHits, null, 1));
  console.log('TOP rawScore=', (top as any)?.rawScore, 'sourceSignals=', JSON.stringify((top as any)?.sourceSignals ?? (top as any)?.signals));
  // dump everything on the candidate
  console.log('\nFULL TOP CANDIDATE:', JSON.stringify(top, null, 1).slice(0, 2000));
  process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
