import { describe, expect, it } from 'vitest';

import { GENERATED_KOREAN_BROAD_AMBIGUITY_SURFACES } from '../../src/domain/query/service/generated/korean-broad-ambiguity-surfaces.js';
import { buildGeneratedKoreanBroadAmbiguitySurfaces } from '../../scripts/lib/build-korean-broad-ambiguity-surfaces.js';

describe('generated Korean broad ambiguity surfaces regression', () => {
  it('stays in sync with the source-graph classifier output', async () => {
    await expect(buildGeneratedKoreanBroadAmbiguitySurfaces()).resolves.toEqual(
      GENERATED_KOREAN_BROAD_AMBIGUITY_SURFACES,
    );
  });

  it('contains core automatically provable producer/appellation/generic broad surfaces', () => {
    const surfaces = new Set(GENERATED_KOREAN_BROAD_AMBIGUITY_SURFACES.map((entry) => entry.term));

    expect(surfaces.has('카테나')).toBe(true);
    expect(surfaces.has('토카이')).toBe(true);
    expect(surfaces.has('샤블리')).toBe(true);
    expect(surfaces.has('아드리아나')).toBe(true);
  });
});
