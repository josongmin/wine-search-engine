import { describe, expect, it } from 'vitest';
import { assertDocQueryRunSucceeded } from '../../../scripts/etl/generate-doc-queries.js';

describe('assertDocQueryRunSucceeded', () => {
  it('allows a clean run with zero failures', () => {
    expect(() =>
      assertDocQueryRunSucceeded({
        total: 100,
        skipped: 20,
        generated: 80,
        failed: 0,
        totalQueries: 1200,
      }),
    ).not.toThrow();
  });

  it('rejects partial output when any generation failure occurs', () => {
    expect(() =>
      assertDocQueryRunSucceeded({
        total: 100,
        skipped: 20,
        generated: 79,
        failed: 1,
        totalQueries: 1185,
      }),
    ).toThrow(/refusing to promote partial output/);
  });
});
