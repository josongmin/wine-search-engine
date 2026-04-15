/**
 * E5-U4: Rollout-Governor Scope
 *
 * RuntimeHandles is the rollout governor — it controls feature flag activation
 * for eval, LTR, calibration.
 *
 * All gating decisions MUST go through RuntimeHandles; do NOT add feature flags
 * in domain services directly.
 */

import type { Pool } from 'pg';
import type { NodeSDK } from '@opentelemetry/sdk-node';
import type { WatchlistStoragePort } from '../domain/watchlist/port/watchlist-repository.port.js';
import type { WatchlistPublisherPort } from '../infrastructure/watchlist/redis-watchlist-publisher.js';
import type { WatchlistSubscriberPort } from '../infrastructure/watchlist/redis-watchlist-subscriber.js';
import { closePgPool } from '../infrastructure/db/pg-pool.js';
import { closeRedisClient, type RedisClient } from '../infrastructure/db/redis-client.js';

export interface RuntimeHandles {
  readonly pool?: Pool;
  readonly redisClient?: RedisClient;
  readonly createWatchlistStore?: () => WatchlistStoragePort;
  readonly createWatchlistPublisher?: () => WatchlistPublisherPort;
  readonly createWatchlistSubscriber?: () => WatchlistSubscriberPort;
}

interface ManagedRuntimeHandles extends RuntimeHandles {
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

        const failures: unknown[] = [];
        for (const result of results) {
          if (result.status === 'rejected') {
            failures.push(result.reason);
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, 'Failed to close runtime handles cleanly');
        }
      })();

      await closePromise;
    },
  };
}
