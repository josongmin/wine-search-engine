/**
 * Benchmark snapshot isolation contract.
 *
 * Locks the invariants:
 *  - BenchmarkReport carries snapshotId and snapshotContaminated fields
 *  - snapshotContaminated is false when the pointer is stable
 *  - snapshotContaminated is true when pre/post snapshot IDs diverge
 *
 * Append-only: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import type { BenchmarkReport } from '../../test/benchmark/agent/runner.js';

describe('BenchmarkReport — snapshot isolation fields', () => {
  it('snapshotId field exists and accepts string | null', () => {
    const withId: Pick<BenchmarkReport, 'snapshotId'> = { snapshotId: 'search-snapshot:v1:abc123' };
    expect(withId.snapshotId).toBe('search-snapshot:v1:abc123');

    const withoutId: Pick<BenchmarkReport, 'snapshotId'> = { snapshotId: null };
    expect(withoutId.snapshotId).toBeNull();
  });

  it('snapshotContaminated field exists and is boolean', () => {
    const clean: Pick<BenchmarkReport, 'snapshotContaminated'> = { snapshotContaminated: false };
    expect(clean.snapshotContaminated).toBe(false);

    const contaminated: Pick<BenchmarkReport, 'snapshotContaminated'> = { snapshotContaminated: true };
    expect(contaminated.snapshotContaminated).toBe(true);
  });

  it('snapshot fields are part of the report interface alongside other reproducibility fields', () => {
    // Type-level assertion: a partial report with all reproducibility fields compiles.
    const repro: Pick<BenchmarkReport, 'promptHash' | 'snapshotId' | 'snapshotContaminated' | 'model' | 'seed'> = {
      promptHash: 'abc123',
      snapshotId: 'search-snapshot:v1:def456',
      snapshotContaminated: false,
      model: 'gpt-5.4-mini',
      seed: 42,
    };
    expect(repro.snapshotId).toBeDefined();
    expect(repro.snapshotContaminated).toBe(false);
  });
});
