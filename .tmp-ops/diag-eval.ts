import { loadConfig } from '../src/config/env.js';
import { getPgPool } from '../src/infrastructure/db/pg-pool.js';
async function main() {
  const pool = getPgPool(loadConfig().pg);
  const r = await pool.query(`SELECT query, query_class, expected_entity_id FROM eval_cases WHERE query ILIKE '%perignon%' OR query ILIKE '%페리뇽%' OR query ILIKE '%dom%' LIMIT 20`);
  console.log('eval_cases dom/perignon:', r.rowCount);
  for (const x of r.rows) console.log('  ', JSON.stringify(x.query), '| class=', x.query_class, '| expected=', x.expected_entity_id);
  // is "dom-perignon-2012" a real entity anywhere?
  const e = await pool.query(`SELECT entity_id, canonical_label FROM entities WHERE entity_id ILIKE '%perignon%' LIMIT 5`);
  console.log('\nentities with perignon id:', e.rowCount, e.rows.map((x:any)=>x.entity_id));
  process.exit(0);
}
main().catch(e=>{console.error(e.message);process.exit(1);});
