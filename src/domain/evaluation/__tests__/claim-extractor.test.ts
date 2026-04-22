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

  it('extracts Korean region aliases as region claims', () => {
    const claims = extractClaims('보르도와 나파 스타일 차이가 궁금해');
    const regions = claims.filter((c) => c.field === 'region').map((c) => c.value);
    expect(regions).toEqual(expect.arrayContaining(['Bordeaux', 'Napa Valley']));
  });

  it('does not treat user-input contrast mentions as region claims', () => {
    const claims = extractClaims('보르도 지역이라는 추가 맥락은 입력에 있었지만, 현재 결과에선 region이 France / France로만 제시되어 있습니다.');
    expect(claims.some((c) => c.field === 'region' && c.value === 'Bordeaux')).toBe(false);
  });

  it('extracts Korean grape slang alias as grape claim', () => {
    const claims = extractClaims('까쇼 추천해줘');
    expect(claims.some((c) => c.field === 'grape_primary' && c.normalizedValue === 'cabernet sauvignon')).toBe(true);
  });

  it('extracts Korean grape names as grape claims', () => {
    const claims = extractClaims('카베르네 소비뇽 기반 와인');
    expect(claims.some((c) => c.field === 'grape_primary' && c.normalizedValue === 'cabernet sauvignon')).toBe(true);
  });

  it('extracts grape-only English variety surfaces as grape claims in Korean recommendation prose', () => {
    const claims = extractClaims('Furmint 추천해줘.');
    expect(claims.some((c) => c.category === 'core_structured_claim' && c.field === 'grape_primary' && c.normalizedValue === 'furmint')).toBe(true);
    expect(claims.some((c) => c.category === 'identity_claim' && c.value === 'Furmint')).toBe(false);
  });

  it('does not promote generic Korean recommendation prose to identity claims', () => {
    const claims = extractClaims('풀바디 레드 와인 추천: 검색 결과 기준으로 맞는 표기를 정리해드릴게요.');
    const identities = claims.filter((c) => c.category === 'identity_claim');
    expect(identities).toHaveLength(0);
  });

  it('does not promote drinkability question wrappers to identity claims', () => {
    const claims = extractClaims('현재 받은 검색 결과 기준으로 지금 마시기 좋은지 설명드릴게요.');
    const identities = claims.filter((c) => c.category === 'identity_claim');
    expect(identities).toHaveLength(0);
  });

  it('does not promote colloquial filler words to identity claims', () => {
    const claims = extractClaims('쌈싸먹을 때는 보통 이런 화이트가 맞아요.');
    const identities = claims.filter((c) => c.category === 'identity_claim');
    expect(identities).toHaveLength(0);
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

  it('does not extract producer shards split by ampersand as standalone identity claims', () => {
    const claims = extractClaims('Moët & Chandon Brut Impérial NV를 추천합니다.');
    const ids = claims.filter((c) => c.category === 'identity_claim').map((c) => c.value);
    expect(ids).not.toContain('Moët');
  });

  it('does not extract pairing-list food nouns as identity claims', () => {
    const claims = extractClaims('- 페어링: Pasta, Cheese');
    const ids = claims.filter((c) => c.category === 'identity_claim').map((c) => c.value);
    expect(ids).toEqual([]);
  });

  it('does not extract pairing tag values as identity claims', () => {
    const claims = extractClaims('페어링 태그로는 Cured Meat, Cheese가 확인되었습니다.');
    const ids = claims.filter((c) => c.category === 'identity_claim').map((c) => c.value);
    expect(ids).toEqual([]);
    expect(claims.some((c) => c.category === 'semantic_claim' && c.field === 'pairing_rationale')).toBe(true);
  });

  it('extracts vintage year', () => {
    const claims = extractClaims('Château Margaux 2015 is excellent.');
    const vintage = claims.find((c) => c.field === 'vintage_year');
    expect(vintage?.value).toBe('2015');
  });

  it('does not split appellation tokens out of exact Latin identity claims', () => {
    const claims = extractClaims('확인된 정확한 와인은 2022 Château Margaux입니다.');
    expect(claims.some((c) => c.category === 'identity_claim' && c.value === 'Château Margaux')).toBe(true);
    expect(claims.some((c) => c.field === 'region' && c.value === 'Margaux')).toBe(false);
  });

  it('masks repeated grand-vin label spans before region extraction', () => {
    const claims = extractClaims('확인된 정확한 와인은 2022 Château Margaux Château Margaux (Premier Grand Cru Classé)입니다.');
    expect(claims.some((c) => c.category === 'identity_claim' && c.value === 'Château Margaux Château Margaux (Premier Grand Cru Classé)')).toBe(true);
    expect(claims.some((c) => c.category === 'identity_claim' && c.value === 'Premier Grand Cru Classé')).toBe(false);
    expect(claims.some((c) => c.field === 'region' && c.value === 'Margaux')).toBe(false);
  });

  it('extracts markdown-emphasized grand-vin labels as the same identity span', () => {
    const claims = extractClaims('네, **2022 Château Margaux Château Margaux (Premier Grand Cru Classé)**가 정확히 확인되었습니다.');
    expect(claims.some((c) => c.category === 'identity_claim' && c.value === 'Château Margaux Château Margaux (Premier Grand Cru Classé)')).toBe(true);
    expect(claims.some((c) => c.category === 'identity_claim' && c.value === 'Premier Grand Cru Classé')).toBe(false);
  });

  it('does not extract drinking window years as vintage', () => {
    const claims = extractClaims('Best consumed 2025-2035.');
    const vintages = claims.filter((c) => c.field === 'vintage_year');
    expect(vintages).toHaveLength(0);
  });

  it('does not extract Korean drinking-window dash ranges as vintages', () => {
    const claims = extractClaims('음용창이 바롤로는 2017–2022, 브루넬로는 2011–2016입니다.');
    const vintages = claims.filter((c) => c.field === 'vintage_year');
    expect(vintages).toHaveLength(0);
  });

  it('does not extract current reference years as vintages', () => {
    const claims = extractClaims('현재(2026) 마시기 좋고, 2026년 현재 피크 구간입니다.');
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

  it('extracts composite Korean prices without splitting the trailing won amount', () => {
    const claims = extractClaims('바롤로는 약 20만 1,150원, 브루넬로는 약 53만 4,600원입니다.');
    const prices = claims.filter((c) => c.field === 'price_usd').map((c) => c.normalizedValue);
    expect(prices).toEqual(['149.00', '396.00']);
  });

  it('does not extract aggregate budgets, sums, or price-band prose as wine price claims', () => {
    const claims = extractClaims('총 20만원, 예상 합계는 70,457원이고 3만 원대나 5만 원대 옵션도 가능합니다.');
    const prices = claims.filter((c) => c.field === 'price_usd');
    expect(prices).toEqual([]);
  });

  it('extracts grape variety', () => {
    const claims = extractClaims('Made from Cabernet Sauvignon.');
    const grape = claims.find((c) => c.field === 'grape_primary');
    expect(grape?.normalizedValue).toBe('cabernet sauvignon');
    expect(claims.some((c) => c.category === 'identity_claim' && c.value === 'Cabernet Sauvignon')).toBe(false);
  });

  it('resolves grape alias (Shiraz → Syrah)', () => {
    const claims = extractClaims('Australian Shiraz from Barossa.');
    const grape = claims.find((c) => c.field === 'grape_primary' && c.normalizedValue === 'syrah');
    expect(grape).toBeDefined();
    expect(claims.some((c) => c.category === 'identity_claim' && c.value === 'Shiraz')).toBe(false);
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

  it('extracts English pairing rationale with "pairs well with"', () => {
    const claims = extractClaims('Sassicaia 2018 pairs well with grilled ribeye and hearty red meat dishes.');
    const pairing = claims.find((c) => c.field === 'pairing_rationale');
    expect(pairing).toBeDefined();
  });

  it('keeps Latin wine labels with lowercase connector chains as one identity claim', () => {
    const claims = extractClaims('2012 Château Pétrus Saute-Loup Reserve de la Famille Pomerol입니다.');
    expect(claims.some((c) =>
      c.category === 'identity_claim'
      && c.value === 'Château Pétrus Saute-Loup Reserve de la Famille Pomerol'
    )).toBe(true);
    expect(claims.some((c) =>
      c.category === 'identity_claim'
      && c.value === 'Famille Pomerol'
    )).toBe(false);
  });

  it('extracts recommendation-style semantic claims', () => {
    const claims = extractClaims('Masi Amarone is recommended for a cold winter evening near the fireplace.');
    const opinion = claims.find((c) => c.category === 'semantic_claim' && c.field === 'general_opinion');
    expect(opinion).toBeDefined();
  });

  it('does not extract future service offers as wine semantic claims', () => {
    const claims = extractClaims('원하시면 이 와인의 음용 적기나 음식 페어링도 이어서 확인해드릴게요.');
    const semanticClaims = claims.filter((c) => c.category === 'semantic_claim');
    expect(semanticClaims).toHaveLength(0);
  });

  it('does not extract identities or wine types from exact-lookup no-confirmation sentences', () => {
    const claims = extractClaims('현재 증거로는 모엣 로제가 단일한 정확한 와인 엔티티로 확인되지 않습니다. 정확한 라벨이나 조건을 알려주세요.');
    expect(claims.filter((c) => c.category === 'identity_claim')).toHaveLength(0);
    expect(claims.filter((c) => c.field === 'wine_type')).toHaveLength(0);
  });

  it('does not extract wine types from exact-lookup surface-explanation sentences', () => {
    const claims = extractClaims('보르게리(볼게리) 지역의 레드 와인을 뜻하는 표면 표현일 가능성이 있어요.');
    expect(claims.filter((c) => c.category === 'identity_claim')).toHaveLength(0);
    expect(claims.filter((c) => c.field === 'wine_type')).toHaveLength(0);
    expect(claims.filter((c) => c.field === 'region')).toHaveLength(0);
  });

  it('does not extract clarification example parentheticals as factual claims', () => {
    const claims = extractClaims('정확한 라벨명이나 병기된 표기(예: Moët & Chandon Rosé Impérial, 연도/버전/용량 등)를 알려주세요.');
    expect(claims.filter((c) => c.category === 'identity_claim')).toHaveLength(0);
    expect(claims.filter((c) => c.field === 'wine_type')).toHaveLength(0);
  });

  it('does not extract clarification example clauses as factual claims', () => {
    const claims = extractClaims('모엣 샹동 로제 브뤼 같은 정확한 라벨이나, 원하시는 스타일/빈티지/용도를 알려주세요.');
    expect(claims.filter((c) => c.category === 'identity_claim')).toHaveLength(0);
    expect(claims.filter((c) => c.field === 'wine_type')).toHaveLength(0);
  });

  it('does not extract clarification example lines as factual claims', () => {
    const claims = extractClaims('정확한 라벨이나 조건을 알려주세요. 예: 생산자명, 빈티지, 볼게리 내 특정 와인명, 또는 카베르네 소비뇽/메를로 같은 품종 조건.');
    expect(claims.filter((c) => c.category === 'identity_claim')).toHaveLength(0);
    expect(claims.filter((c) => c.field === 'grape_primary')).toHaveLength(0);
    expect(claims.filter((c) => c.field === 'region')).toHaveLength(0);
  });

  it('does not extract inline clarification examples as factual wine attributes', () => {
    const claims = extractClaims('정확한 라벨을 알려주시거나, 예를 들어 산지/빈티지/레드·화이트/등급 같은 조건을 함께 주시면 다시 확인해드릴게요.');
    expect(claims.filter((c) => c.field === 'wine_type')).toHaveLength(0);
    expect(claims.filter((c) => c.field === 'region')).toHaveLength(0);
  });

  it('does not extract multi-line clarification examples as factual claims', () => {
    const claims = extractClaims([
      '현재 증거만으로는 라피트(Château Lafite Rothschild)가 단일한 정확한 와인 엔티티로 확인되지 않았습니다.',
      '정확히 원하시는 라벨을 알려주시겠어요? 예를 들면:',
      '- Château Lafite Rothschild의 연도(vintage)',
      '- Pauillac / Bordeaux 같은 지역 또는 등급',
    ].join('\n'));
    expect(claims.filter((c) => c.category === 'identity_claim')).toHaveLength(0);
    expect(claims.filter((c) => c.field === 'region')).toHaveLength(0);
  });

  it('extracts comparative claims from explicit more-than statements', () => {
    const claims = extractClaims('Penfolds Grange is more powerful and concentrated than a traditional Barolo.');
    const comparative = claims.find((c) => c.category === 'comparative_claim');
    expect(comparative).toBeDefined();
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
