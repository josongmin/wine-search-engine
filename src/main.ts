import { config } from './config/env.js';
import { createContainer } from './config/container.js';
import { createServer } from './interface/http/server.js';
import { getPgPool, closePgPool } from './infrastructure/db/pg-pool.js';
import { closeRedisClient } from './infrastructure/db/redis-client.js';

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
  // Step 1 & 2: Create container with loaded config and PG pool
  // Pool is required for production: PG adapters, evaluation, LTR model loading
  const pool = getPgPool();
  const container = await createContainer(config, pool);

  // Step 3: Create server (async: registers plugins including rate-limiting)
  const server = await createServer(container, {
    logLevel: config.logLevel,
  });

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
      await server.close();
      // Close infrastructure connections
      await closePgPool();
      await closeRedisClient();
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
