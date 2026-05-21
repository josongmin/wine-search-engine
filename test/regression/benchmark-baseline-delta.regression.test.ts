/**
 * S1.2 regression — frozen-baseline per-scenario delta table.
 *
 * Invariants under test:
 *  - `computeScenarioDeltas` correctly classifies regressed / improved scenarios
 *    against a configurable per-scenario threshold.
 *  - Deltas are computed as current − baseline (positive = improvement).
 *  - Rows are sorted by delta ascending (biggest regressions first); null-delta
 *    rows (new/dropped/skipped) sort last, tie-broken by id (deterministic).
 *  - Skipped scenarios contribute a null score on whichever side they are skipped.
 */
import { describe, expect, it } from 'vitest';
import { computeScenarioDeltas, type ScenarioScoreRow } from '../benchmark/agent/runner.js';

function row(id: number, overall: number | null, tier = 'single_shot', skipped = false): ScenarioScoreRow {
  if (skipped) return { id, tier, skipped: true };
  return { id, tier, ...(overall !== null ? { scores: { overall } } : { scores: {} }) };
}

describe('S1.2 computeScenarioDeltas', () => {
  const THRESHOLD = 0.05; // 5pp

  it('identifies regressed and improved scenarios with correct deltas', () => {
    const baseline = [row(1, 0.90), row(2, 0.50), row(3, 0.70)];
    const current = [
      row(1, 0.80), // −0.10 → regressed
      row(2, 0.62), // +0.12 → improved
      row(3, 0.71), // +0.01 → within threshold (neither)
    ];

    const rows = computeScenarioDeltas(baseline, current, THRESHOLD);

    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(1)?.delta).toBeCloseTo(-0.10, 6);
    expect(byId.get(1)?.regressed).toBe(true);
    expect(byId.get(1)?.improved).toBe(false);

    expect(byId.get(2)?.delta).toBeCloseTo(0.12, 6);
    expect(byId.get(2)?.improved).toBe(true);
    expect(byId.get(2)?.regressed).toBe(false);

    expect(byId.get(3)?.delta).toBeCloseTo(0.01, 6);
    expect(byId.get(3)?.regressed).toBe(false);
    expect(byId.get(3)?.improved).toBe(false);
  });

  it('sorts by delta ascending — biggest regression first', () => {
    const baseline = [row(1, 0.90), row(2, 0.50), row(3, 0.80)];
    const current = [row(1, 0.80), row(2, 0.70), row(3, 0.50)];
    // deltas: #1 −0.10, #2 +0.20, #3 −0.30 → ascending order: #3, #1, #2
    const rows = computeScenarioDeltas(baseline, current, THRESHOLD);
    expect(rows.map((r) => r.id)).toEqual([3, 1, 2]);
  });

  it('marks scenarios present only in current as new, only in baseline as dropped', () => {
    const baseline = [row(1, 0.90), row(2, 0.50)];
    const current = [row(1, 0.91), row(3, 0.40)];
    const rows = computeScenarioDeltas(baseline, current, THRESHOLD);
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(byId.get(3)?.presence).toBe('new');
    expect(byId.get(3)?.delta).toBeNull();
    expect(byId.get(2)?.presence).toBe('dropped');
    expect(byId.get(2)?.delta).toBeNull();
    expect(byId.get(1)?.presence).toBe('both');
  });

  it('null-delta rows sort last and are tie-broken by id', () => {
    const baseline = [row(1, 0.90), row(5, 0.50)];
    const current = [row(1, 0.70), row(9, 0.40), row(2, 0.30)];
    // #1 has delta −0.20; #2 and #9 are new (null), #5 dropped (null).
    const rows = computeScenarioDeltas(baseline, current, THRESHOLD);
    expect(rows[0]?.id).toBe(1); // only real delta, sorts first
    const nullIds = rows.slice(1).map((r) => r.id);
    expect(nullIds).toEqual([2, 5, 9]); // ascending id among null-delta rows
  });

  it('skipped scenarios produce a null score (no false regression)', () => {
    const baseline = [row(1, 0.90)];
    const current = [row(1, 0, 'single_shot', true)]; // skipped in current
    const rows = computeScenarioDeltas(baseline, current, THRESHOLD);
    expect(rows[0]?.currentScore).toBeNull();
    expect(rows[0]?.delta).toBeNull();
    expect(rows[0]?.regressed).toBe(false);
  });

  it('empty inputs yield an empty table', () => {
    expect(computeScenarioDeltas([], [], THRESHOLD)).toEqual([]);
  });

  it('exactly-threshold moves are NOT flagged (strict inequality)', () => {
    const baseline = [row(1, 0.50)];
    const current = [row(1, 0.45)]; // delta exactly −0.05 = −threshold
    const rows = computeScenarioDeltas(baseline, current, 0.05);
    expect(rows[0]?.regressed).toBe(false); // delta < −threshold is strict
  });
});
