import { loadConfig } from '../src/config/env.js';
import { getPgPool } from '../src/infrastructure/db/pg-pool.js';
async function main() {
  const pool = getPgPool(loadConfig().pg);
  for (const [t,vcol] of [['canonical_aliases','surface_form'],['aliases','surface_form']]) {
    const r=await pool.query(`SELECT * FROM ${t} WHERE ${vcol} ILIKE '%erignon%' OR ${vcol} ILIKE '%페리뇽%' OR normalized_surface ILIKE '%perignon%' LIMIT 8`).catch(async()=>await pool.query(`SELECT * FROM ${t} WHERE ${vcol} ILIKE '%erignon%' OR ${vcol} ILIKE '%페리뇽%' LIMIT 8`));
    console.log(`\n[${t}] surface matches:`, r.rowCount); for(const x of r.rows) console.log('   ', JSON.stringify({surface:x.surface_form,norm:x.normalized_surface||x.normalized_value,eid:x.canonical_entity_id||x.entity_id,type:x.alias_type,snap:x.search_snapshot_id}));
  }
  // active snapshot
  const s = await pool.query(`SELECT * FROM active_search_snapshot LIMIT 3`);
  console.log('\nactive_search_snapshot:', JSON.stringify(s.rows));
  // count aliases in active snapshot vs total
  process.exit(0);
}
main().catch(e=>{console.error(e.message);process.exit(1);});
