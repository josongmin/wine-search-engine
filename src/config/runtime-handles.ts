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
import type { SearchSnapshotFieldAvailability } from '../domain/shared/types/search-field-availability.js';
import { closePgPool } from '../infrastructure/db/pg-pool.js';
import { closeRedisClient, type RedisClient } from '../infrastructure/db/redis-client.js';
import { loadSearchSnapshotRuntimeState } from '../infrastructure/health/search-snapshot-readiness.js';

export interface RuntimeHandles {
  readonly pool?: Pool;
  readonly redisClient?: RedisClient;
  readonly createWatchlistStore?: () => WatchlistStoragePort;
  readonly createWatchlistPublisher?: () => WatchlistPublisherPort;
  readonly createWatchlistSubscriber?: () => WatchlistSubscriberPort;
  /**
   * Optional non-live snapshot binding for eval / shadow workflows.
   *
   * When present, container startup MUST scope snapshot-bound read paths
   * (alias preload, fuzzy warmup, retrieval filters, runtime field-availability)
   * to this snapshot instead of the active pointer.
   */
  readonly searchSnapshotId?: string;
  readonly searchSnapshotManifestPath?: string;
  readonly searchSnapshotFieldAvailability?: SearchSnapshotFieldAvailability;
}

/**
 * Binds pool-backed live runtimes to the currently published search snapshot
 * artifact so hot-path adapters do not re-resolve `active_search_snapshot`
 * from PostgreSQL on every request.
 *
 * Snapshot-scoped eval / shadow runs already provide explicit bindings and are
 * preserved as-is.
 */
export async function bindLiveSearchSnapshotRuntimeHandles(
  runtime: RuntimeHandles,
): Promise<RuntimeHandles> {
  if (
    runtime.pool === undefined
    || runtime.searchSnapshotId !== undefined
  ) {
    return runtime;
  }

  const runtimeState = await loadSearchSnapshotRuntimeState();
  return {
    ...runtime,
    searchSnapshotId: runtimeState.snapshotId,
    searchSnapshotManifestPath: runtimeState.manifestPath,
    searchSnapshotFieldAvailability: runtimeState.fieldAvailability,
  };
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
