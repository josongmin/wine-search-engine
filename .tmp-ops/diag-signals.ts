import { loadConfig } from '../src/config/env.js';
import { createContainer } from '../src/config/container.js';
import { getPgPool } from '../src/infrastructure/db/pg-pool.js';
import { LOOKUP_V2_DEFAULT_MAX_CANDIDATES } from '../src/interface/http/constants.js';
async function main() {
  const config = loadConfig();
  const container = await createContainer(config, { pool: getPgPool(config.pg) });
  // Use the diagnostic resolver candidates if exposed; else dump candidate sourceSignals from result meta
  const res = await container.entityLookupV2UseCase.execute(
    { query: 'Viña Espectro Maipo Valley Carmenere', maxCandidates: LOOKUP_V2_DEFAULT_MAX_CANDIDATES, mode: 'diagnostic', requestId: 'x' },{});
  const top:any = res.candidates?.[0];
  console.log('top keys:', Object.keys(top??{}));
  console.log('sourceSignals:', JSON.stringify(top?.sourceSignals ?? 'NOT EXPOSED'));
  console.log('aliasMatches:', JSON.stringify(top?.aliasMatches ?? 'NOT EXPOSED'));
  console.log('rawScore:', top?.rawScore, 'calibratedScore:', top?.calibratedScore);
  console.log('channelHits:', JSON.stringify(top?.channelHits));
  process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
