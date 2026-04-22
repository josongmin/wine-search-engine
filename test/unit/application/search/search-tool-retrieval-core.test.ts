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
});
