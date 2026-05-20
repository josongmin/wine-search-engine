import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import { getPgPool } from './pg-pool.js';

export async function runMigrations(): Promise<void> {
  const pool = getPgPool();
  const __dir = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = join(__dir, 'migrations');
  const migrationFiles = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right, 'en'));

  for (const fileName of migrationFiles) {
    const sql = readFileSync(join(migrationsDir, fileName), 'utf-8');
    await pool.query(sql);
    bootstrapLogger.warn({ migration: fileName }, 'Migration applied');
  }

  bootstrapLogger.warn({ migrationCount: migrationFiles.length }, 'Migrations complete');
}
