import { describe, it, expect } from 'vitest';
import {
  regionHierarchyDepth,
  regionsRelated,
  resolveGrapeAlias,
  grapesEquivalent,
  normalizeWineType,
  parseKoreanPrice,
} from '../service/wine-ontology.js';

describe('regionHierarchyDepth', () => {
  it('exact match returns 0', () => {
    expect(regionHierarchyDepth('Bordeaux', 'Bordeaux')).toBe(0);
  });

  it('direct parent returns 1', () => {
    expect(regionHierarchyDepth('Pauillac', 'Haut-Médoc')).toBe(1);
  });

  it('grandparent returns 2', () => {
    expect(regionHierarchyDepth('Pauillac', 'Médoc')).toBe(2);
  });

  it('great-grandparent returns 3', () => {
    expect(regionHierarchyDepth('Pauillac', 'Bordeaux')).toBe(3);
  });

  it('country level returns 4 for Pauillac → France', () => {
    expect(regionHierarchyDepth('Pauillac', 'France')).toBe(4);
  });

  it('unrelated regions return -1', () => {
    expect(regionHierarchyDepth('Pauillac', 'Napa Valley')).toBe(-1);
  });

  it('case-insensitive lookup', () => {
    expect(regionHierarchyDepth('PAUILLAC', 'bordeaux')).toBe(3);
  });

  it('handles Burgundy hierarchy', () => {
    expect(regionHierarchyDepth('Gevrey-Chambertin', 'Burgundy')).toBe(2);
  });

  it('handles Italy hierarchy', () => {
    expect(regionHierarchyDepth('Barolo', 'Piedmont')).toBe(1);
    expect(regionHierarchyDepth('Barolo', 'Italy')).toBe(2);
  });

  it('handles USA hierarchy', () => {
    expect(regionHierarchyDepth('Napa Valley', 'California')).toBe(1);
    expect(regionHierarchyDepth('Napa Valley', 'United States')).toBe(2);
  });
});

describe('regionsRelated', () => {
  it('symmetric: parent ↔ child', () => {
    expect(regionsRelated('Pauillac', 'Bordeaux')).toBe(true);
    expect(regionsRelated('Bordeaux', 'Pauillac')).toBe(true);
  });

  it('unrelated returns false', () => {
    expect(regionsRelated('Pauillac', 'Napa Valley')).toBe(false);
  });
});

describe('resolveGrapeAlias', () => {
  it('Shiraz → Syrah', () => {
    expect(resolveGrapeAlias('Shiraz')).toBe('syrah');
  });

  it('Garnacha → Grenache', () => {
    expect(resolveGrapeAlias('Garnacha')).toBe('grenache');
  });

  it('Pinot Grigio → Pinot Gris', () => {
    expect(resolveGrapeAlias('Pinot Grigio')).toBe('pinot gris');
  });

  it('Cab Sauv → Cabernet Sauvignon', () => {
    expect(resolveGrapeAlias('Cab Sauv')).toBe('cabernet sauvignon');
  });

  it('Primitivo → Zinfandel', () => {
    expect(resolveGrapeAlias('Primitivo')).toBe('zinfandel');
  });

  it('Moscato → Muscat', () => {
    expect(resolveGrapeAlias('Moscato')).toBe('muscat');
  });

  it('Barolo is NOT mapped to a grape (region-name removed in round 2 audit)', () => {
    // Region names like Barolo/Chianti/Amarone were removed from GRAPE_ALIASES
    // because resolveGrapeAlias is called on free strings and the silent
    // mis-resolution caused false grape claims. See wine-ontology.ts comment.
    expect(resolveGrapeAlias('Barolo')).toBe('barolo');
  });

  it('case-insensitive', () => {
    expect(resolveGrapeAlias('SHIRAZ')).toBe('syrah');
  });

  it('unknown grape returns lowercased original', () => {
    expect(resolveGrapeAlias('UnknownVariety')).toBe('unknownvariety');
  });
});

describe('grapesEquivalent', () => {
  it('Shiraz = Syrah', () => {
    expect(grapesEquivalent('Shiraz', 'Syrah')).toBe(true);
  });

  it('Cabernet Sauvignon != Cabernet Franc', () => {
    expect(grapesEquivalent('Cabernet Sauvignon', 'Cabernet Franc')).toBe(false);
  });

  it('Pinot Gris = Pinot Grigio', () => {
    expect(grapesEquivalent('Pinot Gris', 'Pinot Grigio')).toBe(true);
  });
});

describe('normalizeWineType', () => {
  it('Korean rosé → rosé', () => {
    expect(normalizeWineType('로제')).toBe('rosé');
  });

  it('rose → rosé', () => {
    expect(normalizeWineType('rose')).toBe('rosé');
  });

  it('Korean 레드 → red', () => {
    expect(normalizeWineType('레드')).toBe('red');
  });

  it('rouge → red', () => {
    expect(normalizeWineType('rouge')).toBe('red');
  });

  it('Champagne → sparkling', () => {
    expect(normalizeWineType('champagne')).toBe('sparkling');
  });
});

describe('parseKoreanPrice', () => {
  it('5만원 → 50000', () => {
    expect(parseKoreanPrice('5만원')).toBe(50000);
  });

  it('15만원 → 150000', () => {
    expect(parseKoreanPrice('15만원')).toBe(150000);
  });

  it('50,000원 → 50000', () => {
    expect(parseKoreanPrice('50,000원')).toBe(50000);
  });

  it('149,000원 → 149000', () => {
    expect(parseKoreanPrice('149,000원')).toBe(149000);
  });

  it('$50 → 67500 (× 1350)', () => {
    expect(parseKoreanPrice('$50')).toBe(67500);
  });

  it('returns null for non-price text', () => {
    expect(parseKoreanPrice('hello world')).toBeNull();
  });

  it('handles fractional 만원 (3.5만원)', () => {
    expect(parseKoreanPrice('3.5만원')).toBe(35000);
  });
});
