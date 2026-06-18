import { loadConfig } from '../src/config/env.js';
import { getPgPool } from '../src/infrastructure/db/pg-pool.js';
async function main() {
  const pool = getPgPool(loadConfig().pg);
  const e = await pool.query(`SELECT entity_id, canonical_label FROM entities WHERE canonical_label ILIKE '%érignon%' OR canonical_label ILIKE '%perignon%' LIMIT 10`);
  console.log('ENTITIES matching perignon:', e.rowCount);
  for (const r of e.rows) console.log('  ', r.entity_id, '|', r.canonical_label);
  if (e.rows.length) {
    const ids = e.rows.map(r=>r.entity_id);
    const a = await pool.query(`SELECT entity_id, alias_value, alias_type FROM entity_aliases WHERE entity_id = ANY($1) LIMIT 30`, [ids]);
    console.log('ALIASES:', a.rowCount);
    for (const r of a.rows) console.log('  ', r.alias_value, '|', r.alias_type);
  }
  process.exit(0);
}
main().catch(e=>{console.error(e.message);process.exit(1);});
