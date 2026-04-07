import pino from 'pino';

/**
 * Logger for wiring paths that run before Fastify exists (container bootstrap, main).
 */
export const bootstrapLogger = pino({
  name: 'wine-engine',
  level: process.env['LOG_LEVEL'] ?? 'info',
});
