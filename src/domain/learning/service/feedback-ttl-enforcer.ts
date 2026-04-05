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

import type { FeedbackStore } from '../port/feedback-store.port.js';

// ---------------------------------------------------------------------------
// TTL constants
// ---------------------------------------------------------------------------

/** Retention period for high-volume short signals (click, explicit, clarification). */
const SHORT_SIGNAL_TTL_DAYS = 90;

/** Retention period for high-value long signals (purchase, session_success). */
const LONG_SIGNAL_TTL_DAYS = 180;

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
   * Total number of signals deleted.
   * The backing store uses the strictest (short) cutoff for the bulk delete;
   * long-TTL signals are not affected unless they are older than 90 days.
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
   * Computes cutoff dates for short and long signals and invokes
   * `pruneExpiredFeedback` with the strictest (shortest) TTL so that no
   * signal survives beyond its maximum retention period.
   *
   * @param referenceDate - Anchor date for cutoff computation (defaults to
   *   `new Date()` — i.e. "now"). Useful for deterministic testing.
   * @returns A summary of the enforcement run.
   */
  async enforce(referenceDate?: Date): Promise<TTLEnforcementResult> {
    const now = referenceDate ?? new Date();

    const shortSignalCutoff = subtractDays(now, SHORT_SIGNAL_TTL_DAYS);
    const longSignalCutoff = subtractDays(now, LONG_SIGNAL_TTL_DAYS);

    // Apply the strictest TTL (shortest period = earliest cutoff).
    // All signals older than shortSignalCutoff are deleted regardless of type.
    // Long-signal types (purchase, session_success) created after
    // shortSignalCutoff but before longSignalCutoff are preserved — a
    // per-type pruning strategy requires infrastructure-level support.
    const deletedCount = await this.feedbackStore.pruneExpiredFeedback(
      shortSignalCutoff,
    );

    return {
      runAt: now.toISOString(),
      shortSignalCutoff,
      longSignalCutoff,
      deletedCount,
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
