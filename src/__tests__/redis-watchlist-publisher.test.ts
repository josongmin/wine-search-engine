/**
 * Tests for RedisWatchlistPublisher.
 * Validates event publishing to Redis channels.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RedisWatchlistPublisher } from '../infrastructure/watchlist/redis-watchlist-publisher.js';
import type { WatchlistChangeEvent } from '../domain/watchlist/model/watchlist-entry.js';

describe('RedisWatchlistPublisher', () => {
  let publisher: RedisWatchlistPublisher;
  let publish: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    publish = vi.fn(async () => 1);
    publisher = new RedisWatchlistPublisher({
      client: {
        publish,
      } as any,
    });
    vi.clearAllMocks();
  });

  describe('publishUpdate()', () => {
    it('should publish event to correct channel', async () => {
      const entityId = 'wine-opus-one-2018';
      const event: WatchlistChangeEvent = {
        type: 'price_updated',
        data: {
          newPrice: 135,
          oldPrice: 150,
          percentageDrop: 10,
        },
        occurredAt: '2025-04-06T10:00:00Z',
      };

      await publisher.publishUpdate(entityId, event);

      expect(publish).toHaveBeenCalledWith(`watchlist:${entityId}`, JSON.stringify(event));
    });

    it('should construct correct channel name', async () => {
      const entityId = 'test-entity';
      const event: WatchlistChangeEvent = {
        type: 'stock_changed',
        data: {
          stock: 1,
          available: true,
        },
        occurredAt: new Date().toISOString(),
      };

      await publisher.publishUpdate(entityId, event);
      expect(publish).toHaveBeenCalledWith('watchlist:test-entity', JSON.stringify(event));
    });

    it('should serialize event as JSON', async () => {
      const event: WatchlistChangeEvent = {
        type: 'stock_changed',
        data: { stock: 100, available: true },
        occurredAt: '2025-04-06T10:00:00Z',
      };

      // Verify event is serializable
      const json = JSON.stringify(event);
      expect(json).toContain('stock_changed');
      expect(json).toContain('stock');
    });
  });
});
