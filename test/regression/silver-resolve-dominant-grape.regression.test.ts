/**
 * Regression: `resolveDominantGrape` honours region/appellation domain
 * knowledge instead of `grapes[0]` blind selection.
 *
 * Pre-fix: silver `extractGrapes(payload)` returns an alphabetically-ordered
 * comma list parsed from `payload.varietal`. For Bordeaux blends the list
 * typically contains all 5 noble varietals regardless of % composition.
 * Picking `grapes[0]` produces wrong primaries — e.g. "1998 Château Moulinet
 * Pomerol" → 'Malbec', when Pomerol is Merlot-dominant.
 *
 * Pinned contract:
 *  1. Single-variety grape list → returned unchanged.
 *  2. Multi-variety + region matches table + named primary IS in list → use table.
 *  3. Multi-variety + no region match → fall back to grapes[0] (existing).
 *  4. Multi-variety + region matches but named primary NOT in list → fall back
 *     to grapes[0] (don't mis-attribute, e.g. a Napa-region Sangiovese stays
 *     Sangiovese, not "Cabernet Sauvignon" just because of the region label).
 *  5. Empty list → null.
 */

import { describe, it, expect } from 'vitest';
import { resolveDominantGrape } from '../../scripts/etl/vivino-to-silver.js';

describe('silver resolveDominantGrape — region-aware primary grape (regression)', () => {
  it('singleton list returns the single variety', () => {
    expect(resolveDominantGrape(['Nebbiolo'], '2014 Gaja Barbaresco')).toBe('Nebbiolo');
  });

  it('empty list returns null', () => {
    expect(resolveDominantGrape([], 'any blob')).toBeNull();
  });

  describe('Bordeaux right bank (Pomerol / Saint-Émilion → Merlot)', () => {
    const bordeauxBlend = [
      'Malbec', 'Merlot', 'Petit Verdot', 'Cabernet Sauvignon', 'Cabernet Franc',
    ];

    it('Pomerol → Merlot (the Sassicaia-cluster bug fix)', () => {
      expect(
        resolveDominantGrape(bordeauxBlend, '1998 Château Moulinet Pomerol'),
      ).toBe('Merlot');
    });

    it('Saint-Émilion → Merlot', () => {
      expect(
        resolveDominantGrape(bordeauxBlend, '2010 Château Cheval Blanc Saint-Émilion Grand Cru'),
      ).toBe('Merlot');
    });
  });

  describe('Bordeaux left bank (Pauillac / Saint-Julien / Margaux → Cabernet Sauvignon)', () => {
    const bordeauxBlend = [
      'Cabernet Franc', 'Cabernet Sauvignon', 'Malbec', 'Merlot', 'Petit Verdot',
    ];

    it('Pauillac → Cabernet Sauvignon', () => {
      expect(
        resolveDominantGrape(bordeauxBlend, '1991 Château Lafite Rothschild Pauillac'),
      ).toBe('Cabernet Sauvignon');
    });

    it('Margaux → Cabernet Sauvignon', () => {
      expect(
        resolveDominantGrape(bordeauxBlend, '1982 Château Margaux Pavillon Rouge'),
      ).toBe('Cabernet Sauvignon');
    });

    it('Saint-Julien → Cabernet Sauvignon', () => {
      expect(
        resolveDominantGrape(bordeauxBlend, '1983 Château Gruaud Larose Saint-Julien'),
      ).toBe('Cabernet Sauvignon');
    });
  });

  describe('Italy', () => {
    it('Barolo → Nebbiolo (when in list)', () => {
      expect(resolveDominantGrape(['Nebbiolo', 'Barbera'], '2007 Gaja Sperss Barolo')).toBe('Nebbiolo');
    });

    it('Brunello di Montalcino → Sangiovese', () => {
      expect(
        resolveDominantGrape(['Sangiovese'], '1997 Gaja Pieve Santa Restituta Rennina Brunello di Montalcino'),
      ).toBe('Sangiovese');
    });
  });

  describe('New World', () => {
    it('Napa Valley → Cabernet Sauvignon (when in list)', () => {
      expect(
        resolveDominantGrape(['Cabernet Sauvignon', 'Merlot'], '2017 Eleven Eleven Cabernet Sauvignon Napa Valley'),
      ).toBe('Cabernet Sauvignon');
    });

    it('Barossa Valley → Shiraz', () => {
      expect(
        resolveDominantGrape(['Shiraz', 'Cabernet Sauvignon'], '2018 Penfolds Grange Barossa Valley'),
      ).toBe('Shiraz');
    });

    it('Mendoza → Malbec', () => {
      expect(
        resolveDominantGrape(['Malbec', 'Cabernet Sauvignon'], '2020 Catena Zapata Mendoza'),
      ).toBe('Malbec');
    });
  });

  describe('Safety: do NOT mis-attribute when named primary is absent', () => {
    it('Napa-label but no Cab Sauv in list → fall back to grapes[0]', () => {
      expect(
        resolveDominantGrape(['Sangiovese', 'Merlot'], 'Some Napa Valley Italian-blend Wine'),
      ).toBe('Sangiovese');
    });

    it('Unknown region → fall back to grapes[0]', () => {
      expect(
        resolveDominantGrape(['Tempranillo', 'Grenache'], 'Some New Vineyard Red'),
      ).toBe('Tempranillo');
    });
  });

  describe('Case insensitivity', () => {
    it('uppercase region in label still matches', () => {
      expect(
        resolveDominantGrape(['Merlot', 'Cabernet Sauvignon'], '2020 SOMEWINE POMEROL'),
      ).toBe('Merlot');
    });
  });
});
