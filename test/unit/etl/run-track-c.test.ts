import { describe, expect, it } from 'vitest';
import { assertTrackCFieldCoverageIsComplete } from '../../../scripts/etl/run-track-c.js';

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
