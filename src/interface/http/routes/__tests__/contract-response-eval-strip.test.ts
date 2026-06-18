import { describe, it, expect } from 'vitest';
import { stripEvalOnlyFields } from '../contract-response.js';
import { deepKeysToSnake } from '../../middleware/snake-case-hook.js';

/**
 * Regression: `engine_decision.top1_raw_score` is an EVAL-ONLY signal captured
 * on the in-process EngineDecision (commit 5cf36815) for the calibration
 * trainer — it is NOT part of the public response contract. The generic
 * camel→snake transform would otherwise leak it into the strict-validated wire
 * and 500 every ranked-route search that produced a top candidate. The wire
 * boundary must strip it.
 */
describe('stripEvalOnlyFields', () => {
  it('removes engine_decision.top1_raw_score from the snake-cased wire payload', () => {
    const wire = deepKeysToSnake({
      engineDecision: { decisionStatus: 'resolved', top1RawScore: 0.91, decisionConfidence: 0.8 },
      results: [],
    }) as Record<string, unknown>;
    expect((wire.engine_decision as Record<string, unknown>).top1_raw_score).toBe(0.91);

    const stripped = stripEvalOnlyFields(wire) as Record<string, unknown>;
    const ed = stripped.engine_decision as Record<string, unknown>;
    expect(ed).not.toHaveProperty('top1_raw_score');
    // sibling fields and other top-level keys survive
    expect(ed.decision_status).toBe('resolved');
    expect(ed.decision_confidence).toBe(0.8);
    expect(stripped.results).toEqual([]);
  });

  it('is a no-op when top1_raw_score is absent', () => {
    const payload = { engine_decision: { decision_status: 'resolved' }, results: [] };
    expect(stripEvalOnlyFields(payload)).toEqual(payload);
  });

  it('is a no-op when there is no engine_decision', () => {
    const payload = { results: [{ id: 'w1' }] };
    expect(stripEvalOnlyFields(payload)).toEqual(payload);
  });

  it('is safe on null / non-object / string payloads', () => {
    expect(stripEvalOnlyFields(null)).toBeNull();
    expect(stripEvalOnlyFields(42)).toBe(42);
    expect(stripEvalOnlyFields('human-rendered')).toBe('human-rendered');
  });

  it('does not mutate the input payload', () => {
    const ed = { decision_status: 'resolved', top1_raw_score: 0.5 };
    const payload = { engine_decision: ed };
    stripEvalOnlyFields(payload);
    expect(ed.top1_raw_score).toBe(0.5); // original untouched
  });
});
