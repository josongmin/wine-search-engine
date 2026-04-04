import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getPgPool } from './pg-pool.js';

export async function runMigrations(): Promise<void> {
  const pool = getPgPool();
  const __dir = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(__dir, 'migrations/001_initial_schema.sql'), 'utf-8');
  await pool.query(sql);
  console.warn('Migrations complete');
}
