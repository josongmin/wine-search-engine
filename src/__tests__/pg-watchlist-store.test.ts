import { describe, expect, it, vi } from 'vitest';
import { PgWatchlistStore } from '../infrastructure/watchlist/pg-watchlist-store.js';
import type { Pool } from 'pg';
import type { WatchlistEntry } from '../domain/watchlist/model/watchlist-entry.js';

function createPoolMock() {
  return {
    query: vi.fn(),
  } as unknown as Pool;
}

describe('PgWatchlistStore', () => {
  it('persists watchlist entries as jsonb trigger conditions', async () => {
    const pool = createPoolMock();
    const store = new PgWatchlistStore(pool);
    const entry: WatchlistEntry = {
      id: 'watchlist-1',
      userId: 'user-1',
      entityId: 'entity-1',
      triggerConditions: [
        {
          type: 'price_drop',
          threshold: 10,
          baselinePrice: 100,
        },
      ],
      callbackUrl: 'https://example.com/webhook',
      createdAt: new Date('2026-04-06T00:00:00.000Z'),
      expiresAt: null,
    };

    await store.save(entry);

    expect((pool.query as any).mock.calls[0]?.[1]?.[3]).toBe(
      JSON.stringify(entry.triggerConditions),
    );
  });

  it('hydrates watchlist rows back into domain entries', async () => {
    const pool = createPoolMock();
    (pool.query as any).mockResolvedValueOnce({
      rows: [
        {
          watchlist_id: 'watchlist-1',
          user_id: 'user-1',
          entity_id: 'entity-1',
          trigger_conditions: [
            {
              type: 'stock_available',
              minQty: 3,
            },
          ],
          callback_url: 'https://example.com/webhook',
          created_at: new Date('2026-04-06T00:00:00.000Z'),
          expires_at: null,
        },
      ],
    });

    const store = new PgWatchlistStore(pool);
    const result = await store.findById('watchlist-1');

    expect(result).toEqual({
      id: 'watchlist-1',
      userId: 'user-1',
      entityId: 'entity-1',
      triggerConditions: [
        {
          type: 'stock_available',
          minQty: 3,
        },
      ],
      callbackUrl: 'https://example.com/webhook',
      createdAt: new Date('2026-04-06T00:00:00.000Z'),
      expiresAt: null,
    });
  });

  it('rejects corrupted trigger_conditions rows instead of hydrating invalid domain data', async () => {
    const pool = createPoolMock();
    (pool.query as any).mockResolvedValueOnce({
      rows: [
        {
          watchlist_id: 'watchlist-1',
          user_id: 'user-1',
          entity_id: 'entity-1',
          trigger_conditions: [
            {
              type: 'price_drop',
              threshold: 'not-a-number',
              baselinePrice: 100,
            },
          ],
          callback_url: 'https://example.com/webhook',
          created_at: new Date('2026-04-06T00:00:00.000Z'),
          expires_at: null,
        },
      ],
    });

    const store = new PgWatchlistStore(pool);

    await expect(store.findById('watchlist-1')).rejects.toThrow(
      'Invalid watchlist trigger_conditions for watchlist watchlist-1',
    );
  });
});
