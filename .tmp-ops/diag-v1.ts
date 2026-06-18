import { loadConfig } from '../src/config/env.js';
import { createContainer } from '../src/config/container.js';
import { getPgPool } from '../src/infrastructure/db/pg-pool.js';
async function main(){
  const c=loadConfig(); const ct=await createContainer(c,{pool:getPgPool(c.pg)});
  for(const q of ['2010 Méo-Camuzet Marsannay','2020 Domaine Sylvain Cathiard Bourgogne']){
    const resp:any = await ct.searchUseCase.execute({query:q, primitiveRoute:'lookup_wine'} as any, 'r', {lookupAuthorityMode:'legacy_core'} as any);
    console.log('\nQ', JSON.stringify(q), 'queryType=', resp.queryType);
    console.log('  decisionStatus=', resp.engineDecision?.decisionStatus, '| reason=', resp.engineDecision?.decisionReason ?? resp.engineDecision?.finalReason);
    console.log('  results[0]=', resp.results?.[0]?.entity?.canonicalLabel, '| count=', resp.results?.length);
    console.log('  rulesApplied=', JSON.stringify(resp.engineDecision?.rulesApplied ?? resp.engineDecision?.appliedRules ?? 'n/a'));
  }
  process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
