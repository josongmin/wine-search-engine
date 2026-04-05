import { WatchlistService } from '../application/watchlist/watchlist.service.js';
import { InMemoryWatchlistStore } from '../infrastructure/watchlist/in-memory-watchlist-store.js';
import { RedisWatchlistSubscriber } from '../infrastructure/watchlist/redis-watchlist-subscriber.js';
import { WatchlistDeliveryRuntime } from '../infrastructure/watchlist/watchlist-delivery-runtime.js';
import { WebhookDelivery } from '../infrastructure/watchlist/webhook-delivery.js';
import type { WatchlistServicePort } from '../application/watchlist/watchlist.service.js';
import type { WatchlistRuntimePort } from '../infrastructure/watchlist/watchlist-delivery-runtime.js';
import type { Config } from './env.js';
import { getWatchlistWebhookSecret, isWatchlistEnabled } from './watchlist.js';
import type { RuntimeHandles } from './runtime-handles.js';

export interface WatchlistContainerServices {
  readonly watchlistService: WatchlistServicePort;
  readonly watchlistRuntime: WatchlistRuntimePort | null;
}

export function buildWatchlistContainerServices(
  config: Config,
  runtime: RuntimeHandles = {},
): WatchlistContainerServices {
  const store = new InMemoryWatchlistStore();
  const watchlistService: WatchlistServicePort = new WatchlistService({
    watchlistRepository: store,
    deliveryLogRepository: store,
  });
  const watchlistRuntime: WatchlistRuntimePort | null = isWatchlistEnabled(config)
    ? new WatchlistDeliveryRuntime({
        watchlistService,
        subscriber: runtime.createWatchlistSubscriber?.()
          ?? new RedisWatchlistSubscriber(config.redis),
        webhookDelivery: new WebhookDelivery(getWatchlistWebhookSecret(config)),
      })
    : null;

  return {
    watchlistService,
    watchlistRuntime,
  };
}
