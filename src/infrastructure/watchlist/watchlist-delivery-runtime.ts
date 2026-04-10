import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import type { WatchlistChangeEvent } from '../../domain/watchlist/model/watchlist-entry.js';

const log = bootstrapLogger.child({ component: 'WatchlistDeliveryRuntime' });

/** Throttle window for failure-summary warnings. Without this, a fully-down
 *  webhook backend can trigger thousands of identical warn lines per second
 *  during the outage window. */
const FAILURE_LOG_THROTTLE_MS = 30_000;
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
  /** Throttled summary of failures since the last log emission. */
  private failureWindowCount = 0;
  private failureWindowBatchCount = 0;
  private lastFailureLogAt = 0;

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
    // Stop the subscriber FIRST so no more processEvent calls increment the
    // counters. Flushing before stop() races: in-flight events can add to the
    // window after the flush but before subscriber.stop() completes.
    await this.subscriber.stop();
    if (this.failureWindowCount > 0) {
      log.warn(
        {
          failedCount: this.failureWindowCount,
          batchCount: this.failureWindowBatchCount,
          context: 'shutdown_flush',
        },
        'watchlist delivery: residual failure summary at shutdown',
      );
      this.failureWindowCount = 0;
      this.failureWindowBatchCount = 0;
    }
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
              userId: entry.userId,
              attempt: log.attempt,
              statusCode: log.statusCode,
              errorMessage: log.errorMessage,
              deliveredAt: log.deliveredAt,
            });
          },
        });
      }),
    );
    // Aggregate failures and emit a throttled summary so a fully-down webhook
    // backend doesn't flood logs with thousands of identical lines per second.
    const failures = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length > 0) {
      this.failureWindowCount += failures.length;
      this.failureWindowBatchCount += 1;
      const nowMs = Date.now();
      if (nowMs - this.lastFailureLogAt >= FAILURE_LOG_THROTTLE_MS) {
        log.warn(
          {
            failedCount: this.failureWindowCount,
            batchCount: this.failureWindowBatchCount,
            windowMs: FAILURE_LOG_THROTTLE_MS,
            lastEntityId: entityId,
          },
          'watchlist delivery: throttled failure summary',
        );
        this.failureWindowCount = 0;
        this.failureWindowBatchCount = 0;
        this.lastFailureLogAt = nowMs;
      }
    }
  }

}
