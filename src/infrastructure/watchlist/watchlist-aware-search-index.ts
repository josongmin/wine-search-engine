import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import type { RetrievalDocument } from '../../domain/retrieval/model/retrieval-document.js';
import type { SearchIndexPort } from '../../domain/retrieval/port/search-index.port.js';
import type { WatchlistChangeEvent } from '../../domain/watchlist/model/watchlist-entry.js';
import type { WatchlistPublisherPort } from './redis-watchlist-publisher.js';

const log = bootstrapLogger.child({ component: 'WatchlistAwareSearchIndex' });

interface WatchlistAwareSearchIndexDeps {
  readonly inner: SearchIndexPort;
  readonly publisher: WatchlistPublisherPort;
  readonly now?: () => string;
}

export class WatchlistAwareSearchIndex implements SearchIndexPort {
  private readonly inner: SearchIndexPort;
  private readonly publisher: WatchlistPublisherPort;
  private readonly now: () => string;

  constructor(deps: WatchlistAwareSearchIndexDeps) {
    this.inner = deps.inner;
    this.publisher = deps.publisher;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  sparseSearch(...args: Parameters<SearchIndexPort['sparseSearch']>) {
    return this.inner.sparseSearch(...args);
  }

  denseSearch(...args: Parameters<SearchIndexPort['denseSearch']>) {
    return this.inner.denseSearch(...args);
  }

  getDocument(...args: Parameters<SearchIndexPort['getDocument']>) {
    return this.inner.getDocument(...args);
  }

  async upsertDocument(doc: RetrievalDocument): Promise<void> {
    const previous = await this.inner.getDocument(doc.entityId);
    await this.inner.upsertDocument(doc);
    await this.publishEvents(previous, doc);
  }

  async bulkUpsert(docs: readonly RetrievalDocument[]): Promise<void> {
    const previousDocuments = await Promise.all(
      docs.map(async (doc) => [doc.entityId, await this.inner.getDocument(doc.entityId)] as const),
    );
    const previousById = new Map(previousDocuments);

    await this.inner.bulkUpsert(docs);

    await Promise.all(
      docs.map(async (doc) => {
        const previous = previousById.get(doc.entityId) ?? null;
        await this.publishEvents(previous, doc);
      }),
    );
  }

  private async publishEvents(
    previous: RetrievalDocument | null,
    next: RetrievalDocument,
  ): Promise<void> {
    const events = this.buildEvents(previous, next);
    const results = await Promise.allSettled(events.map(async (event) => {
      await this.publisher.publishUpdate(next.entityId, event);
    }));

    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        log.error(
          {
            err: result.reason,
            entityId: next.entityId,
            eventType: events[index]?.type ?? 'unknown',
          },
          'watchlist publish failed',
        );
      }
    }
  }

  private buildEvents(
    previous: RetrievalDocument | null,
    next: RetrievalDocument,
  ): readonly WatchlistChangeEvent[] {
    const events: WatchlistChangeEvent[] = [];
    const occurredAt = this.now();

    if (
      next.vintageYear !== undefined &&
      (previous === null || previous.vintageYear === undefined || previous.vintageYear !== next.vintageYear)
    ) {
      events.push({
        type: 'vintage_released',
        data: {
          vintage: next.vintageYear,
          canonicalLabel: next.canonicalLabel,
        },
        occurredAt,
      });
    }

    if (
      previous?.priceUsd !== undefined &&
      next.priceUsd !== undefined &&
      next.priceUsd < previous.priceUsd
    ) {
      events.push({
        type: 'price_updated',
        data: {
          oldPrice: previous.priceUsd,
          newPrice: next.priceUsd,
          percentageDrop: ((previous.priceUsd - next.priceUsd) / previous.priceUsd) * 100,
        },
        occurredAt,
      });
    }

    if (previous?.availability !== next.availability) {
      events.push({
        type: 'stock_changed',
        data: {
          stock: next.availability ? 1 : 0,
          available: next.availability,
        },
        occurredAt,
      });
    }

    if (
      next.criticScoreNormalized !== undefined &&
      (previous?.criticScoreNormalized === undefined
        || previous.criticScoreNormalized !== next.criticScoreNormalized)
    ) {
      events.push({
        type: 'critic_score_updated',
        data: {
          score: Math.round(next.criticScoreNormalized * 100),
          previousScore: previous?.criticScoreNormalized !== undefined
            ? Math.round(previous.criticScoreNormalized * 100)
            : null,
        },
        occurredAt,
      });
    }

    return events;
  }
}
