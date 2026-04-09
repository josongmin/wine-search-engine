import { describe, it, expect } from 'vitest';
import { extractTrainingData } from '../service/training-data-extractor.js';
import type { FeedbackEvent } from '../model/feedback-event.js';
import type { DebiasedRelevance } from '../service/position-debias.js';

function evt(
  partial: Partial<FeedbackEvent> &
    Pick<FeedbackEvent, 'eventId' | 'eventType' | 'entityId' | 'position' | 'query'>,
): FeedbackEvent {
  return {
    timestamp: 0,
    requestId: 'req',
    ...partial,
  };
}

function rel(entityId: string, debiasedScore: number): DebiasedRelevance {
  return { entityId, debiasedScore, clicks: 0, impressions: 0, avgPosition: 0 };
}

describe('extractTrainingData', () => {
  it('empty input → empty dataset', () => {
    const ds = extractTrainingData([], [], { now: () => 42 });
    expect(ds.examples).toEqual([]);
    expect(ds.minImpressions).toBe(5);
    expect(ds.extractedAt).toBe(42);
  });

  it('single (query, entity) with enough impressions → 1 example', () => {
    const events: FeedbackEvent[] = [];
    for (let i = 0; i < 5; i++) {
      events.push(evt({ eventId: `i${i}`, eventType: 'impression', query: 'pinot noir', entityId: 'w1', position: 0 }));
    }
    events.push(evt({ eventId: 'c1', eventType: 'click', query: 'pinot noir', entityId: 'w1', position: 0 }));

    const ds = extractTrainingData(events, [rel('w1', 0.8)], { now: () => 0 });
    expect(ds.examples).toHaveLength(1);
    expect(ds.examples[0]!.query).toBe('pinot noir');
    expect(ds.examples[0]!.entityId).toBe('w1');
    expect(ds.examples[0]!.impressions).toBe(5);
    expect(ds.examples[0]!.clicks).toBe(1);
  });

  it('filter applied correctly (insufficient impressions excluded)', () => {
    const events: FeedbackEvent[] = [
      evt({ eventId: 'i1', eventType: 'impression', query: 'q1', entityId: 'w1', position: 0 }),
      evt({ eventId: 'i2', eventType: 'impression', query: 'q1', entityId: 'w1', position: 0 }),
    ];
    const ds = extractTrainingData(events, [rel('w1', 0.5)], { minImpressions: 5, now: () => 0 });
    expect(ds.examples).toHaveLength(0);
  });

  it('relevanceLabel derived from debiased score (clamped to [0,1])', () => {
    const events: FeedbackEvent[] = [];
    for (let i = 0; i < 5; i++) {
      events.push(evt({ eventId: `i${i}`, eventType: 'impression', query: 'q', entityId: 'w1', position: 1 }));
    }
    const ds = extractTrainingData(
      events,
      [rel('w1', 1.8)], // out-of-range, should clamp
      { now: () => 0 },
    );
    expect(ds.examples).toHaveLength(1);
    expect(ds.examples[0]!.relevanceLabel).toBe(1);
  });

  it('multiple queries grouped correctly', () => {
    const events: FeedbackEvent[] = [];
    for (let i = 0; i < 5; i++) {
      events.push(evt({ eventId: `a${i}`, eventType: 'impression', query: 'q1', entityId: 'w1', position: 0 }));
      events.push(evt({ eventId: `b${i}`, eventType: 'impression', query: 'q2', entityId: 'w1', position: 0 }));
    }
    events.push(evt({ eventId: 'ca', eventType: 'click', query: 'q1', entityId: 'w1', position: 0 }));

    const ds = extractTrainingData(events, [rel('w1', 0.4)], { now: () => 0 });
    expect(ds.examples).toHaveLength(2);
    const byQuery = new Map(ds.examples.map((e) => [e.query, e] as const));
    expect(byQuery.get('q1')!.clicks).toBe(1);
    expect(byQuery.get('q2')!.clicks).toBe(0);
    expect(byQuery.get('q1')!.relevanceLabel).toBeCloseTo(0.4, 6);
    expect(byQuery.get('q2')!.relevanceLabel).toBeCloseTo(0.4, 6);
  });
});
