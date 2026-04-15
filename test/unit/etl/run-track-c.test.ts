import { describe, expect, it } from 'vitest';
import {
  assertTrackCFieldCoverageIsComplete,
  assertTrackCSourceStateMatches,
  buildTrackCSourceState,
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

  it('fails closed on partial coverage', () => {
    expect(() =>
      assertTrackCFieldCoverageIsComplete('criticProxy', {
        present: 9,
        total: 10,
      }),
    ).toThrow(/not fully populated/);
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
