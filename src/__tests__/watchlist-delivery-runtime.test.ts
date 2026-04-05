import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { WatchlistDeliveryRuntime } from '../infrastructure/watchlist/watchlist-delivery-runtime.js';
import type { WatchlistEntry, WatchlistChangeEvent } from '../domain/watchlist/model/watchlist-entry.js';
import type { WatchlistServicePort } from '../application/watchlist/watchlist.service.js';

describe('WatchlistDeliveryRuntime', () => {
  it('delivers matching events and records attempt logs', async () => {
    const entry: WatchlistEntry = {
      id: randomUUID(),
      userId: randomUUID(),
      entityId: 'wine-opus-one-2018',
      triggerConditions: [
        {
          type: 'price_drop',
          threshold: 10,
          baselinePrice: 120,
        },
      ],
      callbackUrl: 'https://example.com/webhook',
      createdAt: new Date('2026-04-06T00:00:00.000Z'),
      expiresAt: null,
    };
    const event: WatchlistChangeEvent = {
      type: 'price_updated',
      data: { newPrice: 100 },
      occurredAt: '2026-04-06T10:00:00.000Z',
    };
    const recordDeliveryLog = vi.fn(async () => {});
    const watchlistService: WatchlistServicePort = {
      create: vi.fn(),
      getById: vi.fn(),
      listByEntityId: vi.fn(async () => [entry]),
      delete: vi.fn(),
      listDeliveries: vi.fn(),
      recordDeliveryLog,
      clear: vi.fn(),
    };
    const subscriber = {
      start: vi.fn(async (handler: (entityId: string, input: WatchlistChangeEvent) => Promise<void>) => {
        await handler(entry.entityId, event);
      }),
      stop: vi.fn(async () => {}),
      isRunning: vi.fn(() => true),
    };
    const webhookDelivery = {
      deliver: vi.fn(async (_entry: WatchlistEntry, _event: WatchlistChangeEvent, observer?: {
        onAttempt?(log: {
          watchlistId: string;
          attempt: number;
          statusCode: number | null;
          errorMessage: string | null;
          deliveredAt: Date;
        }): Promise<void> | void;
      }) => {
        await observer?.onAttempt?.({
          watchlistId: entry.id,
          attempt: 1,
          statusCode: 200,
          errorMessage: null,
          deliveredAt: new Date('2026-04-06T10:00:01.000Z'),
        });
        return true;
      }),
    };

    const runtime = new WatchlistDeliveryRuntime({
      watchlistService,
      subscriber: subscriber as any,
      webhookDelivery: webhookDelivery as any,
    });

    await runtime.start();

    expect(watchlistService.listByEntityId).toHaveBeenCalledWith(entry.entityId);
    expect(webhookDelivery.deliver).toHaveBeenCalledWith(entry, event, expect.any(Object));
    expect(recordDeliveryLog).toHaveBeenCalledWith(expect.objectContaining({
      watchlistId: entry.id,
      attempt: 1,
      statusCode: 200,
      errorMessage: null,
    }));
  });

  it('skips expired entries', async () => {
    const expiredEntry: WatchlistEntry = {
      id: randomUUID(),
      userId: randomUUID(),
      entityId: 'wine-expired',
      triggerConditions: [],
      callbackUrl: 'https://example.com/webhook',
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
      expiresAt: new Date('2026-04-05T00:00:00.000Z'),
    };
    const event: WatchlistChangeEvent = {
      type: 'stock_changed',
      data: { qty: 5 },
      occurredAt: '2026-04-06T10:00:00.000Z',
    };
    const watchlistService: WatchlistServicePort = {
      create: vi.fn(),
      getById: vi.fn(),
      listByEntityId: vi.fn(async () => [expiredEntry]),
      delete: vi.fn(),
      listDeliveries: vi.fn(),
      recordDeliveryLog: vi.fn(),
      clear: vi.fn(),
    };
    const subscriber = {
      start: vi.fn(async (handler: (entityId: string, input: WatchlistChangeEvent) => Promise<void>) => {
        await handler(expiredEntry.entityId, event);
      }),
      stop: vi.fn(async () => {}),
      isRunning: vi.fn(() => true),
    };
    const webhookDelivery = {
      deliver: vi.fn(async () => true),
    };

    const runtime = new WatchlistDeliveryRuntime({
      watchlistService,
      subscriber: subscriber as any,
      webhookDelivery: webhookDelivery as any,
      now: () => new Date('2026-04-06T12:00:00.000Z'),
    });

    await runtime.start();

    expect(webhookDelivery.deliver).not.toHaveBeenCalled();
    expect(watchlistService.recordDeliveryLog).not.toHaveBeenCalled();
  });

  it('skips entries whose triggers do not match the incoming event', async () => {
    const entry: WatchlistEntry = {
      id: randomUUID(),
      userId: randomUUID(),
      entityId: 'wine-no-trigger-match',
      triggerConditions: [
        {
          type: 'price_drop',
          threshold: 25,
          baselinePrice: 200,
        },
      ],
      callbackUrl: 'https://example.com/webhook',
      createdAt: new Date('2026-04-06T00:00:00.000Z'),
      expiresAt: null,
    };
    const event: WatchlistChangeEvent = {
      type: 'price_updated',
      data: { oldPrice: 200, newPrice: 190 },
      occurredAt: '2026-04-06T10:00:00.000Z',
    };
    const watchlistService: WatchlistServicePort = {
      create: vi.fn(),
      getById: vi.fn(),
      listByEntityId: vi.fn(async () => [entry]),
      delete: vi.fn(),
      listDeliveries: vi.fn(),
      recordDeliveryLog: vi.fn(),
      clear: vi.fn(),
    };
    const subscriber = {
      start: vi.fn(async (handler: (entityId: string, input: WatchlistChangeEvent) => Promise<void>) => {
        await handler(entry.entityId, event);
      }),
      stop: vi.fn(async () => {}),
      isRunning: vi.fn(() => true),
    };
    const webhookDelivery = {
      deliver: vi.fn(async () => true),
    };

    const runtime = new WatchlistDeliveryRuntime({
      watchlistService,
      subscriber: subscriber as any,
      webhookDelivery: webhookDelivery as any,
    });

    await runtime.start();

    expect(webhookDelivery.deliver).not.toHaveBeenCalled();
    expect(watchlistService.recordDeliveryLog).not.toHaveBeenCalled();
  });
});
