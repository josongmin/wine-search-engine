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
  });
  nextPool.on('error', (err) => {
    bootstrapLogger.error({ err }, 'PostgreSQL pool error');
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
