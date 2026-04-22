import { describe, expect, it } from 'vitest';
import { buildSearchToolRetrievalCoreQuery } from '../../../../src/application/search/search-tool-retrieval-core.js';

describe('buildSearchToolRetrievalCoreQuery', () => {
  it('collapses short canonical entity queries by default', () => {
    expect(buildSearchToolRetrievalCoreQuery({ query: 'Barolo wine' })).toBe('barolo');
  });

  it('preserves representative concept search when explicitly requested', () => {
    const query = buildSearchToolRetrievalCoreQuery({
      query: 'Barolo wine',
      preserveRepresentativeSearch: true,
    });

    expect(query.toLowerCase()).toContain('barolo');
    expect(query.toLowerCase()).toContain('wine');
    expect(query).not.toBe('barolo');
  });

  it('keeps the user lexical anchor when occasion expansion is additive', () => {
    const query = buildSearchToolRetrievalCoreQuery({
      query: '와인 잘 모르는 사람한테 선물할 거',
      occasion: ['gift'],
    });

    expect(query).toContain('와인 잘 모르는 사람한테 선물할 거');
    expect(query).toContain('gift');
    expect(query).toContain('wine');
  });

  it('preserves representative anchors for structured recommendation queries', () => {
    const query = buildSearchToolRetrievalCoreQuery({
      query: 'Opus One anniversary gift',
      occasion: ['anniversary'],
      styles: ['approachable'],
      max_alcohol_pct: 12,
    });

    expect(query).toBe('opus one');
  });

  it('suppresses duplicated structured entity semantics for budgeted region recommendations', () => {
    const query = buildSearchToolRetrievalCoreQuery({
      query: 'best Bordeaux under 100 dollars',
      region: 'Bordeaux',
      max_price_krw: 135_000,
    });

    expect(query).toBe('wine');
  });

  it('retains non-duplicative structured type semantics when geography anchors are suppressed', () => {
    const query = buildSearchToolRetrievalCoreQuery({
      query: '이탈리아 레드 가성비',
      country: 'Italy',
      wine_type: 'red',
      max_price_krw: 50_000,
    });

    expect(query).toBe('red wine');
  });

  it('keeps Korean food context while adding canonical pairing and type terms', () => {
    const query = buildSearchToolRetrievalCoreQuery({
      query: '메인 소고기용 레드 추천',
      wine_type: 'red',
    });

    expect(query).toContain('메인 소고기용 레드 추천');
    expect(query).toContain('beef');
    expect(query).toContain('red');
    expect(query).toContain('wine');
  });

  it('preserves exact-vintage sku anchors even when structured vintage bounds are present', () => {
    const query = buildSearchToolRetrievalCoreQuery({
      query: 'almaviva 2019',
      vintage_min: 2019,
      vintage_max: 2019,
    });

    expect(query).toBe('almaviva 2019');
  });

  it('normalizes canonical exact-entity labels into lexical-safe query terms', () => {
    const query = buildSearchToolRetrievalCoreQuery({
      query: '모엣샹동 로제 임페리얼',
    });

    expect(query).toBe('moet chandon rose imperial');
    expect(query).not.toContain('&');
  });

  it('does not re-lexicalize cellaring defaults that have no retrieval-side evidence profile', () => {
    const query = buildSearchToolRetrievalCoreQuery({
      query: '와인',
      occasion: ['cellaring'],
      styles: ['ageworthy', 'cellarworthy'],
    });

    expect(query).toBe('와인');
    expect(query).not.toContain('cellaring');
    expect(query).not.toContain('ageworthy');
    expect(query).not.toContain('cellarworthy');
  });
});
