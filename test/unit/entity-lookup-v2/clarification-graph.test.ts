import { describe, expect, it } from 'vitest';
import { buildClarification } from '../../../src/domain/resolver/v2/clarification-graph.js';

describe('buildClarification (T-ELV2-06)', () => {
  it('classifies a same-base multi-vintage cluster and surfaces vintage features', () => {
    const r = buildClarification([
      { entityId: 'opus-2018', canonicalLabel: 'Opus One 2018' },
      { entityId: 'opus-2019', canonicalLabel: 'Opus One 2019' },
    ]);
    expect(r.kind).toBe('multi_vintage');
    expect(r.ambiguityTypes).toContain('multi_vintage');
    expect(r.options.map((o) => o.distinguishingFeature)).toEqual(['vintage 2018', 'vintage 2019']);
  });

  it('distinguishes producer-family / cuvée variants by unique tokens', () => {
    const r = buildClarification([
      { entityId: 'caymus-cab', canonicalLabel: 'Caymus Cabernet Sauvignon' },
      { entityId: 'caymus-ss', canonicalLabel: 'Caymus Special Selection' },
    ]);
    expect(r.kind).toBe('variant_or_collision');
    expect(r.ambiguityTypes).toContain('producer_family_collision');
    // shared token "caymus" excluded; unique tokens surface as the feature
    const features = r.options.map((o) => o.distinguishingFeature ?? '');
    expect(features[0]).toContain('cabernet');
    expect(features[1]).toContain('special');
  });

  it('flags alias_collision when candidates share no common token', () => {
    const r = buildClarification([
      { entityId: 'a', canonicalLabel: 'Penfolds Grange' },
      { entityId: 'b', canonicalLabel: 'Henschke Hill of Grace' },
    ]);
    expect(r.kind).toBe('variant_or_collision');
    expect(r.ambiguityTypes).toContain('alias_collision');
  });

  it('returns a single (no-ambiguity) result for one candidate', () => {
    const r = buildClarification([{ entityId: 'x', canonicalLabel: 'X 2020' }]);
    expect(r.kind).toBe('single');
    expect(r.options).toHaveLength(1);
  });

  it('handles a Korean multi-vintage cluster', () => {
    const r = buildClarification([
      { entityId: 'k18', canonicalLabel: '오퍼스 원 2018' },
      { entityId: 'k19', canonicalLabel: '오퍼스 원 2019' },
    ]);
    expect(r.kind).toBe('multi_vintage');
  });
});
