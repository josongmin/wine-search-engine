import type { EntityId, QueryClass, DecisionSnapshot } from '../../shared/types/index.js';

/**
 * Types of user feedback signals that the learning loop collects.
 * Single source of truth: derive both the runtime tuple and the union type
 * from FEEDBACK_TYPES so tests can iterate the values without hand-copying.
 */
export const FEEDBACK_TYPES = [
  'click',
  'purchase',
  'explicit_feedback',
  'clarification_resolution',
  'session_success',
] as const;

export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

/**
 * A single feedback signal from user interaction, per RFC-010 §2.
 *
 * Feedback signals are the raw input to the learning loop. They capture
 * user behavior (clicks, purchases, session outcomes) that implicitly
 * or explicitly indicates whether the engine's resolution was helpful.
 */
export interface FeedbackSignal {
  /** Unique identifier for this feedback event. */
  readonly signalId: string;

  /** The type of feedback captured. */
  readonly type: FeedbackType;

  /** The query that was searched. */
  readonly query: string;

  /** The classified query type at the time of the search. */
  readonly queryClass: QueryClass;

  /** The entity that the feedback relates to. */
  readonly entityId: EntityId;

  /** Whether this is a positive signal (e.g. click, purchase) or negative (e.g. bounce, dislike). */
  readonly isPositive: boolean;

  /** When this feedback was recorded. */
  readonly timestamp: Date;

  /** The session in which the feedback occurred, for session-level aggregation. */
  readonly sessionId: string;

  /** Snapshot of system state when the original decision was made. */
  readonly decisionSnapshot: DecisionSnapshot;
}
