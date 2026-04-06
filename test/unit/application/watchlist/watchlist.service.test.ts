import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WatchlistService } from '../../../../src/application/watchlist/watchlist.service.js';
import { InMemoryWatchlistStore } from '../../../../src/infrastructure/watchlist/in-memory-watchlist-store.js';

function createService() {
  return new WatchlistService({
    storage: new InMemoryWatchlistStore(),
    idGenerator: randomUUID,
  });
}

describe('WatchlistService', () => {
  it('scopes lookups to the owning user and supports current-user listing', async () => {
    const service = createService();

    const ownerEntry = await service.create({
      userId: 'owner-1',
      entityId: 'wine-opus-one-2018',
      triggerConditions: [],
      callbackUrl: 'https://example.com/webhook',
      expiresAt: null,
    });
    await service.create({
      userId: 'owner-2',
      entityId: 'wine-sassicaia-2019',
      triggerConditions: [],
      callbackUrl: 'https://example.com/webhook',
      expiresAt: null,
    });

    await expect(service.listByUserId('owner-1')).resolves.toEqual([ownerEntry]);
    await expect(service.getByIdForUser({
      watchlistId: ownerEntry.id,
      userId: 'owner-2',
    })).resolves.toBeNull();
  });

  it('refuses to delete or list deliveries for cross-user watchlists', async () => {
    const service = createService();
    const entry = await service.create({
      userId: 'owner-1',
      entityId: 'wine-opus-one-2018',
      triggerConditions: [],
      callbackUrl: 'https://example.com/webhook',
      expiresAt: null,
    });

    await expect(service.deleteForUser({
      watchlistId: entry.id,
      userId: 'owner-2',
    })).resolves.toBe(false);
    await expect(service.listDeliveries({
      watchlistId: entry.id,
      userId: 'owner-2',
    })).resolves.toBeNull();
  });

  it('records delivery logs only when the parent watchlist exists', async () => {
    const service = createService();

    await expect(service.recordDeliveryLog({
      watchlistId: randomUUID(),
      attempt: 1,
      statusCode: 200,
      errorMessage: null,
    })).resolves.toBe(false);

    const entry = await service.create({
      userId: 'owner-1',
      entityId: 'wine-opus-one-2018',
      triggerConditions: [],
      callbackUrl: 'https://example.com/webhook',
      expiresAt: null,
    });

    await expect(service.recordDeliveryLog({
      watchlistId: entry.id,
      attempt: 1,
      statusCode: 200,
      errorMessage: null,
    })).resolves.toBe(true);
    await expect(service.listDeliveries({
      watchlistId: entry.id,
      userId: 'owner-1',
    })).resolves.toHaveLength(1);
  });
});
