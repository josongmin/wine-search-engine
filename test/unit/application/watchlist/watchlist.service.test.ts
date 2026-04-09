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

describe('InMemoryWatchlistStore.withTransaction (port parity)', () => {
  it('rolls back mutations when the callback throws, matching PG semantics', async () => {
    const store = new InMemoryWatchlistStore();

    const baseline = {
      id: 'w-baseline',
      userId: 'u-1',
      entityId: 'e-1',
      triggerConditions: [],
      callbackUrl: 'https://example.com/cb',
      createdAt: new Date('2025-01-01T00:00:00Z'),
      expiresAt: null,
    };
    await store.save(baseline);

    await expect(
      store.withTransaction(async (tx) => {
        // Mutate inside the transaction, then throw — the rollback path must
        // restore the pre-transaction snapshot. Without it, the in-memory
        // adapter would silently commit partial state and diverge from the
        // PG adapter, which runs BEGIN/ROLLBACK (see port JSDoc).
        await tx.save({
          ...baseline,
          id: 'w-new',
          entityId: 'e-2',
        });
        await tx.append({
          id: 'log-1',
          watchlistId: 'w-baseline',
          attempt: 1,
          statusCode: 500,
          errorMessage: 'boom',
          deliveredAt: new Date(),
        });
        throw new Error('fail-midway');
      }),
    ).rejects.toThrow('fail-midway');

    await expect(store.findById('w-new')).resolves.toBeNull();
    await expect(store.findById('w-baseline')).resolves.toEqual(baseline);
    await expect(store.listByWatchlistId('w-baseline')).resolves.toEqual([]);
  });

  it('commits mutations when the callback resolves', async () => {
    const store = new InMemoryWatchlistStore();

    const result = await store.withTransaction(async (tx) => {
      await tx.save({
        id: 'w-commit',
        userId: 'u-1',
        entityId: 'e-commit',
        triggerConditions: [],
        callbackUrl: 'https://example.com/cb',
        createdAt: new Date('2025-01-01T00:00:00Z'),
        expiresAt: null,
      });
      return 'ok';
    });
    expect(result).toBe('ok');
    await expect(store.findById('w-commit')).resolves.not.toBeNull();
  });
});
