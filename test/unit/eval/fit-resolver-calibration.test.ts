import { describe, expect, it } from 'vitest';
import {
  parseTraceNdjson,
  stratifiedHoldoutSplit,
  fitAllClasses,
  hashDataset,
  type TraceRow,
} from '../../../scripts/calibrate/fit-resolver-calibration.js';

const HOLDOUT_RATIO = 0.2;
const SEED = 42;

/** Build a balanced fixture of N positives + N negatives at a fixed score
 *  separation so Platt can recover (a,b). */
function makeBalanced(N: number, queryType?: string): TraceRow[] {
  const rows: TraceRow[] = [];
  for (let i = 0; i < N; i += 1) {
    rows.push({
      score: 0.8 + (i % 5) * 0.01,
      isCorrect: true,
      ...(queryType !== undefined ? { queryType: queryType as TraceRow['queryType'] } : {}),
    });
    rows.push({
      score: 0.2 + (i % 5) * 0.01,
      isCorrect: false,
      ...(queryType !== undefined ? { queryType: queryType as TraceRow['queryType'] } : {}),
    });
  }
  return rows;
}

describe('fit-resolver-calibration — parseTraceNdjson', () => {
  it('parses valid NDJSON, skipping blank lines', () => {
    const ndjson = [
      '{"score":0.8,"isCorrect":true,"queryType":"short_entity"}',
      '',
      '{"score":0.3,"isCorrect":false}',
      '',
    ].join('\n');
    const rows = parseTraceNdjson(ndjson);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ score: 0.8, isCorrect: true, queryType: 'short_entity' });
    expect(rows[1]).toEqual({ score: 0.3, isCorrect: false });
  });

  it('skips schema-mismatched lines (adversarial input)', () => {
    const ndjson = [
      '{"score":"not_a_number","isCorrect":true}',
      '{"score":0.5,"isCorrect":"true"}',
      '{"score":0.7,"isCorrect":true}',
    ].join('\n');
    const rows = parseTraceNdjson(ndjson);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.score).toBe(0.7);
  });

  it('skips invalid JSON without throwing', () => {
    const ndjson = ['{', '{"score":0.4,"isCorrect":false}'].join('\n');
    const rows = parseTraceNdjson(ndjson);
    expect(rows).toHaveLength(1);
  });

  it('drops unknown queryType but keeps the row', () => {
    const ndjson = '{"score":0.6,"isCorrect":true,"queryType":"made_up_class"}';
    const rows = parseTraceNdjson(ndjson);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.queryType).toBeUndefined();
    expect(rows[0]?.score).toBe(0.6);
  });

  it('rejects non-finite score (rule 7 — runtime guard test)', () => {
    // JSON allows Infinity? No — JSON.stringify(Infinity) === 'null'.
    // z.number().finite() rejects NaN if it slips through somehow.
    const ndjson = '{"score":null,"isCorrect":true}';
    const rows = parseTraceNdjson(ndjson);
    expect(rows).toHaveLength(0);
  });
});

