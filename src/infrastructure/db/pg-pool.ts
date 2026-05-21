import { Pool } from 'pg';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import { config } from '../../config/env.js';

type PgPoolConfig = typeof config.pg;
interface PgPoolTimeoutOverrides {
  readonly statementTimeoutMs?: number;
  readonly idleInTransactionSessionTimeoutMs?: number;
  readonly queryTimeoutMs?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Pool-config defaults (Rule 15 / Rule 30 — named consts for magic numbers,
// SSoT for tests + ops scripts).
//
// These are the documented `pg.Pool` library floors plus production-tuned
// timeouts. The env schema (`db.schema.ts`) layers higher production values
// on top (e.g. PG_POOL_MAX=40 for the 10K QPS target). These floor defaults
// exist so test fixtures, ad-hoc CLIs, and ops scripts that build a pool
// without going through env loading still get sane, audited behavior, and so
// property-based regression tests can assert against a single SSoT.
//
//   PG_POOL_MAX_CONNECTIONS_DEFAULT
//     pg library default. 10 is the pg-pool floor; production tunes to 40
//     via PG_POOL_MAX. Going above ~100 per app instance overshoots a typical
//     PG `max_connections=100` server limit and starves other clients.
//   PG_POOL_IDLE_TIMEOUT_MS_DEFAULT
//     30s — bounded above pg's 10s default to absorb burst traffic without
//     repeatedly tearing down TLS handshakes against Vespa-co-located PG.
//   PG_POOL_CONNECTION_TIMEOUT_MS_DEFAULT
//     5s — bounded below the 30s statement_timeout so acquire failures
//     surface fast and don't masquerade as slow queries.
// ────────────────────────────────────────────────────────────────────────────
export const PG_POOL_MAX_CONNECTIONS_DEFAULT = 10;
export const PG_POOL_IDLE_TIMEOUT_MS_DEFAULT = 30_000;
export const PG_POOL_CONNECTION_TIMEOUT_MS_DEFAULT = 5_000;

/**
 * Default server-side `statement_timeout` (ms). Documented in the timeout
 * arithmetic block inside `createPgPool` (Rule 22). Same numeric value as
 * `PG_POOL_IDLE_TIMEOUT_MS_DEFAULT` by coincidence — kept distinct so future
 * tuning of one does not silently change the other.
 */
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
/** Client-side query timeout buffer above the server statement_timeout (ms). */
const DEFAULT_QUERY_TIMEOUT_BUFFER_MS = 5_000;

let pool: Pool | null = null;

export function createPgPool(
  pgConfig: PgPoolConfig,
  timeoutOverrides: PgPoolTimeoutOverrides = {},
): Pool {
  const statementTimeoutMs = timeoutOverrides.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  const idleInTransactionSessionTimeoutMs =
    timeoutOverrides.idleInTransactionSessionTimeoutMs ?? statementTimeoutMs;
  const queryTimeoutMs =
    timeoutOverrides.queryTimeoutMs ?? (statementTimeoutMs + DEFAULT_QUERY_TIMEOUT_BUFFER_MS);
  const nextPool = new Pool({
    ...(pgConfig.connectionString !== undefined
      ? { connectionString: pgConfig.connectionString }
      : {
          host: pgConfig.host,
          port: pgConfig.port,
          database: pgConfig.database,
          user: pgConfig.user,
          password: pgConfig.password,
        }),
    ...(pgConfig.ssl ? { ssl: { rejectUnauthorized: pgConfig.sslRejectUnauthorized } } : {}),
    // pgConfig values are env-loaded with Zod defaults (db.schema.ts);
    // PG_POOL_*_DEFAULT consts above are the library-floor SSoT for tests
    // and ops scripts that bypass env loading.
    max: pgConfig.poolMax,
    idleTimeoutMillis: pgConfig.idleTimeoutMillis,
    connectionTimeoutMillis: pgConfig.connectionTimeoutMillis,
    application_name: 'wine-engine',
    // Server-side timeouts: a slow query must not hold a pool slot
    // forever. statement_timeout aborts long-running queries server-side;
    // idle_in_transaction_session_timeout aborts open transactions left
    // dangling by an application crash.
    //
    // Timeout arithmetic (Rule 22):
    //   statement_timeout  = 30s  (server kills query — raised for Vespa Cloud
    //     latency: publish-search-snapshot advisory lock + substrate INSERT can
    //     take 15-20s when Vespa Cloud is cold)
    //   idle_in_transaction = 30s  (server kills idle txn)
    //   query_timeout      = 35s  (client-side, 5s buffer above server timeout)
    // The 5s client buffer ensures the server abort fires first (clean error
    // code) before the client forcibly kills the socket (opaque error).
    statement_timeout: statementTimeoutMs,
    idle_in_transaction_session_timeout: idleInTransactionSessionTimeoutMs,
    query_timeout: queryTimeoutMs,
  });
  nextPool.on('error', (err) => {
    // Sanitize: pg client error objects sometimes carry full connection
    // params. Log only the message + code, never the raw err.
    const message = err instanceof Error ? err.message : 'unknown';
    const code = (err as { code?: string } | undefined)?.code;
    bootstrapLogger.error({ message, code }, 'PostgreSQL pool error');
  });
  return nextPool;
}

export function getPgPool(pgConfig: PgPoolConfig = config.pg): Pool {
  pool ??= createPgPool(pgConfig);
  return pool;
}

export function shouldUsePgPool(pgConfig: PgPoolConfig = config.pg): boolean {
  return (pgConfig.connectionString?.length ?? 0) > 0 || pgConfig.password.length > 0;
}

export async function closePgPool(targetPool: Pool | null = pool): Promise<void> {
  if (targetPool) {
    await targetPool.end();
  }
  if (targetPool === pool) {
    pool = null;
  }
}
