#!/usr/bin/env tsx
/**
 * Apply SQL migrations using whatever PostgreSQL config is in the environment
 * (`.env` / `DATABASE_URL` / `PG_*`). Use this for managed DB or non-Docker setups.
 *
 * Default local flow: `pnpm run migrate` (Docker Compose Postgres, see migrate-local-docker-pg.ts).
 */
import { runMigrations } from '../src/infrastructure/db/migrate.js';
await runMigrations();
