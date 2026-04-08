import { Pool } from 'pg';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import { config } from '../../config/env.js';

export type PgPoolConfig = typeof config.pg;

let pool: Pool | null = null;

export function createPgPool(pgConfig: PgPoolConfig): Pool {
  const nextPool = new Pool({
    host: pgConfig.host,
    port: pgConfig.port,
    database: pgConfig.database,
    user: pgConfig.user,
    password: pgConfig.password,
    max: pgConfig.poolMax,
    idleTimeoutMillis: pgConfig.idleTimeoutMillis,
    connectionTimeoutMillis: pgConfig.connectionTimeoutMillis,
    application_name: 'wine-engine',
    // Server-side timeouts: a slow query must not hold a pool slot
    // forever. statement_timeout aborts long-running queries server-side;
    // idle_in_transaction_session_timeout aborts open transactions left
    // dangling by an application crash.
    statement_timeout: 10_000,
    idle_in_transaction_session_timeout: 10_000,
    // Client-side safety net catching network partitions where server-side
    // timers never fire (the connection vanished but the client still waits).
    query_timeout: 12_000,
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
  if (!pool) {
    pool = createPgPool(pgConfig);
  }
  return pool;
}

export function shouldUsePgPool(pgConfig: PgPoolConfig = config.pg): boolean {
  return pgConfig.password.length > 0;
}

export function getOptionalPgPool(pgConfig: PgPoolConfig = config.pg): Pool | undefined {
  if (!shouldUsePgPool(pgConfig)) {
    return undefined;
  }
  return getPgPool(pgConfig);
}

export function peekPgPool(): Pool | null {
  return pool;
}

export async function closePgPool(targetPool: Pool | null = pool): Promise<void> {
  if (targetPool) {
    await targetPool.end();
  }
  if (targetPool === pool) {
    pool = null;
  }
}
