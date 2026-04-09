/**
 * Implicit feedback event schema (Epic-18 closed-loop core).
 *
 * Each event captures one user interaction with a search result. Events
 * are appended to the feedback log; downstream services compute IPS-weighted
 * relevance, debiased click-through rate, and retraining signals.
 */

export type FeedbackEventType =
  | 'impression'
  | 'click'
  | 'dwell'
  | 'add_to_watchlist'
  | 'dismiss'
  | 'refine_query';

export interface FeedbackEvent {
  readonly eventId: string;
  readonly eventType: FeedbackEventType;
  readonly timestamp: number;
  readonly requestId: string;
  readonly query: string;
  readonly position: number;
  readonly entityId: string;
  readonly sessionId?: string;
  readonly userId?: string;
  readonly dwellMs?: number;
}

export interface FeedbackEventBatch {
  readonly events: readonly FeedbackEvent[];
  readonly batchedAt: number;
}
