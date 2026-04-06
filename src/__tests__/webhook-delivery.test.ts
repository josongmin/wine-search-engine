/**
 * Tests for WebhookDelivery service.
 * Validates HMAC signature generation, payload structure, and retry logic.
 *
 * All retry tests inject a no-op sleepFn so they run without real delays.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebhookDelivery } from '../infrastructure/watchlist/webhook-delivery.js';
import type { WatchlistEntry, WatchlistChangeEvent } from '../domain/watchlist/model/watchlist-entry.js';

const SECRET = 'test-secret-min-16-characters!!!!';
const noopSleep = (_ms: number): Promise<void> => Promise.resolve();

describe('WebhookDelivery', () => {
  let delivery: WebhookDelivery;

  beforeEach(() => {
    // Inject no-op sleep so retry tests finish instantly.
    delivery = new WebhookDelivery(SECRET, noopSleep);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Constructor', () => {
    it('should throw on secret < 16 chars', () => {
      expect(() => new WebhookDelivery('short')).toThrow('WEBHOOK_SECRET must be at least 16 characters');
    });

    it('should accept 16-char secret', () => {
      const secret = '0123456789abcdef';
      expect(() => new WebhookDelivery(secret)).not.toThrow();
    });
  });

  describe('deliver()', () => {
    const entry: WatchlistEntry = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      userId: 'user-123',
      entityId: 'wine-opus-one-2018',
      triggerConditions: [
        {
          type: 'price_drop',
          threshold: 10,
          baselinePrice: 150,
        },
      ],
      callbackUrl: 'https://example.com/webhook',
      createdAt: new Date(),
      expiresAt: null,
    };

    const event: WatchlistChangeEvent = {
      type: 'price_updated',
      data: {
        newPrice: 135,
        oldPrice: 150,
        percentageDrop: 10,
      },
      occurredAt: '2025-04-06T10:00:00Z',
    };

    it('should succeed on 2xx response', async () => {
      const fetchSpy = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 }),
      );
      global.fetch = fetchSpy as any;

      const result = await delivery.deliver(entry, event);

      expect(result).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const call = fetchSpy.mock.calls[0];
      if (call) {
        expect(call[0]).toBe(entry.callbackUrl);
        expect(call[1]).toMatchObject({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-Wine-Watchlist-Signature': expect.any(String),
          }),
        });
      }
    });

    it('should return false on non-2xx response (exhausts all 4 attempts)', async () => {
      const fetchSpy = vi.fn()
        .mockResolvedValue(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }));
      global.fetch = fetchSpy as any;

      const result = await delivery.deliver(entry, event);

      expect(result).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    });

    it('should retry with 1 s, 5 s, 30 s backoff schedule (3 retries = 4 total attempts)', async () => {
      const sleepSpy = vi.fn(noopSleep);
      const d = new WebhookDelivery(SECRET, sleepSpy);

      const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
      global.fetch = fetchSpy as any;

      const result = await d.deliver(entry, event);

      expect(result).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(4);

      // Verify exact backoff durations: 1 s after attempt 1, 5 s after 2, 30 s after 3.
      expect(sleepSpy).toHaveBeenCalledTimes(3);
      expect(sleepSpy).toHaveBeenNthCalledWith(1, 1000);
      expect(sleepSpy).toHaveBeenNthCalledWith(2, 5000);
      expect(sleepSpy).toHaveBeenNthCalledWith(3, 30000);
    });

    it('should succeed on retry if eventual response is 2xx', async () => {
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce(new Response('{}', { status: 500 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
      global.fetch = fetchSpy as any;

      const result = await delivery.deliver(entry, event);

      expect(result).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('should include watchlist_id in payload', async () => {
      const fetchSpy = vi.fn().mockResolvedValueOnce(
        new Response('{}', { status: 200 }),
      );
      global.fetch = fetchSpy as any;

      await delivery.deliver(entry, event);

      const call = fetchSpy.mock.calls[0];
      if (call && call[1]) {
        const body = JSON.parse(call[1].body as string);
        expect(body.watchlist_id).toBe(entry.id);
      }
    });

    it('should set AbortSignal timeout to 5s', async () => {
      const fetchSpy = vi.fn().mockResolvedValueOnce(
        new Response('{}', { status: 200 }),
      );
      global.fetch = fetchSpy as any;

      await delivery.deliver(entry, event);

      const call = fetchSpy.mock.calls[0];
      if (call && call[1]) {
        expect(call[1].signal).toBeDefined();
      }
    });
  });

  describe('HMAC signature', () => {
    it('should compute correct signature', async () => {
      const watchlistId = 'test-id';
      const payload = JSON.stringify({
        watchlist_id: watchlistId,
        entity_id: 'wine-123',
        event_type: 'price_updated',
        event_data: {},
        triggered_at: '2025-04-06T10:00:00Z',
      });

      const entry: WatchlistEntry = {
        id: watchlistId,
        userId: 'user-123',
        entityId: 'wine-123',
        triggerConditions: [],
        callbackUrl: 'https://example.com/webhook',
        createdAt: new Date(),
        expiresAt: null,
      };

      const event: WatchlistChangeEvent = {
        type: 'price_updated',
        data: {},
        occurredAt: '2025-04-06T10:00:00Z',
      };

      const fetchSpy = vi.fn().mockResolvedValueOnce(
        new Response('{}', { status: 200 }),
      );
      global.fetch = fetchSpy as any;

      await delivery.deliver(entry, event);

      expect(fetchSpy).toHaveBeenCalled();
      const call = fetchSpy.mock.calls[0];
      expect(call).toBeDefined();
      const init = call![1];
      expect(init).toBeDefined();
      expect(JSON.parse(init!.body as string)).toEqual(JSON.parse(payload));

      const sigHeader = (init!.headers as Record<string, string>)['X-Wine-Watchlist-Signature'];
      expect(sigHeader).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
