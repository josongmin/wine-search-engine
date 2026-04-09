import { describe, it, expect } from 'vitest';
import { computeDebiasedRelevance, PositionBasedExaminationModel } from '../service/position-debias.js';
import type { FeedbackEvent } from '../model/feedback-event.js';

const model = new PositionBasedExaminationModel();

function evt(partial: Partial<FeedbackEvent> & Pick<FeedbackEvent, 'eventId' | 'eventType' | 'entityId' | 'position'>): FeedbackEvent {
  return {
    timestamp: 0,
    requestId: 'req',
    query: 'q',
    ...partial,
  };
}

describe('computeDebiasedRelevance', () => {
  it('empty events → empty result', () => {
    expect(computeDebiasedRelevance([], model)).toEqual([]);
  });

  it('single click at position 0 → score = 1.0', () => {
    const r = computeDebiasedRelevance([
      evt({ eventId: 'i1', eventType: 'impression', entityId: 'w1', position: 0 }),
      evt({ eventId: 'c1', eventType: 'click', entityId: 'w1', position: 0 }),
    ], model);
    expect(r).toHaveLength(1);
    expect(r[0]!.debiasedScore).toBeCloseTo(1.0, 4);
  });

  it('click at position 5 → debiased score > position 0 click', () => {
    const r = computeDebiasedRelevance([
      evt({ eventId: 'i1', eventType: 'impression', entityId: 'w1', position: 5 }),
      evt({ eventId: 'c1', eventType: 'click', entityId: 'w1', position: 5 }),
    ], model);
    expect(r[0]!.debiasedScore).toBeGreaterThan(1.0);
  });

  it('multiple impressions averaged correctly', () => {
    const r = computeDebiasedRelevance([
      evt({ eventId: 'i1', eventType: 'impression', entityId: 'w1', position: 0 }),
      evt({ eventId: 'i2', eventType: 'impression', entityId: 'w1', position: 0 }),
      evt({ eventId: 'c1', eventType: 'click', entityId: 'w1', position: 0 }),
    ], model);
    expect(r[0]!.debiasedScore).toBeCloseTo(0.5, 4);
    expect(r[0]!.impressions).toBe(2);
  });

  it('idempotent on eventId — duplicates dropped', () => {
    const r = computeDebiasedRelevance([
      evt({ eventId: 'i1', eventType: 'impression', entityId: 'w1', position: 0 }),
      evt({ eventId: 'i1', eventType: 'impression', entityId: 'w1', position: 0 }),
    ], model);
    expect(r[0]!.impressions).toBe(1);
  });

  it('PositionBasedExaminationModel returns 1.0 at pos 0', () => {
    expect(model.examineProbability(0)).toBe(1.0);
    expect(model.examineProbability(1)).toBe(0.6);
    expect(model.examineProbability(100)).toBeGreaterThan(0);
  });
});

describe('PositionBasedExaminationModel (named-constant edge cases)', () => {
  // Behavioral assertions — the source defines POSITION_PROPENSITY_POS_0..4 as
  // module-scope constants. They are not exported (see rule 15/25: SSoT in
  // source), so these tests pin the documented behavior rather than re-import
  // the literal values.
  it('pos 0 → 1.0 (POSITION_PROPENSITY_POS_0)', () => {
    expect(model.examineProbability(0)).toBe(1.0);
  });

  it('pos 4 → 0.2 (POSITION_PROPENSITY_POS_4)', () => {
    expect(model.examineProbability(4)).toBe(0.2);
  });

  it('monotonically non-increasing across positions 0..10', () => {
    const probs = Array.from({ length: 11 }, (_, i) => model.examineProbability(i));
    for (let i = 1; i < probs.length; i++) {
      expect(probs[i]!).toBeLessThanOrEqual(probs[i - 1]!);
    }
    // Strict decrease between pos 0 and pos 4 (table entries).
    expect(probs[4]!).toBeLessThan(probs[0]!);
  });

  it('pos 100 is strictly positive (no zero-divide downstream in IPS weighting)', () => {
    const p = model.examineProbability(100);
    expect(p).toBeGreaterThan(0);
    // MIN_PROPENSITY = 0.01; very deep tail collapses to the floor.
    expect(p).toBeGreaterThanOrEqual(0.01);
  });

  it('NaN position → MIN_PROPENSITY floor', () => {
    expect(model.examineProbability(Number.NaN)).toBe(0.01);
  });

  it('Infinity position → MIN_PROPENSITY floor', () => {
    expect(model.examineProbability(Number.POSITIVE_INFINITY)).toBe(0.01);
  });

  it('negative position → MIN_PROPENSITY floor', () => {
    expect(model.examineProbability(-1)).toBe(0.01);
    expect(model.examineProbability(-100)).toBe(0.01);
  });
});
