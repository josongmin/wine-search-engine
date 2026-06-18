import { loadConfig } from '../src/config/env.js';
import { getPgPool } from '../src/infrastructure/db/pg-pool.js';
async function col(pool:any,t:string){const c=await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='${t}'`);return c.rows.map((r:any)=>r.column_name);}
async function main() {
  const pool = getPgPool(loadConfig().pg);
  for (const t of ['canonical_entities','canonical_aliases','aliases','entities']) {
    console.log(`\n=== ${t} cols:`, (await col(pool,t)).join(','));
  }
  // perignon search across alias-bearing tables
  for (const [t,vcol] of [['canonical_aliases','alias_value'],['aliases','alias_value'],['canonical_entities','canonical_label']]) {
    try { const r=await pool.query(`SELECT * FROM ${t} WHERE ${vcol} ILIKE '%erignon%' OR ${vcol} ILIKE '%페리뇽%' LIMIT 6`);
      console.log(`\n[${t}] matches:`, r.rowCount); for(const x of r.rows) console.log('   ', JSON.stringify(x));
    } catch(e){console.log(`[${t}] err`, (e as Error).message);} }
  process.exit(0);
}
main().catch(e=>{console.error(e.message);process.exit(1);});
