import { loadConfig } from '../src/config/env.js';
import { createContainer } from '../src/config/container.js';
import { getPgPool } from '../src/infrastructure/db/pg-pool.js';
import { LOOKUP_V2_DEFAULT_MAX_CANDIDATES } from '../src/interface/http/constants.js';
async function main() {
  const config = loadConfig();
  const container = await createContainer(config, { pool: getPgPool(config.pg) });
  for (const q of ['Viña Espectro Maipo Valley Carmenere','2018 St. Supéry Élu']) {
    const res = await container.entityLookupV2UseCase.execute(
      { query: q, maxCandidates: LOOKUP_V2_DEFAULT_MAX_CANDIDATES, mode: 'diagnostic', requestId: 'x' },{});
    const ev=res.evidenceSummary??{};
    console.log('\nQ',JSON.stringify(q),'→',res.status,'reason=',ev.decisionReasonCode,'calibTrusted=',ev.calibrationTrusted,'pool=',ev.candidatePoolSize);
    if(res.topCandidate) console.log('  TOP:',res.topCandidate.entityId,'calib=',res.topCandidate.calibratedScore,'|',res.topCandidate.canonicalLabel);
    for(const c of (res.candidates??[]).slice(0,4)) console.log('   cand calib=',c.calibratedScore?.toFixed?.(3),'|',c.canonicalLabel, JSON.stringify(c.channelHits?.map(h=>h.channel)??[]));
    console.log('  ambiguityTypes=', JSON.stringify(ev.ambiguityTypes ?? res.meta?.ambiguityTypes ?? 'n/a'));
  }
  process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
