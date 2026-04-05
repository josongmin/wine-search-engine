import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  parseWatchlistChangeEvent,
  type WatchlistChangeEvent,
  type WatchlistEntry,
} from '../domain/watchlist/model/watchlist-entry.js';
import {
  matchesWatchlistTrigger,
  shouldDeliverWatchlistEvent,
  toWatchlistTriggerResponse,
} from '../domain/watchlist/service/watchlist-policy.js';

describe('watchlist policy', () => {
  it('maps domain triggers to HTTP response shape consistently', () => {
    expect(
      toWatchlistTriggerResponse({
        type: 'price_drop',
        threshold: 10,
        baselinePrice: 150,
      }),
    ).toEqual({
      type: 'price_drop',
      threshold: 10,
      baseline_price: 150,
    });
  });

  it('matches price drop events against trigger thresholds', () => {
    const event: WatchlistChangeEvent = {
      type: 'price_updated',
      occurredAt: '2026-04-06T10:00:00.000Z',
      data: {
        oldPrice: 200,
        newPrice: 150,
        percentageDrop: 25,
      },
    };

    expect(
      matchesWatchlistTrigger(
        {
          type: 'price_drop',
          threshold: 20,
          baselinePrice: 220,
        },
        event,
      ),
    ).toBe(true);
  });

  it('filters expired entries before delivery', () => {
    const entry: WatchlistEntry = {
      id: randomUUID(),
      userId: randomUUID(),
      entityId: 'wine-expired',
      triggerConditions: [
        {
          type: 'stock_available',
          minQty: 1,
        },
      ],
      callbackUrl: 'https://example.com/webhook',
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
      expiresAt: new Date('2026-04-05T00:00:00.000Z'),
    };
    const event: WatchlistChangeEvent = {
      type: 'stock_changed',
      occurredAt: '2026-04-06T10:00:00.000Z',
      data: {
        stock: 5,
        available: true,
      },
    };

    expect(
      shouldDeliverWatchlistEvent(entry, event, new Date('2026-04-06T12:00:00.000Z')),
    ).toBe(false);
  });

  it('rejects malformed watchlist events at the domain boundary', () => {
    expect(
      parseWatchlistChangeEvent({
        type: 'price_updated',
        occurredAt: 'not-an-iso-date',
        data: {
          oldPrice: 200,
          newPrice: 150,
        },
      }),
    ).toBeNull();
  });
});
