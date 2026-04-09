import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryFeedbackCollector } from '../in-memory-feedback-collector.js';
import type { FeedbackEvent } from '../../../domain/feedback/model/feedback-event.js';

function evt(id: string): FeedbackEvent {
  return {
    eventId: id,
    eventType: 'impression',
    timestamp: 0,
    requestId: 'r',
    query: 'q',
    position: 0,
    entityId: 'w',
  };
}

describe('InMemoryFeedbackCollector', () => {
  let collector: InMemoryFeedbackCollector;

  beforeEach(() => {
    collector = new InMemoryFeedbackCollector();
  });

  it('records a single event', async () => {
    await collector.record(evt('e1'));
    expect(collector.getAll()).toHaveLength(1);
  });

  it('records a batch', async () => {
    await collector.recordBatch([evt('e1'), evt('e2'), evt('e3')]);
    expect(collector.getAll()).toHaveLength(3);
  });

  it('idempotent on eventId', async () => {
    await collector.record(evt('e1'));
    await collector.record(evt('e1'));
    expect(collector.getAll()).toHaveLength(1);
  });

  it('clear() empties the buffer and seen set', async () => {
    await collector.record(evt('e1'));
    collector.clear();
    expect(collector.getAll()).toHaveLength(0);
    // Re-recording the same id after clear should work.
    await collector.record(evt('e1'));
    expect(collector.getAll()).toHaveLength(1);
  });
});
