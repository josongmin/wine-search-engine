import type { SourceLang } from '../../src/domain/alias/service/transliterator.js';

/**
 * Deterministic country/region → transliteration language mapping shared by
 * snapshot build and legacy PG transliteration backfill.
 */
export function inferTransliterationSourceLang(
  country: string | null,
  region: string | null,
): SourceLang {
  const c = (country ?? '').toLowerCase();
  const r = (region ?? '').toLowerCase();
  if (c.includes('italy') || r.includes('tuscany') || r.includes('piemonte') || r.includes('barolo')) {
    return 'it';
  }
  if (c.includes('spain') || r.includes('rioja') || r.includes('ribera')) {
    return 'es';
  }
  if (
    c.includes('united states')
    || c === 'usa'
    || c.includes('australia')
    || c.includes('new zealand')
    || c.includes('chile')
    || c.includes('argentina')
    || c.includes('canada')
  ) {
    return 'en';
  }
  return 'fr';
}
