import { describe, expect, it } from 'vitest';
import { normalizeRegion } from '../../../scripts/etl/region-normalizer.js';

describe('normalizeRegion — documented corruption examples', () => {
  it('reverses the Spain / Ribera del Duero duplicated-prefix breadcrumb', () => {
    const result = normalizeRegion(
      'Spain / Ribera del Duero / Spain / Castilla y León / Ribera del Duero',
    );
    expect(result.region).toBe('Ribera del Duero');
    expect(result.hierarchy).toEqual(['Spain', 'Castilla y León', 'Ribera del Duero']);
    expect(result.appellation).toBeUndefined();
  });

  it('reverses the United States / Napa Valley duplicated-prefix breadcrumb', () => {
    const result = normalizeRegion(
      'United States / Napa Valley / United States / California / North Coast / Napa County / Napa Valley',
    );
    expect(result.region).toBe('Napa Valley');
    expect(result.hierarchy).toEqual([
      'United States',
      'California',
      'North Coast',
      'Napa County',
      'Napa Valley',
    ]);
    expect(result.appellation).toBeUndefined();
  });

  it('reverses the Italy / Etna duplicated-prefix breadcrumb', () => {
    const result = normalizeRegion('Italy / Etna / Italy / Southern Italy / Terre Siciliane / Etna');
    expect(result.region).toBe('Etna');
    expect(result.hierarchy).toEqual(['Italy', 'Southern Italy', 'Terre Siciliane', 'Etna']);
    expect(result.appellation).toBeUndefined();
  });
});

describe('normalizeRegion — corruption variants observed in the corpus', () => {
  it('handles country-only summary prefix (secondOccurrenceIndex === 1)', () => {
    // "Country / Country / ...full": summary is just the country.
    const result = normalizeRegion('Chile / Chile / Aconcagua / San Antonio Valley / Leyda Valley');
    expect(result.region).toBe('Leyda Valley');
    expect(result.hierarchy).toEqual([
      'Chile',
      'Aconcagua',
      'San Antonio Valley',
      'Leyda Valley',
    ]);
  });

  it('collapses the degenerate "Country / Country" form to the country', () => {
    const result = normalizeRegion('United States / United States');
    expect(result.region).toBe('United States');
    // After de-dup the path is a single node — no multi-level hierarchy.
    expect(result.hierarchy).toBeUndefined();
  });

  it('drops a "Read more" scrape artifact sitting before the repeated country', () => {
    const result = normalizeRegion(
      'Australia / McLaren Vale / Read more / Australia / South Australia / Fleurieu / McLaren Vale',
    );
    expect(result.region).toBe('McLaren Vale');
    expect(result.hierarchy).toEqual([
      'Australia',
      'South Australia',
      'Fleurieu',
      'McLaren Vale',
    ]);
    // The artifact must not survive anywhere in the output.
    expect(result.hierarchy).not.toContain('Read more');
  });
});

describe('normalizeRegion — clean inputs pass through untouched', () => {
  it('returns a plain region unchanged with no hierarchy', () => {
    const result = normalizeRegion('Rioja');
    expect(result.region).toBe('Rioja');
    expect(result.hierarchy).toBeUndefined();
    expect(result.appellation).toBeUndefined();
  });

  it('passes through an accented-Latin region (Côte de Nuits) without mangling (NFC safety)', () => {
    const result = normalizeRegion('Côte de Nuits');
    expect(result.region).toBe('Côte de Nuits');
    expect(result.hierarchy).toBeUndefined();
  });

  it('passes through a plain region with spaces (California)', () => {
    const result = normalizeRegion('California');
    expect(result.region).toBe('California');
    expect(result.hierarchy).toBeUndefined();
  });

  it('passes through a Korean region name unchanged (NFC / non-ASCII safety)', () => {
    const result = normalizeRegion('보르도');
    expect(result.region).toBe('보르도');
    expect(result.hierarchy).toBeUndefined();
  });
});

describe('normalizeRegion — genuine multi-level breadcrumb (no duplicated prefix)', () => {
  it('keeps every segment when the country does not repeat', () => {
    const result = normalizeRegion('France / Bourgogne / Côte de Nuits');
    expect(result.region).toBe('Côte de Nuits');
    expect(result.hierarchy).toEqual(['France', 'Bourgogne', 'Côte de Nuits']);
    expect(result.appellation).toBeUndefined();
  });

  it('handles a Castilla y León uncorrupted breadcrumb (accented, no repeat)', () => {
    const result = normalizeRegion('Spain / Castilla y León / Ribera del Duero');
    expect(result.region).toBe('Ribera del Duero');
    expect(result.hierarchy).toEqual(['Spain', 'Castilla y León', 'Ribera del Duero']);
  });
});

describe('normalizeRegion — edge / adversarial inputs', () => {
  it('returns empty region for empty input', () => {
    const result = normalizeRegion('');
    expect(result.region).toBe('');
    expect(result.hierarchy).toBeUndefined();
  });

  it('trims surrounding whitespace on a plain region', () => {
    const result = normalizeRegion('  Rioja  ');
    expect(result.region).toBe('Rioja');
    expect(result.hierarchy).toBeUndefined();
  });

  it('handles a separator-only string without throwing', () => {
    const result = normalizeRegion(' / ');
    // No non-empty segments survive; falls back to the trimmed input.
    expect(typeof result.region).toBe('string');
    expect(result.hierarchy).toBeUndefined();
  });

  it('drops blank interior segments produced by doubled separators', () => {
    const result = normalizeRegion('France /  / Bourgogne');
    expect(result.region).toBe('Bourgogne');
    expect(result.hierarchy).toEqual(['France', 'Bourgogne']);
  });

  it('never emits a region containing the breadcrumb separator', () => {
    const inputs = [
      'Spain / Ribera del Duero / Spain / Castilla y León / Ribera del Duero',
      'United States / United States',
      'France / Bourgogne / Côte de Nuits',
      'Rioja',
    ];
    for (const input of inputs) {
      expect(normalizeRegion(input).region).not.toContain(' / ');
    }
  });
});
