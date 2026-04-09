import type { FeedbackEvent } from '../model/feedback-event.js';

export interface FeedbackCollectorPort {
  /** Record a single feedback event. Idempotent on eventId. */
  record(event: FeedbackEvent): Promise<void>;

  /** Batch record events for efficiency. */
  recordBatch(events: readonly FeedbackEvent[]): Promise<void>;
}
