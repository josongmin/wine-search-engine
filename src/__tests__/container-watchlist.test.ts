import { describe, expect, it, vi } from 'vitest';
import { buildWatchlistContainerServices } from '../config/container-watchlist.js';
import { parseEnv } from '../config/env.js';
import type { WatchlistStoragePort } from '../domain/watchlist/port/watchlist-repository.port.js';

function createStorage(): WatchlistStoragePort {
  return {
    save: vi.fn(async () => {}),
    findById: vi.fn(async () => null),
    findByEntityId: vi.fn(async () => []),
    delete: vi.fn(async () => false),
    listByWatchlistId: vi.fn(async () => []),
    append: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  };
}

describe('buildWatchlistContainerServices', () => {
  it('uses an injected watchlist store factory when provided', async () => {
    const storage = createStorage();
    const config = parseEnv({
      NODE_ENV: 'test',
      WATCHLIST_ENABLED: 'false',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
    });

    const container = buildWatchlistContainerServices(config, {
      createWatchlistStore: () => storage,
    });

    await container.watchlistService.create({
      userId: 'user-1',
      entityId: 'entity-1',
      triggerConditions: [],
      callbackUrl: 'https://example.com/webhook',
      expiresAt: null,
    });

    expect(storage.save).toHaveBeenCalledTimes(1);
  });

  it('delegates delete cleanup to the storage implementation', async () => {
    const storage = createStorage();
    const config = parseEnv({
      NODE_ENV: 'test',
      WATCHLIST_ENABLED: 'false',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
    });
    (storage.delete as any).mockResolvedValueOnce(true);

    const container = buildWatchlistContainerServices(config, {
      createWatchlistStore: () => storage,
    });

    await container.watchlistService.delete('watchlist-1');

    expect(storage.delete).toHaveBeenCalledWith('watchlist-1');
  });
});
