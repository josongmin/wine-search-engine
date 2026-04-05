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

  it('keeps price-like tokens intact while stripping vintages', () => {
    const views = normalizer.normalize('10만원 이하 오푸스원 19');

    expect(views.punctuationStripped).toBe('10만원 이하 오푸스원 19');
    expect(views.vintageCanonicalized).toBe('10만원 이하 오푸스원 2019');
    expect(views.vintageStripped).toBe('10만원 이하 오푸스원');
  });
});

