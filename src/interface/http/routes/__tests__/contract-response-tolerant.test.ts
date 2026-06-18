import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { tolerantParse } from '../contract-response.js';

/**
 * Move 3: the wire boundary must NOT 500 a user's search over a best-effort
 * DIAGNOSTIC field (telemetry / eval). `tolerantParse` validates strictly, but
 * when the ONLY violations are confined to a known allowlist of droppable
 * diagnostic paths it drops them and re-validates — turning a 500 into a 200
 * with degraded telemetry. Violations on user-facing fields still fail hard.
 *
 * The allowlist (`stage_timings`, `engine_decision.top1_raw_score`) mirrors the
 * real search-response diagnostic fields that previously 500'd the route.
 */
const SCHEMA = z
  .object({
    results: z.array(z.string()),
    engine_decision: z
      .object({ decision_status: z.string() })
      .strict(),
    stage_timings: z
      .record(z.number())
      .refine((r) => Object.keys(r).length <= 2, { message: 'too many stage_timings' })
      .optional(),
  })
  .strict();

describe('tolerantParse — diagnostic-tolerant wire boundary', () => {
  it('passes a clean payload through unchanged', () => {
    const payload = { results: ['a'], engine_decision: { decision_status: 'resolved' } };
    const out = tolerantParse(SCHEMA, payload);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data).toEqual(payload);
      expect(out.dropped).toEqual([]);
    }
  });

  it('recovers when a diagnostic refine (stage_timings overflow) is the only violation', () => {
    const payload = {
      results: ['a'],
      engine_decision: { decision_status: 'resolved' },
      stage_timings: { s1: 1, s2: 2, s3: 3 }, // 3 keys > cap of 2 → refine fails
    };
    const out = tolerantParse(SCHEMA, payload);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data).not.toHaveProperty('stage_timings');
      expect(out.data.results).toEqual(['a']);
      expect(out.dropped).toContain('stage_timings');
    }
  });

  it('recovers when an eval-only unknown key leaks into engine_decision', () => {
    const payload = {
      results: ['a'],
      engine_decision: { decision_status: 'resolved', top1_raw_score: 0.91 },
    };
    const out = tolerantParse(SCHEMA, payload);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect((out.data.engine_decision as Record<string, unknown>)).not.toHaveProperty('top1_raw_score');
      expect(out.dropped).toContain('engine_decision.top1_raw_score');
    }
  });

  it('FAILS HARD when a user-facing field is invalid (results missing)', () => {
    const payload = { engine_decision: { decision_status: 'resolved' } };
    const out = tolerantParse(SCHEMA, payload);
    expect(out.ok).toBe(false);
  });

  it('FAILS HARD when a non-droppable unknown key leaks (real contract bug)', () => {
    const payload = {
      results: ['a'],
      engine_decision: { decision_status: 'resolved' },
      surprise_field: true, // unknown key at root — NOT a droppable diagnostic
    };
    const out = tolerantParse(SCHEMA, payload);
    expect(out.ok).toBe(false);
  });

  it('does not mutate the input payload during recovery', () => {
    const payload = {
      results: ['a'],
      engine_decision: { decision_status: 'resolved', top1_raw_score: 0.5 },
    };
    tolerantParse(SCHEMA, payload);
    expect((payload.engine_decision as Record<string, unknown>).top1_raw_score).toBe(0.5);
  });
});
