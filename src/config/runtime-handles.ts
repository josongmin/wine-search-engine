import type { Pool } from 'pg';
import type { NodeSDK } from '@opentelemetry/sdk-node';
import type { WatchlistPublisherPort } from '../infrastructure/watchlist/redis-watchlist-publisher.js';
import type { WatchlistSubscriberPort } from '../infrastructure/watchlist/redis-watchlist-subscriber.js';
import { closePgPool } from '../infrastructure/db/pg-pool.js';
import { closeRedisClient, type RedisClient } from '../infrastructure/db/redis-client.js';

export interface RuntimeHandles {
  readonly pool?: Pool;
  readonly redisClient?: RedisClient;
  readonly createWatchlistPublisher?: () => WatchlistPublisherPort;
  readonly createWatchlistSubscriber?: () => WatchlistSubscriberPort;
}

export interface ManagedRuntimeHandles extends RuntimeHandles {
  close(): Promise<void>;
}

export function createManagedRuntimeHandles(
  runtime: RuntimeHandles,
  options?: { readonly telemetrySdk?: NodeSDK },
): ManagedRuntimeHandles {
  let closePromise: Promise<void> | null = null;

  return {
    ...runtime,
    async close(): Promise<void> {
      if (closePromise !== null) {
        await closePromise;
        return;
      }

      closePromise = (async () => {
        const results = await Promise.allSettled([
          closePgPool(runtime.pool ?? null),
          closeRedisClient(runtime.redisClient ?? null),
          options?.telemetrySdk?.shutdown() ?? Promise.resolve(),
        ]);

        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        if (failures.length > 0) {
          throw new AggregateError(failures, 'Failed to close runtime handles cleanly');
        }
      })();

      await closePromise;
    },
  };
}
