import { z } from 'zod';

/**
 * PostgreSQL connection and pool settings, plus Redis URL.
 */

/** PostgreSQL default port. */
const DEFAULT_PG_PORT = 5432;
/** Default pool size per node (raised for 10K QPS target; tune vs max_connections). */
const DEFAULT_PG_POOL_MAX = 40;
const DEFAULT_PG_POOL_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_PG_POOL_CONNECTION_TIMEOUT_MS = 5_000;

export const DbEnvSchema = z.object({
  // PostgreSQL
  DATABASE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  PG_HOST: z.string().min(1).default('localhost'),
  PG_PORT: z.coerce.number().int().positive().default(DEFAULT_PG_PORT),
  PG_DATABASE: z.string().min(1).default('wine_engine'),
  PG_USER: z.string().min(1).default('wine'),
  PG_PASSWORD: z.string().default(''),
  PG_SSL: z.enum(['true', 'false']).transform((value) => value === 'true').default('false'),
  PG_SSL_REJECT_UNAUTHORIZED: z.enum(['true', 'false']).transform((value) => value === 'true').default('true'),
  // 10K QPS production target: 10 connections per node caps at ~2K QPS
  // before queueing. Default raised to 40 — tune against pg max_connections.
  PG_POOL_MAX: z.coerce.number().int().positive().default(DEFAULT_PG_POOL_MAX),
  PG_POOL_IDLE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_PG_POOL_IDLE_TIMEOUT_MS),
  PG_POOL_CONNECTION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_PG_POOL_CONNECTION_TIMEOUT_MS),

  // Redis — optional. Official runtime stack excludes Redis until cache policy
  // is re-approved (see README / feature catalog infra.redis). Unset = no client.
  REDIS_URL: z.preprocess(
    (v) => (typeof v === 'string' && v.length > 0 ? v : undefined),
    z.string().url().optional(),
  ),
});
