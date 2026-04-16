/**
 * E6-U5: Operational Seam Lock
 *
 * WatchlistPolicy is part of the operational seam (watchlist + runtime-handles +
 * side-effect plane). This seam is REUSE-ONLY:
 *   - Do NOT redesign watchlist runtime, side-effect plane, or runtime-handle lifecycle
 *   - Do NOT use this seam as a reason to open a parallel runtime or new coordinator
 *   - Policy logic changes are permitted; infrastructure redesign is NOT
 *
 * If a new operational behavior is needed, extend the existing seam rather
 * than creating a new service surface beside it.
 */
import type {
  CriticScoreUpdatedEvent,
  PriceUpdatedEvent,
  StockChangedEvent,
  VintageReleasedEvent,
  WatchlistChangeEvent,
  WatchlistEntry,
  WatchlistTrigger,
} from '../model/watchlist-entry.js';

type WatchlistTriggerResponse =
  | {
      readonly type: 'new_vintage';
      readonly min_vintage: number;
    }
  | {
      readonly type: 'price_drop';
      readonly threshold: number;
      readonly baseline_price: number;
    }
  | {
      readonly type: 'stock_available';
      readonly min_qty: number;
    }
  | {
      readonly type: 'critic_score_above';
      readonly threshold: number;
    };

export function toWatchlistTriggerResponse(
  trigger: WatchlistTrigger,
): WatchlistTriggerResponse {
  switch (trigger.type) {
    case 'new_vintage':
      return {
        type: trigger.type,
        min_vintage: trigger.minVintage,
      };
    case 'price_drop':
      return {
        type: trigger.type,
        threshold: trigger.threshold,
        baseline_price: trigger.baselinePrice,
      };
    case 'stock_available':
      return {
        type: trigger.type,
        min_qty: trigger.minQty,
      };
    case 'critic_score_above':
      return {
        type: trigger.type,
        threshold: trigger.threshold,
      };
  }
}

export function isWatchlistEntryActive(
  entry: WatchlistEntry,
  now: Date,
): boolean {
  if (entry.expiresAt === null) return true;
  const expiresAtMs = entry.expiresAt.getTime();
  // Rule 28: new Date('invalid').getTime() → NaN; NaN > number is always false,
  // which would incorrectly report an invalid-date entry as active.
  // Guard: treat invalid dates as expired (safe — denies notification rather than leaking).
  if (!Number.isFinite(expiresAtMs)) return false;
  const nowMs = now.getTime();
  return expiresAtMs > nowMs;
}

export function matchesWatchlistTrigger(
  trigger: WatchlistTrigger,
  event: WatchlistChangeEvent,
): boolean {
  switch (trigger.type) {
    case 'new_vintage':
      return matchesNewVintage(trigger.minVintage, event);
    case 'price_drop':
      return matchesPriceDrop(trigger.threshold, trigger.baselinePrice, event);
    case 'stock_available':
      return matchesStockAvailable(trigger.minQty, event);
    case 'critic_score_above':
      return matchesCriticScore(trigger.threshold, event);
  }
}

export function shouldDeliverWatchlistEvent(
  entry: WatchlistEntry,
  event: WatchlistChangeEvent,
  now: Date,
): boolean {
  return isWatchlistEntryActive(entry, now)
    && entry.triggerConditions.some((trigger) => matchesWatchlistTrigger(trigger, event));
}

function matchesNewVintage(minVintage: number, event: WatchlistChangeEvent): boolean {
  if (event.type !== 'vintage_released') {
    return false;
  }

  const typedEvent: VintageReleasedEvent = event;
  return typedEvent.data.vintage >= minVintage;
}

function matchesPriceDrop(
  threshold: number,
  baselinePrice: number,
  event: WatchlistChangeEvent,
): boolean {
  if (event.type !== 'price_updated') {
    return false;
  }

  const typedEvent: PriceUpdatedEvent = event;
  if (baselinePrice <= 0 || typedEvent.data.newPrice >= baselinePrice) {
    return false;
  }

  return ((baselinePrice - typedEvent.data.newPrice) / baselinePrice) * 100 >= threshold;
}

function matchesStockAvailable(minQty: number, event: WatchlistChangeEvent): boolean {
  if (event.type !== 'stock_changed') {
    return false;
  }

  const typedEvent: StockChangedEvent = event;
  return typedEvent.data.stock >= minQty;
}

function matchesCriticScore(threshold: number, event: WatchlistChangeEvent): boolean {
  if (event.type !== 'critic_score_updated') {
    return false;
  }

  const typedEvent: CriticScoreUpdatedEvent = event;
  return typedEvent.data.score >= threshold;
}
