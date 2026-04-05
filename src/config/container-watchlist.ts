import { WatchlistService } from '../application/watchlist/watchlist.service.js';
import { InMemoryWatchlistStore } from '../infrastructure/watchlist/in-memory-watchlist-store.js';
import { RedisWatchlistSubscriber } from '../infrastructure/watchlist/redis-watchlist-subscriber.js';
import { WatchlistDeliveryRuntime } from '../infrastructure/watchlist/watchlist-delivery-runtime.js';
import { WebhookDelivery } from '../infrastructure/watchlist/webhook-delivery.js';
import type { Config } from './env.js';
import type {
  WatchlistRuntimeContract,
  WatchlistServiceContract,
} from './container-contracts.js';

export interface WatchlistContainerServices {
  readonly watchlistService: WatchlistServiceContract;
  readonly watchlistRuntime: WatchlistRuntimeContract | null;
}

export function buildWatchlistContainerServices(config: Config): WatchlistContainerServices {
  const store = new InMemoryWatchlistStore();
  const watchlistService: WatchlistServiceContract = new WatchlistService({
    watchlistRepository: store,
    deliveryLogRepository: store,
  });
  const watchlistRuntime: WatchlistRuntimeContract | null = config.watchlist.webhookSecret
    ? new WatchlistDeliveryRuntime({
        watchlistService,
        subscriber: new RedisWatchlistSubscriber(),
        webhookDelivery: new WebhookDelivery(config.watchlist.webhookSecret),
      })
    : null;

  return {
    watchlistService,
    watchlistRuntime,
  };
}
