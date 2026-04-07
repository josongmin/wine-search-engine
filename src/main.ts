import { loadConfig } from './config/env.js';
import { createContainer } from './config/container.js';
import { buildHealthRouteOptions } from './config/readiness.js';
import { expectsRedisAtStartup, isWatchlistEnabled } from './config/watchlist.js';
import {
  createManagedRuntimeHandles,
  type RuntimeHandles,
} from './config/runtime-handles.js';
import { createServer } from './interface/http/server.js';
import { createPgPool, shouldUsePgPool } from './infrastructure/db/pg-pool.js';
import { connectRedisClient } from './infrastructure/db/redis-client.js';
import { getTracer, initTelemetry } from './infrastructure/telemetry/tracer.js';
import { RedisWatchlistPublisher } from './infrastructure/watchlist/redis-watchlist-publisher.js';
import { RedisWatchlistSubscriber } from './infrastructure/watchlist/redis-watchlist-subscriber.js';
import { bootstrapLogger } from './config/bootstrap-logger.js';
import { logKillSwitchPolicyAtStartup } from './config/kill-switch-policy.js';

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
  logKillSwitchPolicyAtStartup(config, bootstrapLogger);
  const telemetrySdk = initTelemetry();

  // Step 1 & 2: Create container with loaded config and PG pool
  // Pool is required for production: PG adapters, evaluation, LTR model loading
  const pool = shouldUsePgPool(config.pg) ? createPgPool(config.pg) : undefined;
  let redisClient: RuntimeHandles['redisClient'] | null = null;
  if (expectsRedisAtStartup(config)) {
    try {
      redisClient = await connectRedisClient(config.redis);
    } catch (err) {
      if (isWatchlistEnabled(config)) {
        throw new Error(
          `Watchlist delivery requires Redis at startup: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      bootstrapLogger.warn(
        { err },
        '[Main] Redis unavailable during startup; continuing without Redis-backed features',
      );
    }
  }
  const runtimeHandles: RuntimeHandles = {
    ...(pool ? { pool } : {}),
    ...(redisClient ? { redisClient } : {}),
    createWatchlistPublisher: () =>
      new RedisWatchlistPublisher({
        ...(redisClient ? { client: redisClient } : { redisConfig: config.redis }),
      }),
    createWatchlistSubscriber: () => new RedisWatchlistSubscriber(config.redis),
  };
  const managedRuntime = createManagedRuntimeHandles(runtimeHandles, { telemetrySdk });
  const container = await createContainer(config, managedRuntime);
  const healthOptions = buildHealthRouteOptions(
    config,
    managedRuntime,
    container.watchlistRuntime,
    container.drinkingWindowPredictor,
    container.calibrationStore,
  );

  // Step 3: Create server (async: registers plugins including rate-limiting)
  const server = await createServer(container, {
    logLevel: config.logLevel,
    nodeEnv: config.nodeEnv,
    rateLimitMax: config.httpRateLimit.max,
    corsAllowedOrigins: config.corsAllowedOrigins,
    runEvalAtStartup: config.eval.runAtStartup,
    health: healthOptions,
    tracer: getTracer(),
    trustProxy: config.http.trustProxy,
    bodyLimitBytes: config.http.bodyLimitBytes,
    enableSecurityHeaders: config.http.securityHeaders,
    httpDebugSecret: config.http.debugSecret,
  });

  let shuttingDown = false;
  let startedWatchlistRuntime = false;

  try {
    if (container.watchlistRuntime !== null) {
      await container.watchlistRuntime.start();
      startedWatchlistRuntime = true;
      server.log.info('Watchlist delivery runtime started');
    }

    // Step 4: Start listening
    const address = await server.listen({
      port: config.port,
      host: '0.0.0.0',
    });

    server.log.info(`Wine Intelligence Engine listening on ${address}`);
  } catch (err) {
    if (startedWatchlistRuntime && container.watchlistRuntime?.isRunning() === true) {
      await container.watchlistRuntime.stop();
    }
    await server.close();
    await managedRuntime.close();
    throw err;
  }

  // Step 5: Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      server.log.warn(`Received ${signal} during shutdown; ignoring duplicate signal.`);
      return;
    }
    shuttingDown = true;
    server.log.info(`Received ${signal}, shutting down gracefully...`);
    try {
      if (startedWatchlistRuntime && container.watchlistRuntime?.isRunning() === true) {
        await container.watchlistRuntime.stop();
      }
      await server.close();
      await managedRuntime.close();
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
  bootstrapLogger.fatal({ err }, 'fatal error during startup');
  process.exit(1);
});
