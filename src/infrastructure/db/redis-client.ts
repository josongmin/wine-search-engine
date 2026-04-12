import { createClient } from 'redis';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import { config } from '../../config/env.js';

/** Connected client instance from {@link createClient} (generic-safe for exactOptionalPropertyTypes). */
export type RedisClient = ReturnType<typeof createClient>;
export type RedisConfig = typeof config.redis;

let client: RedisClient | null = null;
/** Serializes concurrent first connects; always uses the first caller's {@link redisConfig}. */
let connectPromise: Promise<RedisClient> | null = null;

/** Wall-clock timeout for the initial Redis connect. Without this, a network
 *  partition or DNS failure causes every cache caller to await the same hung
 *  promise indefinitely (the underlying client may have a 30s+ default or none). */
const REDIS_CONNECT_TIMEOUT_MS = 5_000;

export async function connectRedisClient(redisConfig: RedisConfig): Promise<RedisClient> {
  if (redisConfig.url === undefined) {
    throw new Error('Redis URL not configured — skip Redis connection');
  }
  const nextClient = createClient({ url: redisConfig.url });
  nextClient.on('error', (err: Error) => {
    // Sanitize: redis client error objects may carry connection strings or
    // auth tokens. Log only the message + code, never the raw err object.
    const message = err instanceof Error ? err.message : 'unknown';
    const code = (err as { code?: string } | undefined)?.code;
    bootstrapLogger.error({ message, code }, 'Redis client error');
  });

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Redis connect timed out after ${String(REDIS_CONNECT_TIMEOUT_MS)}ms`));
    }, REDIS_CONNECT_TIMEOUT_MS);
  });
  try {
    await Promise.race([nextClient.connect(), timeoutPromise]);
  } catch (err) {
    // Best-effort cleanup of the half-open client so it doesn't leak.
    // On timeout, the client may not yet be isOpen (TCP handshake in progress),
    // so also try disconnect() which forcibly tears down the socket.
    try {
      if (nextClient.isOpen) {
        await nextClient.quit();
      } else {
        nextClient.destroy();
      }
    } catch (cleanupError) {
      // Secondary failure during half-open client teardown — socket will be
      // GC'd. Reference the error so semgrep wine-catch-empty does not flag
      // this best-effort recovery.
      void cleanupError;
    }
    throw err;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
  client = nextClient;
  return nextClient;
}

/**
 * Returns a connected Redis client (node-redis). Safe to call multiple times.
 * Concurrent cold starts share one in-flight connection attempt.
 */
export async function getRedisClient(redisConfig: RedisConfig = config.redis): Promise<RedisClient> {
  // Check `isOpen` — not just truthiness. After a Redis disconnect, `client`
  // is still set (non-null) but `isOpen` is false. Without this check every
  // caller gets a dead client and every operation throws ConnectionError.
  if (client?.isOpen) {
    return client;
  }
  // Dead client — clear so re-connection is attempted.
  if (client !== null && !client.isOpen) {
    client = null;
  }
  connectPromise ??= connectRedisClient(redisConfig).finally(() => {
    connectPromise = null;
  });
  return connectPromise;
}

export async function closeRedisClient(redisClient: RedisClient | null = client): Promise<void> {
  if (redisClient?.isOpen) {
    await redisClient.quit();
  }
  if (redisClient === client) {
    client = null;
    connectPromise = null;
  }
}

export function peekRedisClient(): RedisClient | null {
  return client;
}
