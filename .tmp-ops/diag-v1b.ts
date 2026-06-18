import { loadConfig } from '../src/config/env.js';
import { createContainer } from '../src/config/container.js';
import { getPgPool } from '../src/infrastructure/db/pg-pool.js';
async function main(){
  const c=loadConfig(); const ct=await createContainer(c,{pool:getPgPool(c.pg)});
  const resp:any = await ct.searchUseCase.execute({query:'2010 Méo-Camuzet Marsannay', primitiveRoute:'lookup_wine'} as any, 'r', {lookupAuthorityMode:'legacy_core'} as any);
  console.log('engineDecision keys:', Object.keys(resp.engineDecision??{}));
  console.log('engineDecision:', JSON.stringify(resp.engineDecision, null, 1).slice(0,1200));
  process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
