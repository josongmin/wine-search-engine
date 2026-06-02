import { loadConfig } from '../src/config/env.js';
import { createContainer } from '../src/config/container.js';
import { getPgPool } from '../src/infrastructure/db/pg-pool.js';
import { LOOKUP_V2_DEFAULT_MAX_CANDIDATES } from '../src/interface/http/constants.js';

async function main() {
  const config = loadConfig();
  const pool = getPgPool(config.pg);
  const container = await createContainer(config, { pool });
  const rows = (await pool.query(
    `SELECT query, expected_entity_id FROM eval_cases WHERE query_class='noisy_recall' AND expected_entity_id IS NOT NULL ORDER BY query`
  )).rows;
  console.log(`### noisy_recall expected-resolve cases: ${rows.length}`);
  let v2miss = 0;
  for (const r of rows) {
    const res = await container.entityLookupV2UseCase.execute(
      { query: r.query, maxCandidates: LOOKUP_V2_DEFAULT_MAX_CANDIDATES, mode: 'diagnostic', requestId: 'n' }, {});
    const top = res.topCandidate;
    const correct = res.status === 'resolved' && top?.entityId === r.expected_entity_id;
    if (!correct) {
      v2miss++;
      const ev = res.evidenceSummary ?? {};
      console.log(`\nMISS: ${JSON.stringify(r.query)}`);
      console.log(`  status=${res.status} reason=${ev.decisionReasonCode} poolSize=${ev.candidatePoolSize} calibTrusted=${ev.calibrationTrusted} topConf=${ev.topConfidence}`);
      console.log(`  expected=${r.expected_entity_id}`);
      const cands = (res.candidates ?? []).slice(0,4);
      for (const c of cands) console.log(`   cand ${c.entityId===r.expected_entity_id?'>>EXPECTED<<':''} calib=${c.calibratedScore?.toFixed?.(3)} | ${c.canonicalLabel}`);
      const inPool = (res.candidates ?? []).find(c => c.entityId === r.expected_entity_id);
      console.log(`   expected-in-pool: ${inPool ? 'YES rank~'+(res.candidates.indexOf(inPool)+1)+' calib='+inPool.calibratedScore : 'NO (not recalled)'}`);
    }
  }
  console.log(`\n### V2 noisy_recall miss total: ${v2miss}/${rows.length}`);
  process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
