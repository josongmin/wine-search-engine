/**
 * SSoT pool builder for standalone ops/eval/calibration scripts.
 *
 * Mirrors the SSL handling in `src/infrastructure/db/pg-pool.ts` so that
 * scripts connecting to managed Postgres (AWS RDS) negotiate TLS the same way
 * the app does. RDS rejects non-SSL connections with
 * `no pg_hba.conf entry for host "<ip>", ..., no encryption`; scripts that
 * built `new Pool({ connectionString })` without an `ssl` option silently
 * failed against RDS while "working" against a local plaintext Postgres.
 *
 * SSL is enabled when `PG_SSL` is truthy (`"true"`/`"1"`), matching the
 * `PG_SSL` / `PG_SSL_REJECT_UNAUTHORIZED` env contract in `src/config/env.ts`.
 * `rejectUnauthorized` defaults to `false` (RDS presents its own CA chain),
 * and is only set `true` when `PG_SSL_REJECT_UNAUTHORIZED` is explicitly truthy.
 */
import { Pool, type PoolConfig } from 'pg';

function envFlag(name: string): boolean {
  const v = process.env[name];
  return v === 'true' || v === '1' || v === 'TRUE';
}

/** Build the SSL fragment of a PoolConfig from PG_SSL* env vars. */
export function scriptPgSslOption(): Pick<PoolConfig, 'ssl'> {
  if (!envFlag('PG_SSL')) {
    return {};
  }
  return { ssl: { rejectUnauthorized: envFlag('PG_SSL_REJECT_UNAUTHORIZED') } };
}

/**
 * Create a Pool from env, preferring a connection string when present.
 *
 * @param connectionStringEnvKeys env var names checked in order for a
 *   connection string (e.g. `['PG_CONNECTION_STRING', 'DATABASE_URL']`).
 *   Defaults to `['DATABASE_URL']`.
 */
export function createScriptPgPool(
  connectionStringEnvKeys: readonly string[] = ['DATABASE_URL'],
): Pool {
  const ssl = scriptPgSslOption();

  for (const key of connectionStringEnvKeys) {
    const connectionString = process.env[key];
    if (connectionString !== undefined && connectionString.length > 0) {
      return new Pool({ connectionString, ...ssl });
    }
  }

  return new Pool({
    host: process.env['PG_HOST'] ?? process.env['PGHOST'] ?? 'localhost',
    port: Number.parseInt(process.env['PG_PORT'] ?? process.env['PGPORT'] ?? '5432', 10),
    database: process.env['PG_DATABASE'] ?? process.env['PGDATABASE'] ?? 'wine_search',
    user: process.env['PG_USER'] ?? process.env['PGUSER'] ?? 'postgres',
    password: process.env['PG_PASSWORD'] ?? process.env['PGPASSWORD'] ?? '',
    ...ssl,
  });
}
