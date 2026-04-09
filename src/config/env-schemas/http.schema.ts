import { z } from 'zod';

/**
 * HTTP server tuning, CORS, rate limit, body limit, debug header secret.
 */

/** RFC-014 §13 default per-IP rate-limit window max before production tuning. */
const DEFAULT_HTTP_RATE_LIMIT_MAX = 100;
const KIBIBYTE = 1024;
/** Fastify bodyLimit ceiling in MiB (generous for batch JSON; tunable via env). */
const HTTP_BODY_LIMIT_MAX_MIB = 32;
/** Fastify bodyLimit ceiling in bytes. */
const HTTP_BODY_LIMIT_MAX_BYTES = HTTP_BODY_LIMIT_MAX_MIB * KIBIBYTE * KIBIBYTE;
/** Default JSON body limit: 1 MiB. */
const DEFAULT_HTTP_BODY_LIMIT_BYTES = 1_048_576;
/** Minimum debug secret length so X-Debug-Key cannot be a trivial guess. */
const ENV_HTTP_DEBUG_SECRET_MIN_LEN = 16;

export const HttpEnvSchema = z.object({
  /** Per-IP request cap (RFC-014 §13). Set high for local offline eval; use 0 to disable. */
  HTTP_RATE_LIMIT_MAX: z.coerce.number().int().nonnegative().default(DEFAULT_HTTP_RATE_LIMIT_MAX),

  /**
   * Trust `X-Forwarded-*` headers (client IP, proto) when behind a reverse proxy / load balancer.
   * Set true in production behind ALB/nginx; keep false for direct-to-process local runs.
   */
  HTTP_TRUST_PROXY: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),

  /** Max JSON body size in bytes (Fastify `bodyLimit`). Default 1 MiB. */
  HTTP_BODY_LIMIT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(HTTP_BODY_LIMIT_MAX_BYTES)
    .default(DEFAULT_HTTP_BODY_LIMIT_BYTES),

  /**
   * When set (≥16 chars), clients may send `X-Debug-Key: <same value>` for per-request log level `debug`.
   */
  HTTP_DEBUG_SECRET: z.string().min(ENV_HTTP_DEBUG_SECRET_MIN_LEN).optional(),

  /** Register `@fastify/helmet` security headers (recommended on in production). */
  HTTP_SECURITY_HEADERS: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('true'),

  /** Comma-separated list of allowed CORS origins. Defaults to '*' in development. */
  CORS_ALLOWED_ORIGINS: z.string().default(''),
});
