import { loadConfig } from '../src/config/env.js';
import { getPgPool } from '../src/infrastructure/db/pg-pool.js';
async function main() {
  const pool = getPgPool(loadConfig().pg);
  // which tables have a column that could hold "perignon"?
  const tabs = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);
  console.log('TABLES:', tabs.rows.map(r=>r.table_name).join(', '));
  for (const t of ['entity_aliases','alias_registry_entries','wine_entity_aliases','aliases']) {
    try {
      const r = await pool.query(`SELECT alias_value, entity_id FROM ${t} WHERE alias_value ILIKE '%erignon%' OR alias_value ILIKE '%페리뇽%' LIMIT 10`);
      console.log(`\n[${t}] perignon/페리뇽 matches:`, r.rowCount);
      for (const x of r.rows) console.log('   ', JSON.stringify(x.alias_value), '→', x.entity_id);
    } catch(e){ /* table or column missing */ }
  }
  // direct dom-perignon-2012 lookup across entity_aliases
  try {
    const r2 = await pool.query(`SELECT alias_value, alias_type FROM entity_aliases WHERE entity_id = 'dom-perignon-2012' LIMIT 20`);
    console.log('\nentity_aliases for dom-perignon-2012:', r2.rowCount);
    for (const x of r2.rows) console.log('   ', JSON.stringify(x.alias_value), x.alias_type);
  } catch(e){ console.log('entity_aliases dom-perignon-2012 err:', e.message); }
  process.exit(0);
}
main().catch(e=>{console.error(e.message);process.exit(1);});
