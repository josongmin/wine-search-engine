import { describe, expect, it } from 'vitest';
import { createAgentExecutionState } from '../../../../src/application/agent/agent-execution-state.js';
import { AgentToolExecutionPolicy } from '../../../../src/application/agent/agent-tool-execution-policy.js';

describe('AgentToolExecutionPolicy', () => {
  it('normalizes exact metadata search anchors while removing non-vintage overconstraints', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: { query: 'opus one', country: 'United States', vintage_min: 2018 },
      queryExecutionContract: { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: true },
    });

    expect(resolved).toEqual({
      query: 'Opus One',
      vintage_min: 2018,
      retrieval_mode: 'entity',
    });
  });

  it('normalizes only eligible search calls inside parallel batches while removing exact lookup overconstraints', () => {
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
        query: 'Opus One',
        retrieval_mode: 'entity',
      },
    });
    expect(resolved[1]).toEqual({ tool: 'check_drinking_window', input: { entity_id: 'wine-1' } });
  });

  it('collapses Korean exact-label suffix noise to the canonical exact entity anchor', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: {
        query: '샤또 마고 보르도',
        retrieval_mode: 'entity',
        country: 'France',
        region: 'Bordeaux',
        wine_type: 'red',
        styles: ['classic'],
      },
      queryExecutionContract: { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
    });

    expect(resolved).toEqual({
      query: 'Chateau Margaux',
      retrieval_mode: 'entity',
    });
  });

  it('preserves exact vintage bounds while collapsing exact-label suffix noise', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: {
        query: '샤또페트루스 2016',
        retrieval_mode: 'entity',
        vintage_min: 2016,
        vintage_max: 2016,
        country: 'France',
        region: 'Bordeaux',
      },
      queryExecutionContract: { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
    });

    expect(resolved).toEqual({
      query: 'Petrus',
      retrieval_mode: 'entity',
      vintage_min: 2016,
      vintage_max: 2016,
    });
  });

  it('injects compare drinkability objective from the query execution contract', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'compare_wines',
      input: { query_a: 'Barolo', query_b: 'Brunello' },
      queryExecutionContract: {
        requiresDrinkabilityCheck: true,
        hasEntityMetadataSignal: false,
        searchDefaults: { drinking_window: 'now', drinking_window_target_year: 2026 },
      },
    });

    expect(resolved).toEqual({
      query_a: 'Barolo',
      query_b: 'Brunello',
      drinking_window: 'now',
      drinking_window_target_year: 2026,
    });
  });

  it('does not overwrite explicit compare drinkability objective', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'compare_wines',
      input: { query_a: 'Barolo', query_b: 'Brunello', drinking_window: 'now', drinking_window_target_year: 2030 },
      queryExecutionContract: {
        requiresDrinkabilityCheck: true,
        hasEntityMetadataSignal: false,
        searchDefaults: { drinking_window: 'now', drinking_window_target_year: 2026 },
      },
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
      queryExecutionContract: {
        requiresDrinkabilityCheck: true,
        hasEntityMetadataSignal: false,
        searchDefaults: { drinking_window: 'now', drinking_window_target_year: 2026 },
      },
    });

    expect(resolved).toEqual({
      query_a: '바롤로',
      query_b: '브루넬로',
      appellation_a: 'Barolo',
      appellation_b: 'Brunello di Montalcino',
      drinking_window: 'now',
      drinking_window_target_year: 2026,
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
      queryExecutionContract: {
        requiresDrinkabilityCheck: true,
        hasEntityMetadataSignal: false,
        searchDefaults: { drinking_window: 'now', drinking_window_target_year: 2026 },
      },
    });

    expect(resolved).toEqual({
      query_a: 'opus one 2018',
      query_b: 'almaviva 2019',
      vintage_min_a: 2018,
      vintage_max_a: 2018,
      vintage_min_b: 2019,
      vintage_max_b: 2019,
      drinking_window: 'now',
      drinking_window_target_year: 2026,
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
      queryExecutionContract: {
        requiresDrinkabilityCheck: true,
        hasEntityMetadataSignal: false,
        searchDefaults: { drinking_window: 'now', drinking_window_target_year: 2026 },
      },
    });

    expect(resolved).toEqual({
      query_a: 'opus one 2018',
      query_b: 'almaviva 2019',
      vintage_min_a: 2018,
      vintage_max_a: 2018,
      vintage_min_b: 2019,
      vintage_max_b: 2019,
      drinking_window: 'now',
      drinking_window_target_year: 2026,
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
      queryExecutionContract: {
        requiresDrinkabilityCheck: true,
        hasEntityMetadataSignal: true,
        searchDefaults: { drinking_window: 'now', drinking_window_target_year: 2026 },
      },
    });

    expect(resolved).toEqual({
      query: '이탈리아 레드 중에 평점 좋고',
      wine_type: 'red',
      country: 'Italy',
      drinking_window: 'now',
      drinking_window_target_year: 2026,
    });
  });

  it('normalizes direct exact-entity lookup suffixes to the bare entity plus exact vintage bounds', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: {
        query: 'Tignanello 2019 정보',
      },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: true,
        exactMetadataEntityQuery: 'Tignanello 2019',
        exactMetadataTargetVintage: 2019,
      },
    });

    expect(resolved).toEqual({
      query: 'Tignanello 2019',
      retrieval_mode: 'entity',
      vintage_min: 2019,
      vintage_max: 2019,
      limit: 1,
    });
  });

  it('forces entity retrieval for curated Korean transliteration exact labels with generic object suffix only', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: { query: '사씨카이아 와인' },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
      },
    });

    expect(resolved).toEqual({
      query: 'Sassicaia',
      retrieval_mode: 'entity',
    });
  });

  it('does not force entity retrieval for non-exact recommendation intent around a known label', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: { query: '사씨카이아' },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
        nonExactEntityLookupQuery: '사씨카이아 스타일',
      },
    });

    expect(resolved).toEqual({ query: '사씨카이아 스타일' });
  });

  it('does not inject now-drinkability retrieval objectives for cellar-worthiness comparisons', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'compare_wines',
      input: { query_a: 'Barolo', query_b: 'Brunello' },
      queryExecutionContract: {
        requiresDrinkabilityCheck: true,
        hasEntityMetadataSignal: false,
        searchDefaults: { occasion: ['cellaring'], styles: ['ageworthy'] },
      },
    });

    expect(resolved).toEqual({
      query_a: 'Barolo',
      query_b: 'Brunello',
    });
  });

  it('strips generic now-drinkability objective text and keeps a vintage-only lexical anchor', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: {
        query: '2015년산 중에 지금 바로 마셔야 하는 거 있어?',
        retrieval_mode: 'auto',
        vintage_min: 2015,
        vintage_max: 2015,
      },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
        searchDefaults: { drinking_window: 'now', drinking_window_target_year: 2026 },
      },
    });

    expect(resolved).toEqual({
      query: '2015년산 와인',
      retrieval_mode: 'auto',
      vintage_min: 2015,
      vintage_max: 2015,
      drinking_window: 'now',
      drinking_window_target_year: 2026,
    });
  });

  it('strips generic cellaring objective text and leaves only the lexical anchor', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: {
        query: '셀러에 넣어둘 만한 거, 지금 마시면 아까운 와인',
        limit: 3,
        want_diversity: true,
      },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
        searchDefaults: { occasion: ['cellaring'], styles: ['ageworthy'] },
      },
    });

    expect(resolved).toEqual({
      query: '와인',
      limit: 3,
      occasion: ['cellaring'],
      styles: ['ageworthy'],
    });
  });

  it('strips sentimental birth-year cellaring wrapper and preserves the exact vintage anchor', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: {
        query: '아이 태어난 해 와인 사서 성인 될 때 같이 마시려고, 2024년산',
        vintage_min: 2024,
        vintage_max: 2024,
      },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
        searchDefaults: { occasion: ['cellaring'], styles: ['ageworthy'] },
      },
    });

    expect(resolved).toEqual({
      query: '2024년산 와인',
      vintage_min: 2024,
      vintage_max: 2024,
      occasion: ['cellaring'],
      styles: ['ageworthy'],
    });
  });

  it('preserves entity retrieval mode for bare exact label searches', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: {
        query: '모엣샹동 로제 임페리얼',
        retrieval_mode: 'entity',
      },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
      },
    });

    expect(resolved).toEqual({
      query: 'moet chandon rose imperial',
      retrieval_mode: 'entity',
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

  it('preserves parallel search query identity when the route contract has a global entity anchor', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveParallelBatch({
      calls: [
        { tool: 'search_wines', input: { query: 'Barolo' } },
        { tool: 'search_wines', input: { query: 'Burgundy' } },
        { tool: 'get_food_pairings', input: { food: 'lamb' } },
      ],
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: true,
        exactMetadataEntityQuery: 'wine',
        requiredTool: 'get_food_pairings',
        foodPairing: { food: 'lamb', pairingTags: ['lamb'] },
      },
    });

    expect(resolved).toEqual([
      { tool: 'search_wines', input: { query: 'Barolo', retrieval_mode: 'entity', limit: 1 } },
      { tool: 'search_wines', input: { query: 'Burgundy', retrieval_mode: 'entity', limit: 1 } },
      { tool: 'get_food_pairings', input: { food: 'lamb', pairing_tags: ['lamb'] } },
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
      exclude_wine_types: ['red'],
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
      popularity_min: 0.5,
    });
  });

  it('removes special_occasion from accessible online tasting recommendation searches', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: {
        query: '온라인 와인 시음회 준비, 참가자 모두가 살 수 있는 거',
        max_price_krw: 50_000,
        occasion: ['special_occasion'],
      },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
      },
    });

    expect(resolved).toEqual({
      query: '온라인 와인 시음회 준비, 참가자 모두가 살 수 있는 거',
      max_price_krw: 50_000,
      styles: ['approachable', 'crowd_pleasing'],
      popularity_min: 0.5,
    });
  });

  it('strips planner-invented situation overrides that are unsupported by deterministic search defaults', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: {
        query: '와인 처음 마시는 부모님께 추천할 와인',
        style: 'sweet',
        styles: ['approachable', 'crowd_pleasing', 'sweet'],
        occasion: ['gift', 'date_night'],
        gift_suitability_min: 0.8,
        beginner_suitability_min: 0.9,
        want_diversity: true,
      },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
        searchDefaults: {
          styles: ['approachable', 'crowd_pleasing'],
          recipient_profile: 'parents_first_time',
          beginner_suitability_min: 0.65,
          sweetness_min: 0.2,
          sweetness_max: 0.75,
          acidity_max: 0.75,
          tannin_max: 0.3,
        },
      },
    });

    expect(resolved).toEqual({
      query: '와인 처음 마시는 부모님께 추천할 와인',
      styles: ['approachable', 'crowd_pleasing'],
      recipient_profile: 'parents_first_time',
      beginner_suitability_min: 0.65,
      sweetness_min: 0.2,
      sweetness_max: 0.75,
      acidity_max: 0.75,
      tannin_max: 0.3,
    });
  });

  it('preserves explicit diversity requests even when situation defaults exist', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: {
        query: '와인 처음 마시는 부모님께 다양하게 추천할 와인',
        want_diversity: true,
      },
      queryExecutionContract: {
        requiresDrinkabilityCheck: false,
        hasEntityMetadataSignal: false,
        searchDefaults: {
          styles: ['approachable', 'crowd_pleasing'],
          recipient_profile: 'parents_first_time',
          beginner_suitability_min: 0.65,
          sweetness_min: 0.2,
          sweetness_max: 0.75,
          acidity_max: 0.75,
          tannin_max: 0.3,
        },
      },
    });

    expect(resolved).toEqual({
      query: '와인 처음 마시는 부모님께 다양하게 추천할 와인',
      styles: ['approachable', 'crowd_pleasing'],
      recipient_profile: 'parents_first_time',
      beginner_suitability_min: 0.65,
      sweetness_min: 0.2,
      sweetness_max: 0.75,
      acidity_max: 0.75,
      tannin_max: 0.3,
      want_diversity: true,
    });
  });

  it('strips unsupported planner styles from formal senior-colleague gift searches', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: {
        query: '직장 상사 승진 선물, 품격 있고 무난한 거',
        styles: ['approachable', 'crowd_pleasing'],
        producer_prestige_min: 0.75,
        beginner_suitability_min: 0.7,
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
      styles: ['crowd_pleasing'],
      occasion: ['gift'],
      min_price_krw: 50_000,
      max_price_krw: 150_000,
      gift_suitability_min: 0.75,
      producer_prestige_min: 0.7,
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
          wine_type: 'red',
        },
      },
      {
        tool: 'search_wines',
        input: {
          query: '회사 회식 10명 화이트 총 20만원',
          max_price_krw: 100_000,
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

  it('normalizes planner-emitted parallel gift slots to slot-local anchors while preserving gift suitability', () => {
    const policy = new AgentToolExecutionPolicy();

    const resolved = policy.resolveParallelBatch({
      calls: [
        {
          tool: 'search_wines',
          input: {
            query: '커플 세트 레드 화이트 예쁜 거',
            wine_type: 'red',
            occasion: ['gift'],
          },
        },
        {
          tool: 'search_wines',
          input: {
            query: '커플 세트 레드 화이트 예쁜 거',
            wine_type: 'white',
            occasion: ['gift'],
          },
        },
      ],
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
          query: '커플 세트 레드 예쁜 거',
          wine_type: 'red',
          occasion: ['gift'],
        },
      },
      {
        tool: 'search_wines',
        input: {
          query: '커플 세트 화이트 예쁜 거',
          wine_type: 'white',
          occasion: ['gift'],
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

    expect(resolved).toEqual({ query: 'Opus One', retrieval_mode: 'entity', limit: 1 });
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
