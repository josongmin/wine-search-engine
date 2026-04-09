import type { FeedbackEvent } from '../../domain/feedback/model/feedback-event.js';
import type { FeedbackCollectorPort } from '../../domain/feedback/port/feedback-collector.port.js';

/**
 * In-memory feedback collector for development and tests.
 *
 * Production deployments should swap this for a write-through to a durable
 * event sink (Kafka, Redshift, S3 events, etc.). The in-memory variant
 * preserves the same idempotency contract: a duplicate eventId is dropped.
 */
export class InMemoryFeedbackCollector implements FeedbackCollectorPort {
  private readonly events: FeedbackEvent[] = [];
  private readonly seenIds = new Set<string>();

  async record(event: FeedbackEvent): Promise<void> {
    if (this.seenIds.has(event.eventId)) return;
    this.seenIds.add(event.eventId);
    this.events.push(event);
  }

  async recordBatch(events: readonly FeedbackEvent[]): Promise<void> {
    for (const e of events) {
      if (this.seenIds.has(e.eventId)) continue;
      this.seenIds.add(e.eventId);
      this.events.push(e);
    }
  }

  /** Test-only: read all events. */
  getAll(): readonly FeedbackEvent[] {
    return this.events;
  }

  /** Test-only: clear all events. */
  clear(): void {
    this.events.length = 0;
    this.seenIds.clear();
  }
}
