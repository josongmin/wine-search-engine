import { WatchlistService } from '../application/watchlist/watchlist.service.js';
import { InMemoryWatchlistStore } from '../infrastructure/watchlist/in-memory-watchlist-store.js';
import { PgWatchlistStore } from '../infrastructure/watchlist/pg-watchlist-store.js';
import { PgWatchlistPoisonStore } from '../infrastructure/watchlist/pg-watchlist-poison-store.js';
import { RedisWatchlistSubscriber } from '../infrastructure/watchlist/redis-watchlist-subscriber.js';
import type { WatchlistPoisonStore } from '../infrastructure/watchlist/redis-watchlist-subscriber.js';
import { WatchlistDeliveryRuntime } from '../infrastructure/watchlist/watchlist-delivery-runtime.js';
import { WebhookDelivery } from '../infrastructure/watchlist/webhook-delivery.js';
import type { WatchlistServicePort } from '../application/watchlist/watchlist.service.js';
import type { WatchlistRuntimePort } from '../infrastructure/watchlist/watchlist-delivery-runtime.js';
import type { WatchlistStoragePort } from '../domain/watchlist/port/watchlist-repository.port.js';
import type { Config } from './env.js';
import {
  canUseInMemoryWatchlistStore,
  getWatchlistWebhookSecret,
  isWatchlistEnabled,
  requiresPersistentWatchlistStore,
} from './watchlist.js';
import type { RuntimeHandles } from './runtime-handles.js';

export interface WatchlistContainerServices {
  readonly watchlistService: WatchlistServicePort;
  readonly watchlistRuntime: WatchlistRuntimePort | null;
}

export function buildWatchlistContainerServices(
  config: Config,
  runtime: RuntimeHandles = {},
): WatchlistContainerServices {
  const store = buildWatchlistStore(config, runtime);
  const watchlistService: WatchlistServicePort = new WatchlistService({
    storage: store,
  });
  // Wave 3 / H12: bind a durable PG-backed DLQ when a pool is available.
  // The in-memory fallback (default inside RedisWatchlistSubscriber) is only
  // acceptable for dev/test where persistence-across-restart is not required.
  const poisonStore: WatchlistPoisonStore | undefined = runtime.pool !== undefined
    ? new PgWatchlistPoisonStore(runtime.pool)
    : undefined;

  const watchlistRuntime: WatchlistRuntimePort | null = isWatchlistEnabled(config)
    ? new WatchlistDeliveryRuntime({
        watchlistService,
        subscriber: runtime.createWatchlistSubscriber?.()
          ?? new RedisWatchlistSubscriber(
            config.redis,
            undefined,
            poisonStore !== undefined ? { poisonStore } : undefined,
          ),
        webhookDelivery: new WebhookDelivery(getWatchlistWebhookSecret(config)),
      })
    : null;

  return {
    watchlistService,
    watchlistRuntime,
  };
}

function buildWatchlistStore(
  config: Config,
  runtime: RuntimeHandles,
): WatchlistStoragePort {
  if (runtime.createWatchlistStore !== undefined) {
    return runtime.createWatchlistStore();
  }

  if (runtime.pool !== undefined) {
    return new PgWatchlistStore(runtime.pool);
  }

  if (requiresPersistentWatchlistStore(config)) {
    throw new Error(
      'Watchlist delivery requires PostgreSQL-backed storage in production; configure PG or disable watchlist delivery.',
    );
  }

  if (!canUseInMemoryWatchlistStore(config)) {
    throw new Error('In-memory watchlist storage is disabled for this environment.');
  }

  return new InMemoryWatchlistStore();
}