describe('fit-resolver-calibration — stratifiedHoldoutSplit', () => {
  it('preserves the positive/negative ratio across train/holdout', () => {
    const rows = makeBalanced(100); // 100 pos + 100 neg = 200 rows
    const split = stratifiedHoldoutSplit(rows, HOLDOUT_RATIO, SEED);
    const holdoutPos = split.holdout.filter((r) => r.isCorrect).length;
    const holdoutNeg = split.holdout.length - holdoutPos;
    // 20% of 100 = 20 each → 40 total
    expect(holdoutPos).toBe(20);
    expect(holdoutNeg).toBe(20);
    expect(split.train.length + split.holdout.length).toBe(200);
  });

  it('is deterministic under the same seed (reproducibility)', () => {
    const rows = makeBalanced(50);
    const a = stratifiedHoldoutSplit(rows, HOLDOUT_RATIO, SEED);
    const b = stratifiedHoldoutSplit(rows, HOLDOUT_RATIO, SEED);
    expect(a.train.map((r) => r.score)).toEqual(b.train.map((r) => r.score));
    expect(a.holdout.map((r) => r.score)).toEqual(b.holdout.map((r) => r.score));
  });

  it('throws on extreme class imbalance (SOTA++: no heuristic fallback)', () => {
    const rows: TraceRow[] = [];
    // 100 positives, 2 negatives — below PER_CLASS_MIN_PER_LABEL
    for (let i = 0; i < 100; i += 1) rows.push({ score: 0.9, isCorrect: true });
    rows.push({ score: 0.1, isCorrect: false });
    rows.push({ score: 0.1, isCorrect: false });
    expect(() => stratifiedHoldoutSplit(rows, HOLDOUT_RATIO, SEED)).toThrow(
      /insufficient class balance/u,
    );
  });

  it('adjacent case — exactly at the minimum per-label threshold succeeds', () => {
    const rows: TraceRow[] = [];
    for (let i = 0; i < 5; i += 1) rows.push({ score: 0.9, isCorrect: true });
    for (let i = 0; i < 5; i += 1) rows.push({ score: 0.1, isCorrect: false });
    // 5 of each is the boundary inclusive.
    expect(() => stratifiedHoldoutSplit(rows, HOLDOUT_RATIO, SEED)).not.toThrow();
  });
});

describe('fit-resolver-calibration — fitAllClasses', () => {
  it('produces one fit per query class with adequate samples', () => {
    const rows = [...makeBalanced(60, 'short_entity'), ...makeBalanced(60, 'pure_constraint')];
    const { fits, skipped } = fitAllClasses(rows, HOLDOUT_RATIO, SEED);
    expect(fits.map((f) => f.queryClass).sort()).toEqual(['pure_constraint', 'short_entity']);
    expect(skipped).toEqual([]);
    for (const f of fits) {
      expect(['platt', 'isotonic', 'temperature']).toContain(f.method);
      expect(Number.isFinite(f.eceAfter)).toBe(true);
      expect(f.sampleSize).toBeGreaterThan(0);
    }
  });

  it('skips classes with insufficient class balance', () => {
    const rows: TraceRow[] = [
      ...makeBalanced(60, 'short_entity'),
      // 2 positives only for ambiguous_short_form — skip expected
      { score: 0.9, isCorrect: true, queryType: 'ambiguous_short_form' },
      { score: 0.8, isCorrect: true, queryType: 'ambiguous_short_form' },
    ];
    const { fits, skipped } = fitAllClasses(rows, HOLDOUT_RATIO, SEED);
    expect(fits.map((f) => f.queryClass)).toEqual(['short_entity']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.queryClass).toBe('ambiguous_short_form');
    expect(skipped[0]?.reason).toMatch(/insufficient_class_balance/u);
  });

  it('empty input → no fits, no skips', () => {
    const { fits, skipped } = fitAllClasses([], HOLDOUT_RATIO, SEED);
    expect(fits).toEqual([]);
    expect(skipped).toEqual([]);
  });
});

describe('fit-resolver-calibration — hashDataset', () => {
  it('produces a deterministic hash regardless of input order', () => {
    const a: TraceRow[] = [
      { score: 0.8, isCorrect: true, queryType: 'short_entity' },
      { score: 0.3, isCorrect: false, queryType: 'short_entity' },
    ];
    const b: TraceRow[] = [...a].reverse();
    expect(hashDataset(a)).toBe(hashDataset(b));
  });

  it('changes when content changes (adjacent case)', () => {
    const a: TraceRow[] = [{ score: 0.8, isCorrect: true }];
    const b: TraceRow[] = [{ score: 0.81, isCorrect: true }];
    expect(hashDataset(a)).not.toBe(hashDataset(b));
  });

  it('returns 64-char hex (sha-256)', () => {
    expect(hashDataset([{ score: 0.5, isCorrect: true }])).toMatch(/^[0-9a-f]{64}$/u);
  });
});
