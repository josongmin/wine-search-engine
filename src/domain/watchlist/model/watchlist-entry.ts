/**
 * Epic 17.1: Watchlist Alert System — Domain Models
 *
 * Defines watchlist entry structure, trigger conditions, and change events
 * for asynchronous notification delivery via Redis pub/sub and webhooks.
 */

/**
 * Discriminated union of watchlist trigger conditions.
 * Each variant represents a specific condition that warrants notification.
 */
export type WatchlistTrigger =
  | {
      readonly type: 'new_vintage';
      readonly minVintage: number;
    }
  | {
      readonly type: 'price_drop';
      readonly threshold: number; // percentage drop (0-100)
      readonly baselinePrice: number;
    }
  | {
      readonly type: 'stock_available';
      readonly minQty: number;
    }
  | {
      readonly type: 'critic_score_above';
      readonly threshold: number; // score threshold (0-100)
    };

/**
 * A watchlist entry — user's subscription to entity change notifications.
 * All fields are immutable; updates produce a new entry.
 */
export interface WatchlistEntry {
  readonly id: string; // UUID
  readonly userId: string;
  readonly entityId: string;
  readonly triggerConditions: readonly WatchlistTrigger[];
  readonly callbackUrl: string; // HTTPS webhook endpoint
  readonly createdAt: Date;
  readonly expiresAt: Date | null; // null = no expiration
}

/**
 * An immutable change event describing what occurred on an entity.
 * Published to Redis channel for subscriber handlers.
 */
export interface WatchlistChangeEvent {
  readonly type: string; // e.g., "vintage_released", "price_updated", "stock_changed"
  readonly data: Record<string, unknown>; // Structured event payload
  readonly occurredAt: string; // ISO 8601 timestamp
}

/**
 * Immutable audit log for webhook delivery attempts.
 */
export interface WatchlistDeliveryLogEntry {
  readonly id: string; // UUID
  readonly watchlistId: string;
  readonly attempt: number;
  readonly statusCode: number | null;
  readonly errorMessage: string | null;
  readonly deliveredAt: Date;
}
