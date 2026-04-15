import { describe, it, expect } from 'vitest';
import { extractClaims } from '../service/claim-extractor.js';

describe('extractClaims', () => {
  it('extracts wine name (Latin)', () => {
    const claims = extractClaims('Opus One is a great wine.');
    expect(claims.some((c) => c.category === 'identity_claim' && c.value === 'Opus One')).toBe(true);
  });

  it('extracts Korean wine name', () => {
    const claims = extractClaims('오푸스원을 추천드립니다.');
    expect(claims.some((c) => c.category === 'identity_claim' && c.value === '오푸스원')).toBe(true);
  });

  it('normalizes Korean typo wine names before identity extraction', () => {
    const claims = extractClaims('오퍼스원을 추천드립니다.');
    expect(claims.some((c) => c.category === 'identity_claim' && c.value === '오푸스원')).toBe(true);
  });

  it('does not extract generic Korean prose as identity claims', () => {
    const claims = extractClaims('검색 결과 기준으로 지금은 맞아요.');
    const ids = claims.filter((c) => c.category === 'identity_claim');
    expect(ids).toHaveLength(0);
  });

  it('extracts curated multi-word Korean wine labels only', () => {
    const claims = extractClaims('보졸레누보 올해 거 있나?');
    expect(claims.some((c) => c.category === 'identity_claim' && c.value === '보졸레 누보')).toBe(true);
  });

  it('does not extract structured Latin geography as identity claims', () => {
    const claims = extractClaims('France / Ribera del Duero / Castilla y León');
    const ids = claims.filter((c) => c.category === 'identity_claim');
    expect(ids).toHaveLength(0);
    expect(claims.some((c) => c.field === 'region' && c.value === 'Ribera del Duero')).toBe(true);
  });

  it('does not extract appellations as identity claims', () => {
    const claims = extractClaims('Brunello and Barolo are classic Italian appellations.');
    const ids = claims.filter((c) => c.category === 'identity_claim');
    expect(ids).toHaveLength(0);
  });

  it('extracts full Latin labels with numeric tokens instead of split fragments', () => {
    const claims = extractClaims('검색 결과: 2020 Cepa 21 Malabrigo');
    const ids = claims.filter((c) => c.category === 'identity_claim');
    expect(ids.map((c) => c.value)).toEqual(['Cepa 21 Malabrigo']);
  });

  it('extracts vintage year', () => {
    const claims = extractClaims('Château Margaux 2015 is excellent.');
    const vintage = claims.find((c) => c.field === 'vintage_year');
    expect(vintage?.value).toBe('2015');
  });

  it('does not extract drinking window years as vintage', () => {
    const claims = extractClaims('Best consumed 2025-2035.');
    const vintages = claims.filter((c) => c.field === 'vintage_year');
    expect(vintages).toHaveLength(0);
  });

  it('extracts Korean price (만원)', () => {
    const claims = extractClaims('가격은 5만원입니다.');
    const price = claims.find((c) => c.field === 'price_usd');
    expect(price).toBeDefined();
  });

  it('extracts plain Korean price', () => {
    const claims = extractClaims('149,000원에 판매됩니다.');
    const price = claims.find((c) => c.field === 'price_usd');
    expect(price).toBeDefined();
  });

  it('extracts grape variety', () => {
    const claims = extractClaims('Made from Cabernet Sauvignon.');
    const grape = claims.find((c) => c.field === 'grape_primary');
    expect(grape?.normalizedValue).toBe('cabernet sauvignon');
  });

  it('resolves grape alias (Shiraz → Syrah)', () => {
    const claims = extractClaims('Australian Shiraz from Barossa.');
    const grape = claims.find((c) => c.field === 'grape_primary' && c.normalizedValue === 'syrah');
    expect(grape).toBeDefined();
  });

  it('extracts wine type (red)', () => {
    const claims = extractClaims('A bold red wine from Napa.');
    const wineType = claims.find((c) => c.field === 'wine_type');
    expect(wineType?.normalizedValue).toBe('red');
  });

  it('extracts Korean wine type (레드)', () => {
    const claims = extractClaims('풀바디 레드와인입니다.');
    const wineType = claims.find((c) => c.field === 'wine_type');
    expect(wineType?.normalizedValue).toBe('red');
  });

  it('extracts semantic claims (tasting notes)', () => {
    const claims = extractClaims('블랙베리와 다크초콜릿 향이 풍부합니다.');
    const semantic = claims.find((c) => c.category === 'semantic_claim');
    expect(semantic).toBeDefined();
  });

  it('extracts pairing claims', () => {
    const claims = extractClaims('스테이크와 어울리는 와인입니다.');
    const pairing = claims.find((c) => c.field === 'pairing_rationale');
    expect(pairing).toBeDefined();
  });

  it('deduplicates identical claims', () => {
    const claims = extractClaims('Cabernet Sauvignon, Cabernet Sauvignon, more Cabernet Sauvignon.');
    const grapes = claims.filter((c) => c.field === 'grape_primary' && c.normalizedValue === 'cabernet sauvignon');
    expect(grapes).toHaveLength(1);
  });

  it('claim IDs are deterministic', () => {
    const a = extractClaims('Opus One 2015');
    const b = extractClaims('Opus One 2015');
    expect(a.map((c) => c.id).sort()).toEqual(b.map((c) => c.id).sort());
  });

  it('rejects far-future years as vintages', () => {
    const claims = extractClaims('Released 2099.');
    const vintages = claims.filter((c) => c.field === 'vintage_year');
    expect(vintages).toHaveLength(0);
  });

  it('handles empty string', () => {
    expect(extractClaims('')).toEqual([]);
  });

  it('filters Korean stopwords from identity claims', () => {
    const claims = extractClaims('와인 추천 드립니다');
    const ids = claims.filter((c) => c.category === 'identity_claim');
    expect(ids).toHaveLength(0);
  });
});
