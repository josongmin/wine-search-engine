/**
 * Unit tests for the CalibrationRecord schema.
 *
 * Locked at the scripts __tests__ lane (see config/vitest/unit.config.ts).
 * These exercise the Zod contract directly — no sweep execution, no I/O.
 */

import { describe, it, expect } from 'vitest';
import {
  CALIBRATION_RECORD_VERSION,
  CalibrationRecordSchema,
  SWEEP_QUERY_CLASSES,
  parseCalibrationRecord,
  type CalibrationRecord,
} from '../calibration-record.js';

function validRecord(
  overrides: Partial<CalibrationRecord> = {},
): CalibrationRecord {
  return {
    version: 'v1',
    queryClass: 'browse',
    evaluatedAt: '2026-05-25T12:34:56.000Z',
    gridPoint: {
      sparseWeight: 1.0,
      denseWeight: 1.5,
      anchorWeight: 1.0,
      learnedSparseWeight: 0.0,
    },
    metrics: {
      ndcgAt5: 0.72,
      ndcgAt10: 0.78,
      recallAt20: 0.91,
      mrr: 0.65,
    },
    evalCorpus: 'gold-set-v2',
    evalSampleSize: 250,
    ...overrides,
  };
}

describe('CalibrationRecordSchema', () => {
  it('accepts a well-formed record', () => {
    const r = validRecord();
    const parsed = CalibrationRecordSchema.parse(r);
    expect(parsed).toEqual(r);
  });

  it('pins schema version to v1', () => {
    expect(CALIBRATION_RECORD_VERSION).toBe('v1');
    const bad = { ...validRecord(), version: 'v2' as 'v1' };
    expect(() => CalibrationRecordSchema.parse(bad)).toThrow();
  });

  it('rejects unknown queryClass values', () => {
    const bad = { ...validRecord(), queryClass: 'mystery' as 'browse' };
    expect(() => CalibrationRecordSchema.parse(bad)).toThrow();
  });

  it('accepts every queryClass enumerated by SWEEP_QUERY_CLASSES', () => {
    for (const qc of SWEEP_QUERY_CLASSES) {
      const ok = CalibrationRecordSchema.safeParse(
        validRecord({ queryClass: qc }),
      );
      expect(ok.success, `queryClass=${qc}`).toBe(true);
    }
  });

  it('rejects metric values outside [0, 1]', () => {
    const tooHigh = validRecord({
      metrics: {
        ndcgAt5: 1.01,
        ndcgAt10: 0.5,
        recallAt20: 0.5,
        mrr: 0.5,
      },
    });
    expect(() => CalibrationRecordSchema.parse(tooHigh)).toThrow();

    const negative = validRecord({
      metrics: {
        ndcgAt5: 0.5,
        ndcgAt10: -0.0001,
        recallAt20: 0.5,
        mrr: 0.5,
      },
    });
    expect(() => CalibrationRecordSchema.parse(negative)).toThrow();
  });

  it('rejects NaN / Infinity metrics (finite() guard)', () => {
    const nan = validRecord({
      metrics: {
        ndcgAt5: Number.NaN,
        ndcgAt10: 0.5,
        recallAt20: 0.5,
        mrr: 0.5,
      },
    });
    expect(() => CalibrationRecordSchema.parse(nan)).toThrow();

    const inf = validRecord({
      metrics: {
        ndcgAt5: 0.5,
        ndcgAt10: Number.POSITIVE_INFINITY,
        recallAt20: 0.5,
        mrr: 0.5,
      },
    });
    expect(() => CalibrationRecordSchema.parse(inf)).toThrow();
  });

  it('rejects negative or zero evalSampleSize', () => {
    expect(() =>
      CalibrationRecordSchema.parse(validRecord({ evalSampleSize: 0 })),
    ).toThrow();
    expect(() =>
      CalibrationRecordSchema.parse(validRecord({ evalSampleSize: -1 })),
    ).toThrow();
  });

  it('rejects non-ISO evaluatedAt timestamps', () => {
    const bad = validRecord({ evaluatedAt: '2026/05/25 12:34' });
    expect(() => CalibrationRecordSchema.parse(bad)).toThrow();
  });

  it('rejects extra unknown keys (.strict)', () => {
    const withExtra = {
      ...validRecord(),
      mysteryField: 'should not be here',
    } as unknown;
    expect(() => CalibrationRecordSchema.parse(withExtra)).toThrow();
  });

  it('rejects negative gridPoint weights', () => {
    const bad = validRecord({
      gridPoint: {
        sparseWeight: -0.1,
        denseWeight: 1.0,
        anchorWeight: 1.0,
        learnedSparseWeight: 0.0,
      },
    });
    expect(() => CalibrationRecordSchema.parse(bad)).toThrow();
  });

  it('parseCalibrationRecord throws on malformed input and returns on valid', () => {
    expect(() => parseCalibrationRecord({ nope: true })).toThrow();
    const ok = parseCalibrationRecord(validRecord());
    expect(ok.version).toBe('v1');
  });
});
