/**
 * Regression: appellation gazetteer matcher.
 *
 * Exercises the breadcrumb + display-name resolution paths of
 * `tools/wikidata-backfill/appellation-matcher.ts` against the shipped
 * gazetteer. Each case anchors a documented requirement of the matcher: leaf
 * specificity, alias resolution, country-safety, display-name fallback, and
 * the negative path for unmatchable input.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  matchAppellation,
  loadAppellationGazetteer,
  __resetGazetteerCacheForTests,
  compileGazetteer,
  type AppellationGazetteer,
} from '../../tools/wikidata-backfill/appellation-matcher.js';

describe('appellation matcher — breadcrumb resolution', () => {
  beforeEach(() => {
    __resetGazetteerCacheForTests();
  });

  it('returns leaf segment for "France / Bordeaux / Médoc / Pomerol"', () => {
    const m = matchAppellation('France / Bordeaux / Médoc / Pomerol', 'France', 'Some Wine');
    expect(m).not.toBeNull();
    expect(m?.appellation).toBe('Pomerol');
    expect(m?.source).toBe('region_breadcrumb_leaf');
  });

  it('returns leaf for "France / Bordeaux / Pauillac" with country=France', () => {
    const m = matchAppellation('France / Bordeaux / Pauillac', 'France', '');
    expect(m?.appellation).toBe('Pauillac');
    expect(m?.entry.country).toBe('France');
  });

  it('resolves alias to canonical: "Italy / Piedmont / Barolo" → "Barolo DOCG"', () => {
    const m = matchAppellation('Italy / Piedmont / Barolo', 'Italy', '');
    expect(m?.appellation).toBe('Barolo DOCG');
  });

  it('handles "United States / Napa Valley" with country normalisation', () => {
    const m = matchAppellation('United States / Napa Valley', 'United States', '');
    expect(m?.appellation).toBe('Napa Valley');
  });

  it('accepts "USA" as an alias for "United States" when validating country consistency', () => {
    const m = matchAppellation('United States / Napa Valley', 'USA', '');
    expect(m?.appellation).toBe('Napa Valley');
  });

  it('most-specific-wins: "Australia / Barossa Valley / Eden Valley" picks "Eden Valley" not parent', () => {
    const m = matchAppellation(
      'Australia / Barossa Valley / Eden Valley',
      'Australia',
      '',
    );
    expect(m?.appellation).toBe('Eden Valley');
    expect(m?.source).toBe('region_breadcrumb_leaf');
  });

  it('falls back to parent when leaf is not in gazetteer', () => {
    // "Some Tiny Lieu-Dit" is not a gazetteer key; "Pauillac" is, so the
    // non-leaf scan should pick Pauillac.
    const m = matchAppellation(
      'France / Bordeaux / Pauillac / Some Tiny Lieu-Dit',
      'France',
      '',
    );
    expect(m?.appellation).toBe('Pauillac');
    expect(m?.source).toBe('region_breadcrumb_scan');
  });

  it('country mismatch rejects an otherwise-matching leaf (region=France but country=Italy)', () => {
    const m = matchAppellation('France / Bordeaux / Pomerol', 'Italy', '');
    expect(m).toBeNull();
  });

  it('returns null when neither breadcrumb nor display name has a hit', () => {
    const m = matchAppellation('No / Such / Place', 'Atlantis', 'Random Cuvée');
    expect(m).toBeNull();
  });
});

describe('appellation matcher — display-name fallback', () => {
  beforeEach(() => {
    __resetGazetteerCacheForTests();
  });

  it('resolves "2018 Tenuta San Guido Bolgheri" → Bolgheri DOC when region is empty', () => {
    const m = matchAppellation('', 'Italy', '2018 Tenuta San Guido Bolgheri');
    expect(m?.appellation).toBe('Bolgheri DOC');
    expect(m?.source).toBe('display_name_scan');
  });

  it('longest-key-wins on display-name scan ("Brunello di Montalcino" beats bare "Montalcino")', () => {
    const m = matchAppellation(
      '',
      'Italy',
      'Biondi-Santi Brunello di Montalcino Riserva 2010',
    );
    expect(m?.appellation).toBe('Brunello di Montalcino DOCG');
  });

  it('word-bounded match: "Cornas" inside "Cornassa Cuvée" must NOT match', () => {
    // Forge a display name that contains "Cornas" as a substring of a longer
    // token. The matcher must reject it because Cornas is bounded by letters.
    const m = matchAppellation('', 'France', 'Domaine Cornassa Special Cuvée');
    expect(m).toBeNull();
  });

  it('display-name scan respects country safety (no Champagne if country=Italy)', () => {
    const m = matchAppellation('', 'Italy', '2018 Hypothetical Champagne-style Sparkling');
    expect(m).toBeNull();
  });

  it('accented characters: "Médoc" in display name matches Médoc', () => {
    const m = matchAppellation('', 'France', 'Cru Bourgeois Médoc 2019');
    expect(m?.appellation).toBe('Médoc');
  });

  it('null country still allows breadcrumb match (we trust region/name when country is unknown)', () => {
    const m = matchAppellation('France / Bordeaux / Pomerol', null, '');
    expect(m?.appellation).toBe('Pomerol');
  });
});

describe('appellation matcher — edge cases', () => {
  beforeEach(() => {
    __resetGazetteerCacheForTests();
  });

  it('returns null on empty inputs', () => {
    const m = matchAppellation('', '', '');
    expect(m).toBeNull();
  });

  it('handles ">"-style breadcrumb separator', () => {
    const m = matchAppellation('France > Bordeaux > Pomerol', 'France', '');
    expect(m?.appellation).toBe('Pomerol');
  });

  it('whitespace-only segments are stripped and ignored', () => {
    const m = matchAppellation('  /  / France / Bordeaux / Pomerol /  ', 'France', '');
    expect(m?.appellation).toBe('Pomerol');
  });

  it('matcher accepts a custom compiled gazetteer (dependency-injection path)', () => {
    const fixture: AppellationGazetteer = {
      version: 1,
      rationale: 'fixture',
      entries: [
        { appellation: 'TestZone', country: 'France', region: 'TestRegion' },
      ],
    };
    const compiled = compileGazetteer(fixture);
    const m = matchAppellation('France / TestRegion / TestZone', 'France', '', compiled);
    expect(m?.appellation).toBe('TestZone');
    // Real gazetteer key "Pomerol" must NOT resolve against the fixture compile.
    const miss = matchAppellation('France / Bordeaux / Pomerol', 'France', '', compiled);
    expect(miss).toBeNull();
  });

  it('shipped gazetteer entry count is ≥ 500 (contracted dataset shape)', () => {
    const g = loadAppellationGazetteer();
    expect(g.data.entries.length).toBeGreaterThanOrEqual(500);
  });
});
