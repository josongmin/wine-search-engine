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
interface WatchlistEventBase {
  readonly occurredAt: string; // ISO 8601 timestamp
}

export interface VintageReleasedEvent extends WatchlistEventBase {
  readonly type: 'vintage_released';
  readonly data: {
    readonly vintage: number;
    readonly canonicalLabel: string;
  };
}

export interface PriceUpdatedEvent extends WatchlistEventBase {
  readonly type: 'price_updated';
  readonly data: {
    readonly oldPrice: number;
    readonly newPrice: number;
    readonly percentageDrop: number;
  };
}

export interface StockChangedEvent extends WatchlistEventBase {
  readonly type: 'stock_changed';
  readonly data: {
    readonly stock: number;
    readonly available: boolean;
  };
}

export interface CriticScoreUpdatedEvent extends WatchlistEventBase {
  readonly type: 'critic_score_updated';
  readonly data: {
    readonly score: number;
    readonly previousScore: number | null;
  };
}

export type WatchlistChangeEvent =
  | VintageReleasedEvent
  | PriceUpdatedEvent
  | StockChangedEvent
  | CriticScoreUpdatedEvent;

export function parseWatchlistChangeEvent(input: unknown): WatchlistChangeEvent | null {
  if (!isRecord(input) || !isIsoTimestamp(input.occurredAt)) {
    return null;
  }

  switch (input.type) {
    case 'vintage_released':
      return isVintageReleasedEventData(input.data)
        ? {
            type: input.type,
            data: input.data,
            occurredAt: input.occurredAt,
          }
        : null;
    case 'price_updated':
      return isPriceUpdatedEventData(input.data)
        ? {
            type: input.type,
            data: input.data,
            occurredAt: input.occurredAt,
          }
        : null;
    case 'stock_changed':
      return isStockChangedEventData(input.data)
        ? {
            type: input.type,
            data: input.data,
            occurredAt: input.occurredAt,
          }
        : null;
    case 'critic_score_updated':
      return isCriticScoreUpdatedEventData(input.data)
        ? {
            type: input.type,
            data: input.data,
            occurredAt: input.occurredAt,
          }
        : null;
    default:
      return null;
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isVintageReleasedEventData(
  value: unknown,
): value is VintageReleasedEvent['data'] {
  return isRecord(value)
    && isFiniteNumber(value.vintage)
    && typeof value.canonicalLabel === 'string';
}

function isPriceUpdatedEventData(
  value: unknown,
): value is PriceUpdatedEvent['data'] {
  return isRecord(value)
    && isFiniteNumber(value.oldPrice)
    && isFiniteNumber(value.newPrice)
    && isFiniteNumber(value.percentageDrop);
}

function isStockChangedEventData(
  value: unknown,
): value is StockChangedEvent['data'] {
  return isRecord(value)
    && isFiniteNumber(value.stock)
    && typeof value.available === 'boolean';
}

function isCriticScoreUpdatedEventData(
  value: unknown,
): value is CriticScoreUpdatedEvent['data'] {
  return isRecord(value)
    && isFiniteNumber(value.score)
    && (value.previousScore === null || isFiniteNumber(value.previousScore));
}
