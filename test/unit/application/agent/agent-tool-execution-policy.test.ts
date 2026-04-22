import { describe, expect, it } from 'vitest';
import { createAgentExecutionState } from '../../../../src/application/agent/agent-execution-state.js';
import { AgentToolExecutionPolicy } from '../../../../src/application/agent/agent-tool-execution-policy.js';

describe('AgentToolExecutionPolicy', () => {
  it('preserves exact metadata search anchors while keeping explicit structured filters', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: { query: 'opus one', country: 'United States', vintage_min: 2018 },
      queryExecutionContract: { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: true },
    });

    expect(resolved).toEqual({
      query: 'opus one',
      country: 'United States',
      vintage_min: 2018,
    });
  });

  it('normalizes only eligible search calls inside parallel batches while preserving explicit filters', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveParallelBatch({
      calls: [
        { tool: 'search_wines', input: { query: 'opus one', country: 'United States' } },
        { tool: 'check_drinking_window', input: { entity_id: 'wine-1' } },
      ],
      queryExecutionContract: { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: true },
    });

    expect(resolved[0]).toEqual({
      tool: 'search_wines',
      input: {
        query: 'opus one',
        country: 'United States',
      },
    });
    expect(resolved[1]).toEqual({ tool: 'check_drinking_window', input: { entity_id: 'wine-1' } });
  });

  it('injects compare drinkability objective from the query execution contract', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'compare_wines',
      input: { query_a: 'Barolo', query_b: 'Brunello' },
      queryExecutionContract: { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: false },
    });

    expect(resolved).toEqual({
      query_a: 'Barolo',
      query_b: 'Brunello',
      drinking_window: 'now',
    });
  });

  it('does not overwrite explicit compare drinkability objective', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'compare_wines',
      input: { query_a: 'Barolo', query_b: 'Brunello', drinking_window: 'now', drinking_window_target_year: 2030 },
      queryExecutionContract: { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: false },
    });

    expect(resolved).toEqual({
      query_a: 'Barolo',
      query_b: 'Brunello',
      drinking_window: 'now',
      drinking_window_target_year: 2030,
    });
  });

  it('strips redundant side geography when compare sides are already fixed by appellation', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'compare_wines',
      input: {
        query_a: '바롤로',
        query_b: '브루넬로',
        region_a: 'Piedmont',
        region_b: 'Tuscany',
        country_a: 'Italy',
        country_b: 'Italy',
        appellation_a: 'Barolo',
        appellation_b: 'Brunello di Montalcino',
      },
      queryExecutionContract: { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: false },
    });

    expect(resolved).toEqual({
      query_a: '바롤로',
      query_b: '브루넬로',
      appellation_a: 'Barolo',
      appellation_b: 'Brunello di Montalcino',
      drinking_window: 'now',
    });
  });

  it('canonicalizes exact compare-side wine anchors and infers side-specific exact vintages', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'compare_wines',
      input: {
        query_a: '오푸스 원 2018',
        query_b: '알마비바 2019',
      },
      queryExecutionContract: { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: false },
    });

    expect(resolved).toEqual({
      query_a: 'opus one 2018',
      query_b: 'almaviva 2019',
      vintage_min_a: 2018,
      vintage_max_a: 2018,
      vintage_min_b: 2019,
      vintage_max_b: 2019,
      drinking_window: 'now',
    });
  });

  it('strips planner-invented side facets from exact compare-side SKU queries', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'compare_wines',
      input: {
        query_a: '오푸스 원 2018',
        query_b: '알마비바 2019',
        grape_primary_a: 'Cabernet Sauvignon',
        country_b: 'Chile',
      },
      queryExecutionContract: { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: false },
    });

    expect(resolved).toEqual({
      query_a: 'opus one 2018',
      query_b: 'almaviva 2019',
      vintage_min_a: 2018,
      vintage_max_a: 2018,
      vintage_min_b: 2019,
      vintage_max_b: 2019,
      drinking_window: 'now',
    });
  });

  it('strips search drinkability filters and consumed query objective when drinkability is verified by contract checks', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: {
        query: '이탈리아 레드 중에 평점 좋고 지금 마실 수 있는 거',
        wine_type: 'red',
        country: 'Italy',
        drinking_window: 'now',
        drinking_window_target_year: 2026,
      },
      queryExecutionContract: { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: true },
    });

    expect(resolved).toEqual({
      query: '이탈리아 레드 중에 평점 좋고',
      wine_type: 'red',
      country: 'Italy',
    });
  });

  it('removes non-exact entity overrides and speculative metadata preference fields from generic release queries', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: {
        query: '보졸레 누보',
        retrieval_mode: 'entity',
        country: 'France',
        region: 'Beaujolais',
        style: 'dry',
        styles: ['dry'],
        occasion: ['gift'],
        vintage_min: 2025,
        vintage_max: 2026,
        drinking_window: 'now',
      },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: true,
        hasTemporalReleaseSignal: true,
        temporalReleaseQuery: '보졸레누보',
        temporalReleaseConceptQuery: true,
      },
    });

    expect(resolved).toEqual({
      query: '보졸레누보',
    });
  });

  it('normalizes spaced temporal concept freshness queries down to the anchor only', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: {
        query: '보졸레 누보 올해 나왔는지 근거 없으면 모른다고만 해줘',
        retrieval_mode: 'entity',
        region: 'Beaujolais',
        wine_type: 'red',
      },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: true,
        hasTemporalReleaseSignal: true,
        temporalReleaseQuery: '보졸레 누보',
        temporalReleaseConceptQuery: true,
      },
    });

    expect(resolved).toEqual({
      query: '보졸레 누보',
    });
  });

  it('preserves exact entity plus requested vintage for future-vintage release lookups', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: {
        query: '알마비바',
        retrieval_mode: 'entity',
        country: 'Chile',
      },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: true,
        exactMetadataEntityQuery: '알마비바 2026 빈티지',
        hasTemporalReleaseSignal: true,
        exactMetadataTargetVintage: 2026,
      },
    });

    expect(resolved).toEqual({
      query: '알마비바 2026 빈티지',
      retrieval_mode: 'entity',
      vintage_min: 2026,
      vintage_max: 2026,
      limit: 1,
    });
  });

  it('normalizes English exact future-vintage release lookups to a stripped anchor plus exact vintage bounds', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: {
        query: 'Opus One 2027 vintage released yet? If you do not have hard evidence, say you do not know.',
        retrieval_mode: 'entity',
      },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: true,
        exactMetadataEntityQuery: 'Opus One 2027 vintage',
        exactMetadataTargetVintage: 2027,
      },
    });

    expect(resolved).toEqual({
      query: 'Opus One 2027 vintage',
      retrieval_mode: 'entity',
      vintage_min: 2027,
      vintage_max: 2027,
      limit: 1,
    });
  });

  it('reroutes search_wines to get_food_pairings when the query contract requires the pairing tool', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleCall({
      tool: 'search_wines',
      input: {
        query: '회 먹을 건데 와인 추천해줘',
        wine_type: 'white',
        styles: ['dry', 'light'],
      },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
        requiredTool: 'get_food_pairings',
        foodPairing: { food: '회 먹을 건데 와인 추천해줘', pairingTags: ['white_fish'] },
      },
    });

    expect(resolved).toEqual({
      tool: 'get_food_pairings',
        input: {
          food: '회 먹을 건데 와인 추천해줘',
          color: 'white',
          styles: ['dry', 'light'],
          pairing_tags: ['white_fish'],
        },
      });
  });

  it('keeps price-constrained food-pairing searches on search_wines so budget filtering stays explicit', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleCall({
      tool: 'search_wines',
      input: {
        query: '스테이크에 어울리는 와인 중에 10만원 이하로',
        wine_type: 'red',
        max_price_krw: 100_000,
      },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
        requiredTool: 'get_food_pairings',
        foodPairing: { food: '스테이크에 어울리는 와인 중에 10만원 이하로', pairingTags: ['beef'] },
      },
    });

    expect(resolved).toEqual({
      tool: 'search_wines',
      input: {
        query: '스테이크에 어울리는 와인 중에 10만원 이하로',
        wine_type: 'red',
        max_price_krw: 100_000,
        styles: ['beef'],
      },
    });
  });

  it('reconstructs explicit price caps from the query contract before resolving pairing searches', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleCall({
      tool: 'search_wines',
      input: {
        query: '스테이크에 어울리는 와인 중에 10만원 이하로',
        wine_type: 'red',
      },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
        requiredTool: 'get_food_pairings',
        foodPairing: { food: '스테이크에 어울리는 와인 중에 10만원 이하로', pairingTags: ['beef'] },
        searchDefaults: { max_price_krw: 100_000 },
      },
    });

    expect(resolved).toEqual({
      tool: 'search_wines',
      input: {
        query: '스테이크에 어울리는 와인 중에 10만원 이하로',
        wine_type: 'red',
        max_price_krw: 100_000,
        styles: ['beef'],
      },
    });
  });

  it('keeps explicit get_food_pairings calls intact even when price hints are present', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleCallExpansion({
      tool: 'get_food_pairings',
      input: {
        food: '스테이크',
        max_price_krw: 100_000,
        color: 'red',
      },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
        requiredTool: 'get_food_pairings',
        foodPairing: { food: '스테이크에 어울리는 와인 중에 10만원 이하로', pairingTags: ['beef'] },
      },
    });

    expect(resolved).toBeUndefined();
  });

  it('preserves explicit search_wines in a parallel batch even when a pairing contract is active', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveParallelBatch({
      calls: [
        { tool: 'search_wines', input: { query: 'bold red wine' } },
        { tool: 'get_food_pairings', input: { food: 'steak' } },
      ],
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
        requiredTool: 'get_food_pairings',
        foodPairing: { food: 'steak', pairingTags: ['beef'] },
      },
    });

    expect(resolved).toEqual([
      { tool: 'search_wines', input: { query: 'bold red wine' } },
      { tool: 'get_food_pairings', input: { food: 'steak', pairing_tags: ['beef'] } },
    ]);
  });

  it('enriches spicy food-pairing contracts with typed pairing objective fields', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleCall({
      tool: 'search_wines',
      input: { query: '매운 떡볶이랑 먹을 수 있는 와인 있어?' },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
        requiredTool: 'get_food_pairings',
        foodPairing: { food: '매운 떡볶이랑 먹을 수 있는 와인 있어?', pairingTags: ['spicy_food'] },
      },
    });

    expect(resolved).toEqual({
      tool: 'get_food_pairings',
      input: {
        food: '매운 떡볶이랑 먹을 수 있는 와인 있어?',
        styles: ['off_dry', 'sweet'],
        pairing_tags: ['spicy_food'],
      },
    });
  });

  it('merges canonical pairing tags into direct food-pairing calls instead of trusting planner-only tags', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleCall({
      tool: 'get_food_pairings',
      input: {
        food: '매운 떡볶이',
        styles: ['refreshing'],
        pairing_tags: ['spicy', 'street-food'],
      },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
        requiredTool: 'get_food_pairings',
        foodPairing: { food: '매운 떡볶이랑 먹을 수 있는 와인 있어?', pairingTags: ['spicy_food'] },
      },
    });

    expect(resolved).toEqual({
      tool: 'get_food_pairings',
      input: {
        food: '매운 떡볶이',
        styles: ['refreshing', 'off_dry', 'sweet'],
        pairing_tags: ['spicy', 'street-food', 'spicy_food'],
      },
    });
  });

  it('removes planner-invented red color when spicy food requires heat-balance styles', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleCall({
      tool: 'get_food_pairings',
      input: {
        food: '매운 떡볶이',
        color: 'red',
        pairing_tags: ['spicy_food'],
      },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
        requiredTool: 'get_food_pairings',
        foodPairing: { food: '매운 떡볶이랑 먹을 수 있는 와인 있어?', pairingTags: ['spicy_food'] },
      },
    });

    expect(resolved).toEqual({
      tool: 'get_food_pairings',
      input: {
        food: '매운 떡볶이',
        styles: ['off_dry', 'sweet'],
        pairing_tags: ['spicy_food'],
      },
    });
  });

  it('does not expand price-constrained get_food_pairings calls into an extra search step', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleCallExpansion({
      tool: 'get_food_pairings',
      input: {
        food: '스테이크',
        max_price_krw: 100_000,
        color: 'red',
      },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
        requiredTool: 'get_food_pairings',
        foodPairing: { food: '스테이크에 어울리는 와인 중에 10만원 이하로', pairingTags: ['beef'] },
      },
    });

    expect(resolved).toBeUndefined();
  });

  it('expands price-constrained pairing searches into pairing plus budget-filtered search calls', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleCallExpansion({
      tool: 'search_wines',
      input: {
        query: '스테이크에 어울리는 와인 중에 10만원 이하로',
        wine_type: 'red',
        max_price_krw: 100_000,
      },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
        requiredTool: 'get_food_pairings',
        foodPairing: { food: '스테이크에 어울리는 와인 중에 10만원 이하로', pairingTags: ['beef'] },
      },
    });

    expect(resolved).toEqual([
      {
        tool: 'get_food_pairings',
        input: {
          food: '스테이크에 어울리는 와인 중에 10만원 이하로',
          color: 'red',
          max_price_krw: 100_000,
          pairing_tags: ['beef'],
        },
      },
      {
        tool: 'search_wines',
        input: {
          query: '스테이크에 어울리는 와인 중에 10만원 이하로',
          wine_type: 'red',
          max_price_krw: 100_000,
          styles: ['beef'],
        },
      },
    ]);
  });

  it('expands reconstructed-budget pairing searches even when the planner omitted explicit max_price_krw', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleCallExpansion({
      tool: 'search_wines',
      input: {
        query: '스테이크에 어울리는 와인 중에 10만원 이하로',
        wine_type: 'red',
      },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
        requiredTool: 'get_food_pairings',
        foodPairing: { food: '스테이크에 어울리는 와인 중에 10만원 이하로', pairingTags: ['beef'] },
        searchDefaults: { max_price_krw: 100_000 },
      },
    });

    expect(resolved).toEqual([
      {
        tool: 'get_food_pairings',
        input: {
          food: '스테이크에 어울리는 와인 중에 10만원 이하로',
          color: 'red',
          max_price_krw: 100_000,
          pairing_tags: ['beef'],
        },
      },
      {
        tool: 'search_wines',
        input: {
          query: '스테이크에 어울리는 와인 중에 10만원 이하로',
          wine_type: 'red',
          max_price_krw: 100_000,
          styles: ['beef'],
        },
      },
    ]);
  });

  it('removes explicit negated color text from the search anchor once wine_type carries the positive color', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: { query: '레드 말고 화이트로 ㄱ', wine_type: 'white', want_diversity: true },
      queryExecutionContract: { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
    });

    expect(resolved).toEqual({
      query: '화이트로 ㄱ',
      wine_type: 'white',
      want_diversity: true,
    });
  });

  it('applies explicit situational query defaults to search_wines inputs', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: { query: '캠핑 가는데 스크류캡이고 차갑게 마실 수 있는 거' },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
        searchDefaults: {
          styles: ['screw_cap', 'chillable'],
          occasion: ['camping'],
        },
      },
    });

    expect(resolved).toEqual({
      query: '캠핑 가는데 스크류캡이고 차갑게 마실 수 있는 거',
      styles: ['screw_cap', 'chillable'],
      occasion: ['camping'],
    });
  });

  it('applies explicit grape defaults to varietal recommendation queries', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: { query: '까쇼 추천해줘', wine_type: 'red' },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
        searchDefaults: {
          grape_primary: 'Cabernet Sauvignon',
        },
      },
    });

    expect(resolved).toEqual({
      query: '까쇼 추천해줘',
      wine_type: 'red',
      grape_primary: 'Cabernet Sauvignon',
    });
  });

  it('applies formal gift price floors and prestige defaults without weakening explicit caps', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: {
        query: '직장 상사 승진 선물, 품격 있고 무난한 거',
        max_price_krw: 100_000,
        style: 'approachable',
      },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
        searchDefaults: {
          styles: ['crowd_pleasing'],
          occasion: ['gift'],
          min_price_krw: 50_000,
          max_price_krw: 150_000,
          gift_suitability_min: 0.75,
          producer_prestige_min: 0.7,
        },
      },
    });

    expect(resolved).toEqual({
      query: '직장 상사 승진 선물, 품격 있고 무난한 거',
      max_price_krw: 100_000,
      min_price_krw: 50_000,
      style: 'approachable',
      styles: ['crowd_pleasing'],
      occasion: ['gift'],
      gift_suitability_min: 0.75,
      producer_prestige_min: 0.7,
    });
  });

  it('removes top-level regions from the appellation field while preserving the query anchor', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: {
        query: 'best Bordeaux under 100 dollars',
        max_price_krw: 135_000,
        country: 'France',
        appellation: 'Bordeaux',
      },
      queryExecutionContract: { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
    });

    expect(resolved).toEqual({
      query: 'best Bordeaux under 100 dollars',
      max_price_krw: 135_000,
      country: 'France',
    });
  });

  it('normalizes accessible online tasting searches away from party occasion overconstraint', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: {
        query: '온라인 와인 시음회 준비, 참가자 모두가 살 수 있는 거',
        max_price_krw: 50_000,
        style: 'approachable',
        occasion: ['party'],
      },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
        searchDefaults: {
          styles: ['approachable', 'crowd_pleasing'],
          max_price_krw: 50_000,
        },
      },
    });

    expect(resolved).toEqual({
      query: '온라인 와인 시음회 준비, 참가자 모두가 살 수 있는 거',
      max_price_krw: 50_000,
      style: 'approachable',
      styles: ['approachable', 'crowd_pleasing'],
    });
  });

  it('expands explicit red plus white single searches into typed parallel slots', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleCallExpansion({
      tool: 'search_wines',
      input: { query: '커플 세트로 레드 화이트 한 병씩, 예쁜 거', occasion: ['gift'] },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
        requiredParallelSearches: [
          { wineType: 'red', limit: 1 },
          { wineType: 'white', limit: 1 },
        ],
      },
    });

    expect(resolved).toEqual([
      {
        tool: 'search_wines',
        input: {
          query: '커플 세트로 레드 한 병씩 예쁜 거',
          occasion: ['gift'],
          wine_type: 'red',
          limit: 1,
        },
      },
      {
        tool: 'search_wines',
        input: {
          query: '커플 세트로 화이트 한 병씩 예쁜 거',
          occasion: ['gift'],
          wine_type: 'white',
          limit: 1,
        },
      },
    ]);
  });

  it('splits explicit total budget across repaired red plus white slots', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleCallExpansion({
      tool: 'search_wines',
      input: {
        query: '회사 회식 10명, 레드/화이트 반반, 총 20만원',
        max_price_krw: 200_000,
        occasion: ['party'],
      },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
        totalBudgetKrw: 200_000,
        requiredParallelSearches: [
          { wineType: 'red' },
          { wineType: 'white' },
        ],
      },
    });

    expect(resolved).toEqual([
      {
        tool: 'search_wines',
        input: {
          query: '회사 회식 10명 레드 총 20만원',
          max_price_krw: 100_000,
          occasion: ['party'],
          wine_type: 'red',
        },
      },
      {
        tool: 'search_wines',
        input: {
          query: '회사 회식 10명 화이트 총 20만원',
          max_price_krw: 100_000,
          occasion: ['party'],
          wine_type: 'white',
        },
      },
    ]);
  });

  it('repairs explicit total budget across planner-emitted parallel color slots', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveParallelBatch({
      calls: [
        {
          tool: 'search_wines',
          input: {
            query: '회사 회식 10명 레드 총 20만원',
            wine_type: 'red',
            min_price_krw: 10_000,
            max_price_krw: 20_000,
          },
        },
        {
          tool: 'search_wines',
          input: {
            query: '회사 회식 10명 화이트 총 20만원',
            wine_type: 'white',
            min_price_krw: 10_000,
            max_price_krw: 20_000,
          },
        },
      ],
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
        totalBudgetKrw: 200_000,
        requiredParallelSearches: [
          { wineType: 'red' },
          { wineType: 'white' },
        ],
      },
    });

    expect(resolved).toEqual([
      {
        tool: 'search_wines',
        input: {
          query: '회사 회식 10명 레드 총 20만원',
          wine_type: 'red',
          max_price_krw: 100_000,
        },
      },
      {
        tool: 'search_wines',
        input: {
          query: '회사 회식 10명 화이트 총 20만원',
          wine_type: 'white',
          max_price_krw: 100_000,
        },
      },
    ]);
  });

  it('preserves eligible search_wines calls inside parallel batches', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveParallelBatch({
      calls: [
        { tool: 'search_wines', input: { query: '치맥 대신 치킨이랑 마실 와인' } },
        { tool: 'search_wines', input: { query: '가성비 레드', wine_type: 'red' } },
      ],
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
        requiredTool: 'get_food_pairings',
        foodPairing: { food: '치맥 대신 치킨이랑 마실 와인', pairingTags: ['chicken'] },
      },
    });

    expect(resolved[0]).toEqual({
      tool: 'search_wines',
      input: { query: '치맥 대신 치킨이랑 마실 와인' },
    });
    expect(resolved[1]).toEqual({
      tool: 'search_wines',
      input: { query: '가성비 레드', wine_type: 'red' },
    });
  });

  it('normalizes colloquial Korean exact-metadata search into exact lookup input', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: { query: '오푸스원 얼마야?', country: 'United States' },
      queryExecutionContract: { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: true },
    });

    expect(resolved).toEqual({ query: '오푸스원 얼마야?', limit: 1 });
  });

  it('injects refinement hint only once when no-match observations appear with enough remaining steps', () => {
    const policy = new AgentToolExecutionPolicy();
    const state = createAgentExecutionState();

    policy.maybeInjectRefinementHint(state, ['검색 결과가 없습니다'], 3);
    const firstDirective = state.pendingPlannerDirective;
    policy.maybeInjectRefinementHint(state, ['NO_MATCH: none'], 5);

    expect(firstDirective).toEqual({ kind: 'relax_constraints_retry' });
    expect(state.pendingPlannerDirective).toBe(firstDirective);
    expect(state.hasInjectedRefinementHint).toBe(true);
  });

  it('does not inject refinement hint when remaining step budget is too low', () => {
    const policy = new AgentToolExecutionPolicy();
    const state = createAgentExecutionState();

    policy.maybeInjectRefinementHint(state, ['검색 결과가 없습니다'], 1);

    expect(state.hasInjectedRefinementHint).toBe(false);
    expect(state.pendingPlannerDirective).toBeUndefined();
  });

  it('injects refinement hint when remaining step budget is enough', () => {
    const policy = new AgentToolExecutionPolicy();
    const state = createAgentExecutionState();

    policy.maybeInjectRefinementHint(state, ['검색 결과가 없습니다'], 2);

    expect(state.hasInjectedRefinementHint).toBe(true);
    expect(state.pendingPlannerDirective).toEqual({ kind: 'relax_constraints_retry' });
  });

});
