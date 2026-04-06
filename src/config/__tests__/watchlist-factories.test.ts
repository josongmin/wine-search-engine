import { describe, expect, it, vi } from 'vitest';
import type { WatchlistPublisherPort } from '../../infrastructure/watchlist/redis-watchlist-publisher.js';
import type { WatchlistSubscriberPort } from '../../infrastructure/watchlist/redis-watchlist-subscriber.js';
import { buildCoreAdapterServices } from '../container-adapters.js';
import { buildWatchlistContainerServices } from '../container-watchlist.js';
import { parseEnv } from '../env.js';

describe('watchlist runtime factories', () => {
  it('does not create a delivery runtime when watchlist is disabled', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      WATCHLIST_ENABLED: 'false',
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

    expect(subscriberFactory).not.toHaveBeenCalled();
    expect(services.watchlistRuntime).toBeNull();
  });

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

  it('allows in-memory watchlist storage fallback outside production', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      WATCHLIST_ENABLED: 'true',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
    });

    const services = buildWatchlistContainerServices(config, {
      createWatchlistSubscriber: () => ({
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        isRunning: vi.fn(() => false),
      }),
    });

    await expect(services.watchlistService.create({
      entityId: 'wine_1',
      callbackUrl: 'https://example.com/hook',
      triggerConditions: ['price_drop'],
      metadata: {},
    })).resolves.toMatchObject({ entityId: 'wine_1' });
  });

  it('rejects watchlist delivery without persistent storage in production', () => {
    const config = parseEnv({
      NODE_ENV: 'production',
      WATCHLIST_ENABLED: 'true',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
    });

    expect(() => buildWatchlistContainerServices(config, {
      createWatchlistSubscriber: () => ({
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        isRunning: vi.fn(() => false),
      }),
    })).toThrowError(/PostgreSQL-backed storage/);
  });
});
