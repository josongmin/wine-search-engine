#!/usr/bin/env tsx
/**
 * Optional: migrate against Postgres from repo `docker-compose.yml` (service `postgres`).
 *
 * Pins `DATABASE_URL` / `PG_*` to Compose defaults so `.env` does not affect this command.
 *
 * Prerequisite: `pnpm run docker:db:up`
 *
 * Default app/migrate path: `.env` + `pnpm run migrate` (see `migrate-from-env.ts`).
 */
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local', override: false });
dotenv.config({ override: false });

// `loadConfig()` re-runs dotenv when migrate pulls in `config`; with `override: false`
// a deleted DATABASE_URL would be re-filled from `.env`. Pin local Docker first.
const LOCAL_DOCKER_PG_URL =
  'postgresql://wine:wine_dev@127.0.0.1:5432/wine_engine';
process.env.DATABASE_URL = LOCAL_DOCKER_PG_URL;
process.env.PG_HOST = '127.0.0.1';
process.env.PG_PORT = '5432';
process.env.PG_DATABASE = 'wine_engine';
process.env.PG_USER = 'wine';
process.env.PG_PASSWORD = 'wine_dev';
process.env.PG_SSL = 'false';

const { runMigrations } = await import('../src/infrastructure/db/migrate.js');
await runMigrations();
