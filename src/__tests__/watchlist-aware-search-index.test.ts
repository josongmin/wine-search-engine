import { describe, expect, it, vi } from 'vitest';
import { createEntityId } from '../domain/shared/types/index.js';
import type { RetrievalDocument } from '../domain/retrieval/model/retrieval-document.js';
import type { SearchIndexPort } from '../domain/retrieval/port/search-index.port.js';
import { WatchlistAwareSearchIndex } from '../infrastructure/watchlist/watchlist-aware-search-index.js';
import { shouldDeliverWatchlistEvent } from '../domain/watchlist/service/watchlist-policy.js';
import type { WatchlistEntry, WatchlistChangeEvent } from '../domain/watchlist/model/watchlist-entry.js';

function buildDoc(overrides: Partial<RetrievalDocument> = {}): RetrievalDocument {
  return {
    entityId: createEntityId('wine-opus-one-2018'),
    entityType: 'wine',
    canonicalLabel: 'Opus One 2018',
    aliasesIdentitySafe: [],
    aliasesNoisyRecall: [],
    producer: 'Opus One',
    region: 'Napa Valley',
    grapes: ['Cabernet Sauvignon'],
    searchTextKo: '',
    searchTextEn: '',
    semanticSummary: '',
    body: 0.8,
    sweetness: 0.1,
    style: 'red',
    priceBand: 'premium',
    pairing: [],
    occasion: [],
    availability: true,
    popularityScore: 0.9,
    ...overrides,
  };
}

describe('WatchlistAwareSearchIndex', () => {
  it('publishes price, stock, critic, and vintage events derived from upserts', async () => {
    const previous = buildDoc({
      priceUsd: 150,
      availability: false,
      criticScoreNormalized: 0.92,
      vintageYear: 2017,
    });
    const next = buildDoc({
      priceUsd: 120,
      availability: true,
      criticScoreNormalized: 0.95,
      vintageYear: 2018,
    });
    const inner: SearchIndexPort = {
      sparseSearch: vi.fn(),
      denseSearch: vi.fn(),
      getDocument: vi.fn(async () => previous),
      upsertDocument: vi.fn(async () => {}),
      bulkUpsert: vi.fn(async () => {}),
    };
    const publishUpdate = vi.fn(async () => {});

    const index = new WatchlistAwareSearchIndex({
      inner,
      publisher: { publishUpdate } as any,
      now: () => '2026-04-06T12:00:00.000Z',
    });

    await index.upsertDocument(next);

    expect(publishUpdate).toHaveBeenCalledTimes(4);
    expect(publishUpdate).toHaveBeenCalledWith(next.entityId, expect.objectContaining({
      type: 'price_updated',
      occurredAt: '2026-04-06T12:00:00.000Z',
      data: expect.objectContaining({
        oldPrice: 150,
        newPrice: 120,
      }),
    }));
    expect(publishUpdate).toHaveBeenCalledWith(next.entityId, expect.objectContaining({
      type: 'stock_changed',
    }));
    expect(publishUpdate).toHaveBeenCalledWith(next.entityId, expect.objectContaining({
      type: 'critic_score_updated',
      data: expect.objectContaining({ score: 95 }),
    }));
    expect(publishUpdate).toHaveBeenCalledWith(next.entityId, expect.objectContaining({
      type: 'vintage_released',
      data: expect.objectContaining({ vintage: 2018 }),
    }));
  });

  it('does not publish anything for inert upserts', async () => {
    const doc = buildDoc({
      priceUsd: 120,
      availability: true,
      criticScoreNormalized: 0.95,
      vintageYear: 2018,
    });
    const inner: SearchIndexPort = {
      sparseSearch: vi.fn(),
      denseSearch: vi.fn(),
      getDocument: vi.fn(async () => doc),
      upsertDocument: vi.fn(async () => {}),
      bulkUpsert: vi.fn(async () => {}),
    };
    const publishUpdate = vi.fn(async () => {});

    const index = new WatchlistAwareSearchIndex({
      inner,
      publisher: { publishUpdate } as any,
    });

    await index.upsertDocument(doc);

    expect(publishUpdate).not.toHaveBeenCalled();
  });

  it('does not fail the upsert when publishing fails', async () => {
    const next = buildDoc({
      priceUsd: 120,
      availability: false,
      criticScoreNormalized: 0.95,
      vintageYear: 2018,
    });
    const inner: SearchIndexPort = {
      sparseSearch: vi.fn(),
      denseSearch: vi.fn(),
      getDocument: vi.fn(async () => null),
      upsertDocument: vi.fn(async () => {}),
      bulkUpsert: vi.fn(async () => {}),
    };
    const publishUpdate = vi.fn(async () => {
      throw new Error('redis unavailable');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const index = new WatchlistAwareSearchIndex({
      inner,
      publisher: { publishUpdate } as any,
    });

    await expect(index.upsertDocument(next)).resolves.toBeUndefined();
    expect(inner.upsertDocument).toHaveBeenCalledWith(next);
    expect(publishUpdate).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('publishes events that the delivery policy can consume without contract drift', async () => {
    const previous = buildDoc({
      priceUsd: 150,
    });
    const next = buildDoc({
      priceUsd: 120,
    });
    const inner: SearchIndexPort = {
      sparseSearch: vi.fn(),
      denseSearch: vi.fn(),
      getDocument: vi.fn(async () => previous),
      upsertDocument: vi.fn(async () => {}),
      bulkUpsert: vi.fn(async () => {}),
    };
    const publishedEvents: WatchlistChangeEvent[] = [];
    const entry: WatchlistEntry = {
      id: '0fba7ab6-1e5a-4b03-af45-83b39bdaf6b6',
      userId: 'd980c2a6-8796-4a78-9388-e3658d58f711',
      entityId: next.entityId,
      triggerConditions: [
        {
          type: 'price_drop',
          threshold: 10,
          baselinePrice: 150,
        },
      ],
      callbackUrl: 'https://example.com/webhook',
      createdAt: new Date('2026-04-06T00:00:00.000Z'),
      expiresAt: null,
    };

    const index = new WatchlistAwareSearchIndex({
      inner,
      publisher: {
        publishUpdate: vi.fn(async (_entityId, event) => {
          publishedEvents.push(event);
        }),
      },
      now: () => '2026-04-06T12:00:00.000Z',
    });

    await index.upsertDocument(next);

    const priceEvent = publishedEvents.find((event) => event.type === 'price_updated');
    expect(priceEvent).toBeDefined();
    expect(
      shouldDeliverWatchlistEvent(entry, priceEvent!, new Date('2026-04-06T12:00:00.000Z')),
    ).toBe(true);
  });
});
