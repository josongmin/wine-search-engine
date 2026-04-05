/**
 * Feedback data retention (TTL) enforcer, per RFC-010 §8.
 *
 * Implements the data-retention policies that govern how long each class of
 * feedback signal is stored before deletion.  Retention periods are calibrated
 * to balance learning-loop recency with privacy obligations (GDPR / data
 * minimisation).
 *
 * Policy:
 *   - `click`                  — 90 days   (short-signal, high volume)
 *   - `explicit_feedback`      — 90 days   (same as click)
 *   - `clarification_resolution` — 90 days
 *   - `session_success`        — 180 days  (session aggregates, lower volume)
 *   - `purchase`               — 180 days  (high-value signal; retained longer)
 *
 * The enforcer computes a *single* oldest cutoff date (the strictest TTL
 * applicable to any signal in the store) and delegates bulk deletion to the
 * `FeedbackStore.pruneExpiredFeedback` port.  Infrastructure adapters that
 * support per-type TTL can implement more granular pruning at the storage
 * layer; this service ensures at minimum the strictest policy is applied.
 */

import type { FeedbackType } from '../model/feedback-signal.js';
import type { FeedbackStore } from '../port/feedback-store.port.js';

// ---------------------------------------------------------------------------
// TTL constants
// ---------------------------------------------------------------------------

/** Retention period for high-volume short signals (click, explicit, clarification). */
const SHORT_SIGNAL_TTL_DAYS = 90;

/** Retention period for high-value long signals (purchase, session_success). */
const LONG_SIGNAL_TTL_DAYS = 180;

/** Signal types subject to the 90-day retention policy. */
const SHORT_SIGNAL_TYPES: readonly FeedbackType[] = [
  'click',
  'explicit_feedback',
  'clarification_resolution',
];

/** Signal types subject to the 180-day retention policy. */
const LONG_SIGNAL_TYPES: readonly FeedbackType[] = ['purchase', 'session_success'];

/**
 * Result of a TTL enforcement run.
 */
export interface TTLEnforcementResult {
  /** ISO-8601 timestamp at which the run started. */
  readonly runAt: string;

  /** The cutoff date applied for short signals (90-day TTL). */
  readonly shortSignalCutoff: Date;

  /** The cutoff date applied for long signals (180-day TTL). */
  readonly longSignalCutoff: Date;

  /**
   * Total number of signals deleted across both short-signal and long-signal
   * prune passes.
   */
  readonly deletedCount: number;
}

/**
 * Enforces RFC-010 §8 data-retention policies by pruning expired feedback
 * signals from the store.
 *
 * This is a domain service — it contains only policy logic and delegates
 * all I/O to the {@link FeedbackStore} port.
 */
export class FeedbackTTLEnforcer {
  constructor(private readonly feedbackStore: FeedbackStore) {}

  /**
   * Runs one TTL enforcement cycle.
   *
   * Issues two targeted prune passes against the store — one for short signals
   * (90-day TTL) and one for long signals (180-day TTL) — so that each signal
   * class is deleted precisely at its own retention boundary.
   *
   * @param referenceDate - Anchor date for cutoff computation (defaults to
   *   `new Date()` — i.e. "now"). Useful for deterministic testing.
   * @returns A summary of the enforcement run.
   */
  async enforce(referenceDate?: Date): Promise<TTLEnforcementResult> {
    const now = referenceDate ?? new Date();

    const shortSignalCutoff = subtractDays(now, SHORT_SIGNAL_TTL_DAYS);
    const longSignalCutoff = subtractDays(now, LONG_SIGNAL_TTL_DAYS);

    // Prune short signals (click, explicit_feedback, clarification_resolution)
    // older than 90 days.
    const shortDeleted = await this.feedbackStore.pruneExpiredFeedback(
      shortSignalCutoff,
      SHORT_SIGNAL_TYPES,
    );

    // Prune long signals (purchase, session_success) older than 180 days.
    const longDeleted = await this.feedbackStore.pruneExpiredFeedback(
      longSignalCutoff,
      LONG_SIGNAL_TYPES,
    );

    return {
      runAt: now.toISOString(),
      shortSignalCutoff,
      longSignalCutoff,
      deletedCount: shortDeleted + longDeleted,
    };
  }

  /**
   * Returns the short-signal cutoff date (90 days before `referenceDate`).
   * Exposed for testing and monitoring integrations.
   */
  getShortSignalCutoff(referenceDate?: Date): Date {
    return subtractDays(referenceDate ?? new Date(), SHORT_SIGNAL_TTL_DAYS);
  }

  /**
   * Returns the long-signal cutoff date (180 days before `referenceDate`).
   * Exposed for testing and monitoring integrations.
   */
  getLongSignalCutoff(referenceDate?: Date): Date {
    return subtractDays(referenceDate ?? new Date(), LONG_SIGNAL_TTL_DAYS);
  }
}

/**
 * Returns a new Date that is `days` calendar days before `base`.
 */
function subtractDays(base: Date, days: number): Date {
  const result = new Date(base.getTime());
  result.setUTCDate(result.getUTCDate() - days);
  return result;
}
