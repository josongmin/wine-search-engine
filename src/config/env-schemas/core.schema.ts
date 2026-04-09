import { z } from 'zod';

/**
 * Core process-wide settings (node environment, listen port, log level).
 */

/** Default Fastify listen port for local development. */
const DEFAULT_SERVER_PORT = 3000;

export const CoreEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(DEFAULT_SERVER_PORT),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
});
