import { describe, expect, it } from 'vitest';
import {
  assertTrackCFieldCoverageIsComplete,
  assertTrackCSourceStateMatches,
  buildTrackCSourceState,
  parseFromStep,
  TRACK_C_STEP_DEFINITIONS,
  TRACK_C_TOTAL_STEPS,
} from '../../../scripts/etl/run-track-c.js';

describe('assertTrackCFieldCoverageIsComplete', () => {
  it('passes only when every record has the field', () => {
    expect(() =>
      assertTrackCFieldCoverageIsComplete('criticProxy', {
        present: 10,
        total: 10,
      }),
    ).not.toThrow();
  });

  it('passes when coverage ratio satisfies a partial threshold', () => {
    expect(() =>
      assertTrackCFieldCoverageIsComplete('criticProxy', {
        present: 7,
        total: 10,
      }, 0.7),
    ).not.toThrow();
  });

  it('fails closed on partial coverage', () => {
    expect(() =>
      assertTrackCFieldCoverageIsComplete('criticProxy', {
        present: 9,
        total: 10,
      }),
    ).toThrow(/not fully populated/);
  });

  it('fails closed when below minimum threshold', () => {
    expect(() =>
      assertTrackCFieldCoverageIsComplete('criticProxy', {
        present: 6,
        total: 10,
      }, 0.7),
    ).toThrow(/below minimum coverage/);
  });

  it('fails closed on empty output', () => {
    expect(() =>
      assertTrackCFieldCoverageIsComplete('criticProxy', {
        present: 0,
        total: 0,
      }),
    ).toThrow(/has no records/);
  });
});

describe('Track C source state', () => {
  it('derives a stable fingerprint from the source docquery artifact', () => {
    const state = buildTrackCSourceState('/tmp/silver-docquery.ndjson', '{"id":1}\n{"id":2}\n');

    expect(state).toEqual({
      sourcePath: '/tmp/silver-docquery.ndjson',
      sourceHash: expect.any(String),
      sourceRecordCount: 2,
    });
  });

  it('fails closed when the working copy source state drifts', () => {
    const current = buildTrackCSourceState('/tmp/silver-docquery.ndjson', '{"id":1}\n{"id":2}\n');
    const recorded = buildTrackCSourceState('/tmp/silver-docquery.ndjson', '{"id":1}\n');

    expect(() => assertTrackCSourceStateMatches(current, recorded)).toThrow(
      /source hash mismatch/,
    );
  });
});

describe('Track C step plan', () => {
  it('exposes seven ordered steps with gift/beginner coverage wired in', () => {
    expect(TRACK_C_TOTAL_STEPS).toBe(7);
    expect(TRACK_C_STEP_DEFINITIONS.map((step) => step.num)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(TRACK_C_STEP_DEFINITIONS[5]).toMatchObject({
      num: 6,
      script: 'run-track-c-step6-gift-suitability.ts',
      field: 'giftSuitabilityClassification',
      requiredCoverage: 1,
    });
    expect(TRACK_C_STEP_DEFINITIONS[6]).toMatchObject({
      num: 7,
      script: 'run-track-c-step7-beginner-suitability.ts',
      field: 'beginnerSuitabilityClassification',
      requiredCoverage: 1,
    });
    expect(TRACK_C_STEP_DEFINITIONS[3]).toMatchObject({
      num: 4,
      field: 'occasionClassification',
      requiredCoverage: 0,
    });
  });

  it('clamps --from-step to the seven-step plan', () => {
    expect(parseFromStep(['--from-step', '999'])).toBe(7);
    expect(parseFromStep(['--from-step', '0'])).toBe(1);
    expect(parseFromStep(['--from-step', 'not-a-number'])).toBe(1);
  });
});
