import type { EntityId, QueryClass } from '../../shared/types/index.js';
import type { FeedbackSignal } from '../model/feedback-signal.js';

/**
 * Filter criteria for retrieving feedback signals.
 */
export interface FeedbackFilter {
  /** Only return signals recorded on or after this timestamp. */
  readonly since?: Date;

  /** Filter by query class. */
  readonly queryClass?: QueryClass;

  /** Filter by entity ID. */
  readonly entityId?: EntityId;
}

/**
 * Aggregated feedback statistics for a single entity.
 */
export interface AggregatedFeedbackStats {
  /** Total click count. */
  readonly clicks: number;

  /** Total purchase count. */
  readonly purchases: number;

  /** Total session-success count. */
  readonly sessionSuccesses: number;
}

/**
 * Port for persisting and retrieving user feedback signals, per RFC-010 §2.
 *
 * Infrastructure adapters may use an event log, time-series database,
 * or append-only table. Feedback data is the raw input to the learning loop.
 */
export interface FeedbackStore {
  /**
   * Persists a single feedback signal.
   *
   * @param signal - The feedback signal to save.
   */
  saveFeedback(signal: FeedbackSignal): Promise<void>;

  /**
   * Retrieves feedback signals matching the given filter.
   *
   * @param filter - Optional filter to narrow results.
   * @returns Matching feedback signals, ordered by timestamp ascending.
   */
  getFeedback(filter?: FeedbackFilter): Promise<readonly FeedbackSignal[]>;

  /**
   * Returns aggregated feedback statistics for a specific entity.
   *
   * @param entityId - The entity to aggregate stats for.
   * @returns Aggregated click, purchase, and session-success counts.
   */
  getAggregatedStats(entityId: EntityId): Promise<AggregatedFeedbackStats>;
}
