import { loadConfig } from './config/env.js';
import { createContainer } from './config/container.js';
import type { RuntimeHandles } from './config/runtime-handles.js';
import { createServer } from './interface/http/server.js';
import type { HealthRouteOptions, ReadinessStatus } from './interface/http/routes/health.route.js';
import { getOptionalPgPool, closePgPool } from './infrastructure/db/pg-pool.js';
import { closeRedisClient, connectRedisClient } from './infrastructure/db/redis-client.js';

/**
 * Wine Intelligence Engine — main entry point.
 *
 * 1. Load environment configuration
 * 2. Create PG pool and DI container
 * 3. Create Fastify server
 * 4. Start listening
 * 5. Graceful shutdown on SIGTERM/SIGINT
 */
async function main(): Promise<void> {
  const config = loadConfig();

  // Step 1 & 2: Create container with loaded config and PG pool
  // Pool is required for production: PG adapters, evaluation, LTR model loading
  const pool = getOptionalPgPool(config.pg);
  const expectsRedisAtStartup = !config.killSwitch.queryCache
    || (config.anthropic.apiKey !== undefined && !config.killSwitch.injectionJudge)
    || config.watchlist.webhookSecret !== undefined;
  let redisClient: RuntimeHandles['redisClient'] | null = null;
  if (expectsRedisAtStartup) {
    try {
      redisClient = (await connectRedisClient(config.redis)) ?? null;
    } catch (err) {
      console.warn('[Main] Redis unavailable during startup; continuing without Redis-backed features:', err);
    }
  }
  const container = await createContainer(config, {
    ...(pool ? { pool } : {}),
    ...(redisClient ? { redisClient } : {}),
  });
  const healthOptions: HealthRouteOptions = {
    readiness: {
      ...(pool
        ? {
            postgres: {
              required: true,
              check: async (): Promise<ReadinessStatus> => {
                await pool.query('SELECT 1');
                return 'up';
              },
            },
          }
        : {}),
      ...(expectsRedisAtStartup
        ? {
            redis: {
              check: async (): Promise<ReadinessStatus> => {
                if (redisClient === undefined || redisClient === null) {
                  return 'down';
                }
                if (!redisClient.isOpen) {
                  return 'down';
                }
                await redisClient.ping();
                return 'up';
              },
            },
          }
        : {}),
    },
  };

  // Step 3: Create server (async: registers plugins including rate-limiting)
  const server = await createServer(container, {
    logLevel: config.logLevel,
    nodeEnv: config.nodeEnv,
    rateLimitMax: config.httpRateLimit.max,
    corsAllowedOrigins: config.corsAllowedOrigins,
    runEvalAtStartup: config.eval.runAtStartup,
    health: healthOptions,
  });

  if (container.watchlistRuntime !== null) {
    await container.watchlistRuntime.start();
    server.log.info('Watchlist delivery runtime started');
  }

  // Step 4: Start listening
  const address = await server.listen({
    port: config.port,
    host: '0.0.0.0',
  });

  server.log.info(`Wine Intelligence Engine listening on ${address}`);

  // Step 5: Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    server.log.info(`Received ${signal}, shutting down gracefully...`);
    try {
      if (container.watchlistRuntime?.isRunning() === true) {
        await container.watchlistRuntime.stop();
      }
      await server.close();
      // Close infrastructure connections
      await closePgPool();
      await closeRedisClient(redisClient ?? null);
      server.log.info('Server closed successfully.');
      process.exit(0);
    } catch (err) {
      server.log.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
