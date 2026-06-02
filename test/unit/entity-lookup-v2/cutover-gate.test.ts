/**
 * Cutover gate — per-class no-regression + abstain 0-wrong-positive + the
 * eval_cases content fingerprint (Fix #3). The 15-hotset overstated V2 and hid
 * V1's precision bug + the noisy_recall ceiling; the FULL eval_cases
 * distribution is the cutover authority. These are pure unit tests on the gate
 * functions — no live DB.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluatePerClassGate,
  DEFAULT_PER_CLASS_GATE,
  type ClassTally,
  type PerClassEntry,
} from '../../../scripts/eval/lookup-v2-shadow-metrics.js';
import {
  fingerprintEvalRows,
  toPerClassEntries,
} from '../../../scripts/eval/run-entity-resolution-validation.js';

/** Build a class tally that derives `miss`/`wrong` totals consistently. */
function tally(correct: number, wrong: number, miss: number): ClassTally {
  return { correct, wrong, miss, total: correct + wrong + miss };
}

/**
 * The June-2 full-distribution per-class result (recalibrated run — the cutover
 * authority). exact_entity 75/75, ambiguous_short_form 60/60 correct-abstain,
 * noisy_recall 24/40 (60% tie), no_match 40/40. This is the baseline the gate
 * MUST accept. V1 numbers come from the same run (exact 54/75=72%, ambiguous
 * 48/60=80% with 12 wrong, noisy 24/40, no_match 40/40).
 */
function june2Baseline(): PerClassEntry[] {
  return [
    { queryClass: 'exact_entity', shouldResolve: true, v1: tally(54, 0, 21), v2: tally(75, 0, 0) },
    { queryClass: 'ambiguous_short_form', shouldResolve: false, v1: tally(48, 12, 0), v2: tally(60, 0, 0) },
    { queryClass: 'noisy_recall', shouldResolve: true, v1: tally(24, 0, 16), v2: tally(24, 0, 16) },
    { queryClass: 'no_match', shouldResolve: false, v1: tally(40, 0, 0), v2: tally(40, 0, 0) },
  ];
}

describe('evaluatePerClassGate (cutover authority — full distribution)', () => {
  it('per-class-regression-baseline: PASSES on the June-2 per-class tallies', () => {
    const result = evaluatePerClassGate(june2Baseline());
    expect(result.pass).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('per-class-wrong-positive-independence: an abstain class with >0 V2 wrong-positive FAILS even if overall rate is fine', () => {
    const entries = june2Baseline().map((e) =>
      e.queryClass === 'no_match'
        // V2 resolves 1 of 40 no_match rows (a wrong-positive) but the correct-rate
        // (39/40 = 97.5%) still beats V1 (40/40 × 0.98 = 98% — just below, but the
        // point is the wrong-positive rule fires regardless).
        ? { ...e, v2: tally(39, 1, 0) }
        : e,
    );
    const result = evaluatePerClassGate(entries);
    expect(result.pass).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/no_match.*wrong-positive/i);
  });

  it('false-positive single-wrong-positive injection: 1 wrong-positive on ambiguous_short_form FAILS the gate', () => {
    const entries = june2Baseline().map((e) =>
      e.queryClass === 'ambiguous_short_form'
        // exactly one row that should have abstained now resolves.
        ? { ...e, v2: tally(59, 1, 0) }
        : e,
    );
    const result = evaluatePerClassGate(entries);
    expect(result.pass).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/ambiguous_short_form.*1 V2 wrong-positive/i);
  });

  it('per-class catches a single-class regression the overall rate would hide', () => {
    // Overall would still look healthy (exact_entity overshoots), but noisy_recall
    // drops from 24/40 (60%) to 12/40 (30%) — below V1 60% × 0.98. The per-class
    // gate must FAIL on noisy_recall even though the aggregate could pass.
    const entries = june2Baseline().map((e) =>
      e.queryClass === 'noisy_recall' ? { ...e, v2: tally(12, 0, 28) } : e,
    );
    const result = evaluatePerClassGate(entries);
    expect(result.pass).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/noisy_recall.*below/i);
    // No spurious abstain-class wrong-positive reason — only the regression.
    expect(result.reasons.filter((r) => /wrong-positive/i.test(r))).toEqual([]);
  });

  it('uses a documented 0.98 per-class tolerance constant', () => {
    expect(DEFAULT_PER_CLASS_GATE.perClassCorrectRateRatioMin).toBe(0.98);
  });

  it('produces deterministic, class-name-sorted reasons regardless of input order', () => {
    const broken: PerClassEntry[] = [
      { queryClass: 'no_match', shouldResolve: false, v1: tally(40, 0, 0), v2: tally(39, 1, 0) },
      { queryClass: 'ambiguous_short_form', shouldResolve: false, v1: tally(60, 0, 0), v2: tally(59, 1, 0) },
    ];
    const a = evaluatePerClassGate(broken);
    const b = evaluatePerClassGate([...broken].reverse());
    expect(a.reasons).toEqual(b.reasons);
    // ambiguous_short_form sorts before no_match.
    expect(a.reasons[0]).toMatch(/ambiguous_short_form/);
  });
});

describe('toPerClassEntries (full-distribution tally → shared gate shape)', () => {
  it('marks should-resolve classes correctly and feeds the gate', () => {
    const byClass: Record<string, { v1: ClassTally; v2: ClassTally }> = {
      exact_entity: { v1: tally(54, 0, 21), v2: tally(75, 0, 0) },
      no_match: { v1: tally(40, 0, 0), v2: tally(40, 0, 0) },
    };
    const entries = toPerClassEntries(byClass, ['exact_entity', 'noisy_recall']);
    expect(entries.find((e) => e.queryClass === 'exact_entity')?.shouldResolve).toBe(true);
    expect(entries.find((e) => e.queryClass === 'no_match')?.shouldResolve).toBe(false);
    expect(evaluatePerClassGate(entries).pass).toBe(true);
  });
});

describe('fingerprintEvalRows (eval_cases snapshot pin)', () => {
  const rowsA = [
    { query: 'Opus One 2018', queryClass: 'exact_entity', expectedEntityId: 'opus-one-2018' },
    { query: '오퍼스', queryClass: 'ambiguous_short_form', expectedEntityId: null },
    { query: 'zzz no such wine', queryClass: 'no_match', expectedEntityId: null },
  ];

  it('content-hash determinism: same rows → same fingerprint', () => {
    expect(fingerprintEvalRows(rowsA)).toBe(fingerprintEvalRows([...rowsA]));
  });

  it('content-hash determinism: reordered rows → same fingerprint (sorted internally)', () => {
    const reordered = [rowsA[2]!, rowsA[0]!, rowsA[1]!];
    expect(fingerprintEvalRows(reordered)).toBe(fingerprintEvalRows(rowsA));
  });

  it('changed expected_entity_id → different fingerprint', () => {
    const mutated = rowsA.map((r) =>
      r.query === 'Opus One 2018' ? { ...r, expectedEntityId: 'opus-one-2019' } : r,
    );
    expect(fingerprintEvalRows(mutated)).not.toBe(fingerprintEvalRows(rowsA));
  });

  it('emits a 64-char hex sha-256 digest', () => {
    expect(fingerprintEvalRows(rowsA)).toMatch(/^[0-9a-f]{64}$/);
  });
});
