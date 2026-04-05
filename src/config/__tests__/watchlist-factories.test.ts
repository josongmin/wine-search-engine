import { describe, expect, it, vi } from 'vitest';
import type { WatchlistPublisherPort } from '../../infrastructure/watchlist/redis-watchlist-publisher.js';
import type { WatchlistSubscriberPort } from '../../infrastructure/watchlist/redis-watchlist-subscriber.js';
import { buildCoreAdapterServices } from '../container-adapters.js';
import { buildWatchlistContainerServices } from '../container-watchlist.js';
import { parseEnv } from '../env.js';

describe('watchlist runtime factories', () => {
  it('uses the injected watchlist publisher factory when watchlist-aware search is enabled', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
    });
    const publisherFactory = vi.fn<() => WatchlistPublisherPort>(() => ({
      publishUpdate: vi.fn(async () => {}),
    }));

    buildCoreAdapterServices(config, {
      createWatchlistPublisher: publisherFactory,
    });

    expect(publisherFactory).toHaveBeenCalledTimes(1);
  });

  it('uses the injected watchlist subscriber factory when watchlist delivery is enabled', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
    });
    const subscriberFactory = vi.fn<() => WatchlistSubscriberPort>(() => ({
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      isRunning: vi.fn(() => false),
    }));

    const services = buildWatchlistContainerServices(config, {
      createWatchlistSubscriber: subscriberFactory,
    });

    expect(subscriberFactory).toHaveBeenCalledTimes(1);
    expect(services.watchlistRuntime).not.toBeNull();
  });
});
