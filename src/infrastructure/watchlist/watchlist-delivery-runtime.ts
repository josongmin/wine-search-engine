import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import type { WatchlistChangeEvent } from '../../domain/watchlist/model/watchlist-entry.js';

const log = bootstrapLogger.child({ component: 'WatchlistDeliveryRuntime' });
import type {
  WatchlistServicePort,
} from '../../application/watchlist/watchlist.service.js';
import type { WatchlistSubscriberPort } from './redis-watchlist-subscriber.js';
import type { WatchlistDeliveryPort } from './webhook-delivery.js';
import { shouldDeliverWatchlistEvent } from '../../domain/watchlist/service/watchlist-policy.js';

export interface WatchlistRuntimePort {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
}

interface WatchlistDeliveryRuntimeDeps {
  readonly watchlistService: WatchlistServicePort;
  readonly subscriber: WatchlistSubscriberPort;
  readonly webhookDelivery: WatchlistDeliveryPort;
  readonly now?: () => Date;
}

export class WatchlistDeliveryRuntime implements WatchlistRuntimePort {
  private readonly watchlistService: WatchlistServicePort;
  private readonly subscriber: WatchlistSubscriberPort;
  private readonly webhookDelivery: WatchlistDeliveryPort;
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
      shouldDeliverWatchlistEvent(entry, event, this.now()),
    );

    // Use allSettled (NOT Promise.all) so a single delivery failure doesn't
    // reject the whole batch — Promise.all would propagate the first rejection
    // up to the subscriber, which may then mark the source message as failed
    // and REDELIVER the entire batch, double-delivering successful entries.
    const settled = await Promise.allSettled(
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
    // Log any individual failures so ops can detect a degraded delivery path.
    const failures = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length > 0) {
      log.warn(
        { failedCount: failures.length, totalCount: activeEntries.length, entityId },
        'watchlist delivery: some entries failed (others succeeded — no redelivery)',
      );
    }
  }

}
