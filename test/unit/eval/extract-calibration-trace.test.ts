import { describe, expect, it } from 'vitest';
import {
  parseExtractArgs,
  rowsToTrace,
  serialiseTraceToNdjson,
} from '../../../scripts/eval/extract-calibration-trace.js';

describe('extract-calibration-trace — CLI parsing', () => {
  it('happy path: --output + defaults', () => {
    const parsed = parseExtractArgs(['--output', 'trace.ndjson']);
    expect(parsed).not.toHaveProperty('help');
    if ('help' in parsed) return;
    expect(parsed.output).toBe('trace.ndjson');
    expect(parsed.sinceDays).toBe(7);
    expect(parsed.minSamples).toBe(100);
  });

  it('overrides --since and --min-samples', () => {
    const parsed = parseExtractArgs([
      '-o',
      'trace.ndjson',
      '--since',
      '14',
      '--min-samples',
      '500',
    ]);
    if ('help' in parsed) {
      throw new Error('unexpected help branch');
    }
    expect(parsed.sinceDays).toBe(14);
    expect(parsed.minSamples).toBe(500);
  });

  it('throws on missing --output (operator MUST supply a target file)', () => {
    expect(() => parseExtractArgs(['--since', '7'])).toThrow(/--output is required/u);
  });

  it('throws on negative --since (adversarial input)', () => {
    expect(() => parseExtractArgs(['--output', 'x', '--since', '-1'])).toThrow(
      /positive number of days/u,
    );
  });

  it('throws on non-numeric --since (adversarial input)', () => {
    expect(() => parseExtractArgs(['--output', 'x', '--since', 'forever'])).toThrow(
      /positive number of days/u,
    );
  });

  it('returns { help: true } on --help', () => {
    const parsed = parseExtractArgs(['--help']);
    expect(parsed).toEqual({ help: true });
  });
});

describe('extract-calibration-trace — rowsToTrace', () => {
  const createdAt = new Date('2026-05-14T00:00:00Z');

  it('happy path: maps PG rows to trace, preserves query_class when valid', () => {
    const rows = [
      {
        top1_raw_score: 0.82,
        is_correct_resolve: true,
        query_class: 'short_entity',
        created_at: createdAt,
      },
      {
        top1_raw_score: 0.45,
        is_correct_resolve: false,
        query_class: 'pure_constraint',
        created_at: createdAt,
      },
    ];
    const out = rowsToTrace(rows);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ score: 0.82, isCorrect: true, queryType: 'short_entity' });
    expect(out[1]).toEqual({ score: 0.45, isCorrect: false, queryType: 'pure_constraint' });
  });

  it('skips rows with NULL top1_raw_score (legacy migration window)', () => {
    const rows = [
      {
        top1_raw_score: null,
        is_correct_resolve: true,
        query_class: 'short_entity',
        created_at: createdAt,
      },
      {
        top1_raw_score: 0.6,
        is_correct_resolve: true,
        query_class: 'short_entity',
        created_at: createdAt,
      },
    ];
    const out = rowsToTrace(rows);
    expect(out).toHaveLength(1);
    expect(out[0]?.score).toBe(0.6);
  });

  it('skips rows with non-finite top1_raw_score (corrupted ETL guard)', () => {
    const rows = [
      {
        top1_raw_score: Number.NaN,
        is_correct_resolve: true,
        query_class: 'short_entity',
        created_at: createdAt,
      },
      {
        top1_raw_score: Number.POSITIVE_INFINITY,
        is_correct_resolve: false,
        query_class: 'short_entity',
        created_at: createdAt,
      },
      {
        top1_raw_score: 0.5,
        is_correct_resolve: true,
        query_class: 'short_entity',
        created_at: createdAt,
      },
    ];
    const out = rowsToTrace(rows);
    expect(out).toHaveLength(1);
    expect(out[0]?.score).toBe(0.5);
  });

  it('drops queryType when row.query_class is not a known QueryClass', () => {
    const rows = [
      {
        top1_raw_score: 0.5,
        is_correct_resolve: true,
        query_class: 'some_unknown_class_label_that_drifted',
        created_at: createdAt,
      },
    ];
    const out = rowsToTrace(rows);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ score: 0.5, isCorrect: true });
    // crucially: queryType omitted, not set to 'unknown' (rule 26 — don't
    // collapse the unknown label into the synthetic bucket here).
    expect(out[0]).not.toHaveProperty('queryType');
  });

  it('empty input → empty output (adjacent zero-row case, CLAUDE.md rule 4)', () => {
    expect(rowsToTrace([])).toEqual([]);
  });

  it('handles score=0 correctly (rule 26 — 0 is a legitimate value, not falsy)', () => {
    const rows = [
      {
        top1_raw_score: 0,
        is_correct_resolve: false,
        query_class: 'short_entity',
        created_at: createdAt,
      },
    ];
    const out = rowsToTrace(rows);
    expect(out).toHaveLength(1);
    expect(out[0]?.score).toBe(0);
  });
});

describe('extract-calibration-trace — NDJSON serialisation', () => {
  it('serialises rows one per line, ending with \\n', () => {
    const rows = [
      { score: 0.8, isCorrect: true, queryType: 'short_entity' as const },
      { score: 0.3, isCorrect: false },
    ];
    const out = serialiseTraceToNdjson(rows);
    expect(out).toBe(
      '{"score":0.8,"isCorrect":true,"queryType":"short_entity"}\n{"score":0.3,"isCorrect":false}\n',
    );
  });

  it('empty rows → empty string (adjacent edge case)', () => {
    expect(serialiseTraceToNdjson([])).toBe('');
  });
});
