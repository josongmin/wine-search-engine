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
 * Tune undici (Node 22 native fetch dispatcher) for high-RPS Vespa/LLM
 * traffic. Default per-origin connection cap + minimal keep-alive create
 * TCP/TLS churn at hundreds of requests/sec. Setting a global dispatcher
 * with sane keep-alive + connection pool numbers stops ephemeral port
 * exhaustion under burst load. Must run before any fetch() call.
 *
 * undici is a transitive dep of Node 22 itself but is not always exposed
 * as an importable module — best-effort dynamic import keeps the bootstrap
 * resilient when the package is not in node_modules.
 */
async function configureGlobalHttpDispatcher(): Promise<void> {
  try {
    // undici ships with Node 22 but is not always exposed as a top-level
    // import. We use a dynamic specifier (variable) to bypass TypeScript's
    // module resolution check; if the package isn't present, the catch
    // arm logs and falls back to default dispatcher behavior.
    const undiciSpec = 'undici';
    const undici: unknown = await (import(undiciSpec as never) as Promise<unknown>).catch(() => null);
    if (undici === null || typeof undici !== 'object') return;
    const mod = undici as {
      Agent?: new (opts: Record<string, unknown>) => unknown;
      setGlobalDispatcher?: (dispatcher: unknown) => void;
    };
    if (typeof mod.Agent !== 'function' || typeof mod.setGlobalDispatcher !== 'function') {
      return;
    }
    mod.setGlobalDispatcher(
      new mod.Agent({
        connect: { timeout: 5_000 },
        keepAliveTimeout: 10_000,
        keepAliveMaxTimeout: 60_000,
        pipelining: 4,
        connections: 256,
      }),
    );
    bootstrapLogger.info({ component: 'http-dispatcher' }, 'undici global dispatcher tuned');
  } catch (err) {
    bootstrapLogger.warn(
      { err },
      'undici dispatcher tuning failed; falling back to defaults',
    );
  }
}

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
  // Configure undici BEFORE any module that might issue a fetch (config
  // loaders, telemetry SDK init, etc.) so the global dispatcher applies
  // to the very first outbound request.
  await configureGlobalHttpDispatcher();

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
    container.runtimeReadiness,
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
    enableAgentBenchmarkUi: config.enableAgentBenchmarkUi,
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
  const SHUTDOWN_HARD_TIMEOUT_MS = 25_000;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      server.log.warn(`Received ${signal} during shutdown; ignoring duplicate signal.`);
      return;
    }
    shuttingDown = true;
    server.log.info(`Received ${signal}, shutting down gracefully...`);

    // Hard timeout: if any close() deadlocks (e.g., Redis quit on a broken
    // socket, hung pg pool .end()), we exit with code 1 instead of hanging
    // until k8s SIGKILLs us at the end of the grace period.
    const hardTimer = setTimeout(() => {
      server.log.fatal('Shutdown exceeded hard timeout; forcing exit(1).');
      process.exit(1);
    }, SHUTDOWN_HARD_TIMEOUT_MS);
    hardTimer.unref();

    try {
      if (startedWatchlistRuntime && container.watchlistRuntime?.isRunning() === true) {
        await container.watchlistRuntime.stop();
      }
      await server.close();
      await managedRuntime.close();
      server.log.info('Server closed successfully.');
      clearTimeout(hardTimer);
      process.exit(0);
    } catch (err) {
      server.log.error({ err }, 'Error during shutdown');
      clearTimeout(hardTimer);
      process.exit(1);
    }
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

// Treat unhandled rejections as fatal: a Node process in this state has
// undefined behavior (per Node default since v15). Log + exit so a fresh
// process replaces us instead of running silently corrupted.
process.on('unhandledRejection', (reason: unknown) => {
  bootstrapLogger.fatal({ err: reason }, 'unhandled promise rejection — exiting');
  process.exit(1);
});

process.on('uncaughtException', (err: Error) => {
  bootstrapLogger.fatal({ err }, 'uncaught exception — shutting down');
  process.exit(1);
});

main().catch((err: unknown) => {
  bootstrapLogger.fatal({ err }, 'fatal error during startup');
  process.exit(1);
});
