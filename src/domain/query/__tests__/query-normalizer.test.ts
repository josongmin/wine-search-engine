import { describe, expect, it } from 'vitest';
import { QueryNormalizer } from '../service/query-normalizer.js';

describe('QueryNormalizer', () => {
  const normalizer = new QueryNormalizer();

  it('builds multiple lookup views for noisy entity names', () => {
    const views = normalizer.normalize('  Opús-One 18!  ');

    expect(views.raw).toBe('  Opús-One 18!  ');
    expect(views.strict).toBe('opús-one 18!');
    expect(views.accentless).toBe('opus-one 18!');
    expect(views.punctuationStripped).toBe('opus one 18');
    expect(views.compact).toBe('opusone18');
    expect(views.vintageCanonicalized).toBe('opus one 2018');
    expect(views.vintageStripped).toBe('opus one');
    expect(views.lookupVariants).toEqual(
      expect.arrayContaining([
        'opús-one 18!',
        'opus-one 18!',
        'opus one 18',
        'opus one',
        'opusone18',
        'opus one 2018',
      ]),
    );
  });

  it('produces a transliterated view for common Korean wine names', () => {
    const views = normalizer.normalize('모엣샹동');

    expect(views.transliterated).toBe('moet chandon');
    expect(views.lookupVariants).toContain('moet chandon');
  });

  it('adds phonetic compact for latin-script noisy lookup', () => {
    const views = normalizer.normalize('Moët & Chandon');

    expect(views.compact).toBe('moetchandon');
    expect(views.phoneticCompact).toBe('mtchndn');
  });

  it('normalizes phonetic digraph and french-ending noise into a stable compact key', () => {
    const shandon = normalizer.normalize('Moet Shandon');
    const chandon = normalizer.normalize('Moet Chandon');
    const margo = normalizer.normalize('Margo');
    const margaux = normalizer.normalize('Margaux');

    expect(shandon.phoneticCompact).toBe(chandon.phoneticCompact);
    expect(margo.phoneticCompact).toBe(margaux.phoneticCompact);
  });

  it('supports additional Korean transliteration variants', () => {
    const views = normalizer.normalize('샤토 마고');

    expect(views.transliterated).toBe('chateau margaux');
    expect(views.lookupVariants).toContain('chateaumargaux');
  });

  it('keeps price-like tokens intact while stripping vintages', () => {
    const views = normalizer.normalize('10만원 이하 오푸스원 19');

    expect(views.punctuationStripped).toBe('10만원 이하 오푸스원 19');
    expect(views.vintageCanonicalized).toBe('10만원 이하 오푸스원 2019');
    expect(views.vintageStripped).toBe('10만원 이하 오푸스원');
  });

  it('produces phoneticNormalized for accented wine names without vowel removal', () => {
    const views = normalizer.normalize('Château');

    // phoneticNormalized applies phonetic rules (no vowel removal)
    expect(views.phoneticNormalized).toBeDefined();
    // phoneticCompact strips vowels further
    expect(views.phoneticCompact).toBeDefined();
    // phoneticNormalized is longer (or equal) to phoneticCompact — vowels not removed
    expect((views.phoneticNormalized?.length ?? 0)).toBeGreaterThanOrEqual(
      views.phoneticCompact?.length ?? 0,
    );
    // phoneticNormalized should not be identical to phoneticCompact for vowel-containing words
    expect(views.phoneticNormalized).not.toBe(views.phoneticCompact);
  });

  it('lookupVariants has no duplicates', () => {
    const views = normalizer.normalize('Château Margaux 2015');

    const seen = new Set<string>();
    for (const v of views.lookupVariants) {
      expect(seen.has(v)).toBe(false);
      seen.add(v);
    }
  });

  it('lookupVariants is ordered conservative-first (strict before compact before phoneticCompact)', () => {
    const views = normalizer.normalize('Opus One 2018');

    const variants = views.lookupVariants;
    const strictIdx = variants.indexOf('opus one 2018');
    const compactIdx = variants.indexOf('opusone2018');
    const phoneticCompactVal = views.phoneticCompact;

    expect(strictIdx).toBeGreaterThanOrEqual(0);
    expect(compactIdx).toBeGreaterThanOrEqual(0);
    expect(strictIdx).toBeLessThan(compactIdx);

    if (phoneticCompactVal !== undefined) {
      const phoneticIdx = variants.indexOf(phoneticCompactVal);
      expect(phoneticIdx).toBeGreaterThan(compactIdx);
    }
  });

  it('Korean query produces transliterated view in lookupVariants', () => {
    const views = normalizer.normalize('샤토 마고');

    expect(views.transliterated).toBeDefined();
    expect(views.lookupVariants).toContain(views.transliterated);
  });

  it('vintage query: vintageCanonicalized differs from vintageStripped', () => {
    const views = normalizer.normalize('Margaux 2015');

    expect(views.vintageCanonicalized).toContain('2015');
    expect(views.vintageStripped).not.toContain('2015');
    expect(views.vintageCanonicalized).not.toBe(views.vintageStripped);
  });

  it('reordered variants for multi-word query tries alternate token orderings', () => {
    const views = normalizer.normalize('Margaux Chateau');

    expect(views.reordered).toBeDefined();
    expect(views.reordered).toContain('chateau margaux');
    // Original ordering should not be in reordered (it's already in lookupVariants via vintageStripped)
    expect(views.reordered).not.toContain('margaux chateau');
  });
});
