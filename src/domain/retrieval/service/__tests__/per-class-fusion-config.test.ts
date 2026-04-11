import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FUSION_CONFIG,
  PER_CLASS_FUSION,
  getFusionConfig,
  type QueryClass,
} from '../per-class-fusion-config.js';

describe('per-class-fusion-config', () => {
  it('DEFAULT_FUSION_CONFIG uses canonical RRF k=60', () => {
    expect(DEFAULT_FUSION_CONFIG.rrfK).toBe(60);
    expect(DEFAULT_FUSION_CONFIG.learnedSparseWeight).toBe(0);
  });

  it('specific_wine has higher sparseWeight than browse', () => {
    const specific = getFusionConfig('specific_wine');
    const browse = getFusionConfig('browse');
    expect(specific.sparseWeight).toBeGreaterThan(browse.sparseWeight);
    // And browse should prefer dense over sparse.
    expect(browse.denseWeight).toBeGreaterThan(browse.sparseWeight);
  });

  it('getFusionConfig falls back to DEFAULT for unknown class', () => {
    const unknown = getFusionConfig('totally-not-a-class');
    expect(unknown).toBe(DEFAULT_FUSION_CONFIG);
    const empty = getFusionConfig('');
    expect(empty).toBe(DEFAULT_FUSION_CONFIG);
  });

  it('every declared QueryClass has a config registered', () => {
    const classes: readonly QueryClass[] = [
      'specific_wine',
      'entity_exact',
      'browse',
      'compare',
      'pairing',
      'fallback',
    ];
    for (const cls of classes) {
      const cfg = PER_CLASS_FUSION.get(cls);
      expect(cfg, `missing config for ${cls}`).toBeDefined();
    }
    expect(PER_CLASS_FUSION.size).toBe(classes.length);
  });

  it('all weights sum to a sane (>0) value for every class', () => {
    for (const [cls, cfg] of PER_CLASS_FUSION.entries()) {
      const sum =
        cfg.sparseWeight +
        cfg.denseWeight +
        cfg.anchorWeight +
        cfg.learnedSparseWeight;
      expect(sum, `weights sum for ${cls}`).toBeGreaterThan(0);
      expect(cfg.rrfK).toBeGreaterThan(0);
      expect(cfg.sparseWeight).toBeGreaterThanOrEqual(0);
      expect(cfg.denseWeight).toBeGreaterThanOrEqual(0);
      expect(cfg.anchorWeight).toBeGreaterThanOrEqual(0);
      expect(cfg.learnedSparseWeight).toBeGreaterThanOrEqual(0);
    }
  });
});
