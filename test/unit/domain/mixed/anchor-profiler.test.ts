/**
 * Regression tests for AnchorProfiler (IDX-03 scale fix).
 *
 * IDX-03: body/sweetness are [0,1] normalised floats in Vespa.
 * Prior anchor-profile.ts docs said "1-5 scale" and DEFAULT_BODY=3, DEFAULT_SWEETNESS=1 —
 * both wrong. This test suite locks in the corrected behaviour.
 */

import { describe, it, expect } from 'vitest';
import { AnchorProfiler } from '../../../../src/domain/mixed/service/anchor-profiler.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';

function makeProfiler(): AnchorProfiler {
  return new AnchorProfiler();
}

const BASE_ENTITY = {
  entityId: createEntityId('test-wine-001'),
  canonicalLabel: 'Test Wine 2020',
  region: 'Burgundy',
  grapes: ['Pinot Noir'],
} as const;

describe('AnchorProfiler — IDX-03: body/sweetness [0,1] normalised scale', () => {
  it('body=0 (fully light) is preserved as-is — not replaced by default', () => {
    const profiler = makeProfiler();
    const profile = profiler.buildProfile({ ...BASE_ENTITY, body: 0 }, 1.0);
    expect(profile.body).toBe(0);
  });

  it('body=1 (full-bodied) is preserved as-is', () => {
    const profiler = makeProfiler();
    const profile = profiler.buildProfile({ ...BASE_ENTITY, body: 1 }, 1.0);
    expect(profile.body).toBe(1);
  });

  it('sweetness=0 (bone dry) is preserved as-is — not replaced by default', () => {
    const profiler = makeProfiler();
    const profile = profiler.buildProfile({ ...BASE_ENTITY, sweetness: 0 }, 1.0);
    expect(profile.sweetness).toBe(0);
  });

  it('sweetness=1 (fully sweet) is preserved as-is', () => {
    const profiler = makeProfiler();
    const profile = profiler.buildProfile({ ...BASE_ENTITY, sweetness: 1 }, 1.0);
    expect(profile.sweetness).toBe(1);
  });

  it('body=0.5 (midpoint) round-trips correctly', () => {
    const profiler = makeProfiler();
    const profile = profiler.buildProfile({ ...BASE_ENTITY, body: 0.5 }, 1.0);
    expect(profile.body).toBeCloseTo(0.5);
  });

  it('missing body → defaults to 0.5 ([0,1] midpoint, was wrongly 3 on 1-5 scale)', () => {
    const profiler = makeProfiler();
    const profile = profiler.buildProfile({ ...BASE_ENTITY }, 1.0);
    // Exact value assertion — range-only check would pass even if default regressed to 0.3
    expect(profile.body).toBe(0.5);
  });

  it('missing sweetness → defaults to 0.1 (dry-wine baseline, was wrongly 1 on 1-5 scale)', () => {
    const profiler = makeProfiler();
    const profile = profiler.buildProfile({ ...BASE_ENTITY }, 1.0);
    expect(profile.sweetness).toBe(0.1);
  });
});

describe('AnchorProfiler — anchorConfidence completeness', () => {
  it('full entity with embedding → confidence close to resolutionConfidence', () => {
    const profiler = makeProfiler();
    const profile = profiler.buildProfile(
      {
        ...BASE_ENTITY,
        body: 0.6,
        sweetness: 0.2,
        style: 'bold red',
        embedding: [0.1, 0.2, 0.3],
      },
      0.9,
    );
    // Completeness is 1.0 (all fields present), so confidence = clamp01(0.9 * 1.0)
    expect(profile.anchorConfidence).toBeCloseTo(0.9);
  });

  it('entity with no optional fields → confidence is discounted', () => {
    const profiler = makeProfiler();
    const sparseProfile = profiler.buildProfile(
      { entityId: createEntityId('sparse'), canonicalLabel: 'Sparse', region: 'Unknown', grapes: [] },
      1.0,
    );
    const fullProfile = profiler.buildProfile(
      { ...BASE_ENTITY, body: 0.5, sweetness: 0.1, style: 'light', embedding: [0.1] },
      1.0,
    );
    expect(sparseProfile.anchorConfidence).toBeLessThan(fullProfile.anchorConfidence);
  });
});
