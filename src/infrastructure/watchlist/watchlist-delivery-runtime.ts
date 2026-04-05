import type { WatchlistChangeEvent } from '../../domain/watchlist/model/watchlist-entry.js';
import type {
  WatchlistServicePort,
} from '../../application/watchlist/watchlist.service.js';
import { RedisWatchlistSubscriber } from './redis-watchlist-subscriber.js';
import { WebhookDelivery } from './webhook-delivery.js';
import type { WatchlistTrigger } from '../../domain/watchlist/model/watchlist-entry.js';

export interface WatchlistRuntimePort {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
}

interface WatchlistDeliveryRuntimeDeps {
  readonly watchlistService: WatchlistServicePort;
  readonly subscriber: RedisWatchlistSubscriber;
  readonly webhookDelivery: WebhookDelivery;
  readonly now?: () => Date;
}

export class WatchlistDeliveryRuntime implements WatchlistRuntimePort {
  private readonly watchlistService: WatchlistServicePort;
  private readonly subscriber: RedisWatchlistSubscriber;
  private readonly webhookDelivery: WebhookDelivery;
  private readonly now: () => Date;

  constructor(deps: WatchlistDeliveryRuntimeDeps) {
    this.watchlistService = deps.watchlistService;
    this.subscriber = deps.subscriber;
    this.webhookDelivery = deps.webhookDelivery;
    this.now = deps.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    await this.subscriber.start(async (entityId, event) => {
      await this.processEvent(entityId, event);
    });
  }

  async stop(): Promise<void> {
    await this.subscriber.stop();
  }

  isRunning(): boolean {
    return this.subscriber.isRunning();
  }

  private async processEvent(
    entityId: string,
    event: WatchlistChangeEvent,
  ): Promise<void> {
    const entries = await this.watchlistService.listByEntityId(entityId);
    const activeEntries = entries.filter((entry) =>
      !this.isExpired(entry.expiresAt)
      && entry.triggerConditions.some((trigger) => this.matchesTrigger(trigger, event)),
    );

    await Promise.all(
      activeEntries.map(async (entry) => {
        await this.webhookDelivery.deliver(entry, event, {
          onAttempt: async (log) => {
            await this.watchlistService.recordDeliveryLog({
              watchlistId: log.watchlistId,
              attempt: log.attempt,
              statusCode: log.statusCode,
              errorMessage: log.errorMessage,
              deliveredAt: log.deliveredAt,
            });
          },
        });
      }),
    );
  }

  private isExpired(expiresAt: Date | null): boolean {
    return expiresAt !== null && expiresAt.getTime() <= this.now().getTime();
  }

  private matchesTrigger(
    trigger: WatchlistTrigger,
    event: WatchlistChangeEvent,
  ): boolean {
    switch (trigger.type) {
      case 'new_vintage':
        return this.matchesNewVintage(trigger.minVintage, event);
      case 'price_drop':
        return this.matchesPriceDrop(trigger.threshold, trigger.baselinePrice, event);
      case 'stock_available':
        return this.matchesStockAvailable(trigger.minQty, event);
      case 'critic_score_above':
        return this.matchesCriticScore(trigger.threshold, event);
    }
  }

  private matchesNewVintage(minVintage: number, event: WatchlistChangeEvent): boolean {
    if (event.type !== 'vintage_released' && event.type !== 'new_vintage') {
      return false;
    }

    const vintage = this.readNumber(event.data, ['vintage', 'newVintage']);
    return vintage !== null && vintage >= minVintage;
  }

  private matchesPriceDrop(
    threshold: number,
    baselinePrice: number,
    event: WatchlistChangeEvent,
  ): boolean {
    if (event.type !== 'price_updated' && event.type !== 'price_drop') {
      return false;
    }

    const percentageDrop = this.readNumber(event.data, ['percentageDrop', 'percent_drop']);
    if (percentageDrop !== null) {
      return percentageDrop >= threshold;
    }

    const oldPrice = this.readNumber(event.data, ['oldPrice', 'old_price', 'previousPrice']);
    const newPrice = this.readNumber(event.data, ['newPrice', 'new_price', 'price']);
    if (newPrice === null) {
      return false;
    }

    const referencePrice = oldPrice ?? baselinePrice;
    if (referencePrice <= 0 || newPrice >= referencePrice) {
      return false;
    }

    return ((referencePrice - newPrice) / referencePrice) * 100 >= threshold;
  }

  private matchesStockAvailable(minQty: number, event: WatchlistChangeEvent): boolean {
    if (event.type !== 'stock_changed' && event.type !== 'stock_available') {
      return false;
    }

    const quantity = this.readNumber(event.data, ['qty', 'quantity', 'newQty', 'stock']);
    return quantity !== null && quantity >= minQty;
  }

  private matchesCriticScore(threshold: number, event: WatchlistChangeEvent): boolean {
    if (event.type !== 'critic_score_updated' && event.type !== 'critic_score_above') {
      return false;
    }

    const score = this.readNumber(event.data, ['score', 'criticScore', 'newScore']);
    return score !== null && score >= threshold;
  }

  private readNumber(data: Record<string, unknown>, keys: readonly string[]): number | null {
    for (const key of keys) {
      const value = data[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
    }
    return null;
  }
}
