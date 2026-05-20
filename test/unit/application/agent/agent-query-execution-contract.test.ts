import { describe, expect, it } from 'vitest';
import {
  buildAgentQueryExecutionContract,
  extractPendingDrinkabilityEntityIds,
  hasBareExactEntityAnchor,
  isExactMetadataEntityLookupCandidate,
  isSpecificSkuLikeQuery,
  normalizeExactMetadataSearchInput,
} from '../../../../src/application/agent/agent-query-execution-contract.js';
import type { AgentStep } from '../../../../src/domain/agent/model/agent-step.js';
import type { ToolOutcome } from '../../../../src/domain/agent/model/tool-outcome.js';

describe('agent query execution contract', () => {
  it('classifies drinkability and entity-metadata signals from normalized Korean queries', () => {
    expect(buildAgentQueryExecutionContract('오푸스원 지금 마시기 좋아?')).toMatchObject({
      requiresDrinkabilityCheck: true,
      hasEntityMetadataSignal: true,
      exactMetadataEntityQuery: '오푸스원',
    });
    expect(buildAgentQueryExecutionContract('오푸스원 가격 얼마야')).toMatchObject({
      requiresDrinkabilityCheck: false,
      hasEntityMetadataSignal: true,
      exactMetadataEntityQuery: '오푸스원',
    });
    expect(buildAgentQueryExecutionContract('오퍼스원 얼마야?')).toMatchObject({
      requiresDrinkabilityCheck: false,
      hasEntityMetadataSignal: true,
      exactMetadataEntityQuery: '오퍼스원',
    });
    expect(buildAgentQueryExecutionContract('보졸레누보 올해꺼 나왔는지 확실한 근거 없으면 추정하지 말고 말해줘')).toMatchObject({
      requiresDrinkabilityCheck: false,
      hasEntityMetadataSignal: true,
      requiresGroundedWineSearch: true,
      hasTemporalReleaseSignal: true,
      temporalReleaseQuery: '보졸레누보',
      temporalReleaseConceptQuery: true,
    });
    expect(buildAgentQueryExecutionContract('보졸레 누보 올해 나왔는지 근거 없으면 모른다고만 해줘')).toMatchObject({
      requiresDrinkabilityCheck: false,
      hasEntityMetadataSignal: true,
      requiresGroundedWineSearch: true,
      hasTemporalReleaseSignal: true,
      temporalReleaseQuery: '보졸레 누보',
      temporalReleaseConceptQuery: true,
    });
    expect(buildAgentQueryExecutionContract('보졸레누보 나왔냐')).toMatchObject({
      requiresDrinkabilityCheck: false,
      hasEntityMetadataSignal: true,
      requiresGroundedWineSearch: true,
      hasTemporalReleaseSignal: true,
      temporalReleaseQuery: '보졸레누보',
      temporalReleaseConceptQuery: true,
    });
    expect(buildAgentQueryExecutionContract('알마비바 2026 빈티지 나왔는지 확실한 근거 없으면 추정하지 말고 말해줘')).toMatchObject({
      requiresDrinkabilityCheck: false,
      hasEntityMetadataSignal: true,
      requiresGroundedWineSearch: true,
      exactMetadataEntityQuery: '알마비바 2026 빈티지',
      exactMetadataTargetVintage: 2026,
    });
    expect(buildAgentQueryExecutionContract('Opus One 2027 vintage released yet? If you do not have hard evidence, say you do not know.')).toMatchObject({
      requiresDrinkabilityCheck: false,
      hasEntityMetadataSignal: true,
      exactMetadataEntityQuery: 'Opus One 2027',
      exactMetadataTargetVintage: 2027,
    });
    expect(buildAgentQueryExecutionContract('Sassicaia 2025 release 있나? 확실한 근거 없으면 추정하지 말고 말해줘')).toMatchObject({
      requiresDrinkabilityCheck: false,
      hasEntityMetadataSignal: true,
      exactMetadataEntityQuery: 'Sassicaia 2025',
      exactMetadataTargetVintage: 2025,
    });
    expect(buildAgentQueryExecutionContract('Tignanello 2019 정보')).toMatchObject({
      requiresDrinkabilityCheck: false,
      hasEntityMetadataSignal: true,
      exactMetadataEntityQuery: 'Tignanello 2019',
      exactMetadataTargetVintage: 2019,
    });
    expect(buildAgentQueryExecutionContract('돔페리뇽 추천해줘')).toMatchObject({
      requiresDrinkabilityCheck: false,
      hasEntityMetadataSignal: true,
      exactMetadataEntityQuery: '돔페리뇽',
    });
    expect(buildAgentQueryExecutionContract('페트뤼스 와인 추천')).toMatchObject({
      requiresDrinkabilityCheck: false,
      hasEntityMetadataSignal: false,
      nonExactEntityLookupQuery: '페트뤼스 와인 추천',
    });
  });

  it('does not escalate generic mood recommendation wording into a drinkability contract', () => {
    expect(buildAgentQueryExecutionContract('우울할 때 마시기 좋은 와인')).toEqual({
      requiresDrinkabilityCheck: false,
      hasEntityMetadataSignal: true,
    });
    expect(buildAgentQueryExecutionContract('힐링되는 와인 한 잔 추천해줘')).toEqual({
      requiresDrinkabilityCheck: false,
      hasEntityMetadataSignal: false,
      searchDefaults: {
        styles: ['approachable'],
        occasion: ['healing'],
        beginner_suitability_min: 0.65,
      },
    });
  });

  it('requires grounded search for generic decanting guidance without a specific wine anchor', () => {
    expect(buildAgentQueryExecutionContract('디캔팅 해야 되는 와인이면 미리 알려줘')).toEqual({
      requiresDrinkabilityCheck: false,
      hasEntityMetadataSignal: false,
      requiresGroundedWineSearch: true,
    });
  });

  it('requires grounded search for Korean exact label spans with region suffix noise', () => {
    expect(buildAgentQueryExecutionContract('샤또 마고 보르도')).toMatchObject({
      requiresDrinkabilityCheck: false,
      hasEntityMetadataSignal: false,
      requiresGroundedWineSearch: true,
      searchDefaults: {
        region: 'Bordeaux',
      },
    });
  });

  it('requires the food-pairing tool for single-dish pairing requests from the pairing taxonomy', () => {
    expect(buildAgentQueryExecutionContract('스테이크에 어울리는 와인')).toMatchObject({
      requiresDrinkabilityCheck: false,
      hasEntityMetadataSignal: false,
      requiredTool: 'get_food_pairings',
      foodPairing: {
        food: '스테이크에 어울리는 와인',
        pairingTags: ['beef'],
      },
    });
    expect(buildAgentQueryExecutionContract('치맥 대신 치킨이랑 마실 와인')).toMatchObject({
      requiresDrinkabilityCheck: false,
      hasEntityMetadataSignal: false,
      requiredTool: 'get_food_pairings',
      foodPairing: {
        food: '치맥 대신 치킨이랑 마실 와인',
        pairingTags: ['chicken'],
      },
    });
    expect(buildAgentQueryExecutionContract('회 먹을 건데 와인 추천해줘')).toMatchObject({
      requiredTool: 'get_food_pairings',
      foodPairing: {
        pairingTags: ['white_fish'],
      },
    });
    expect(buildAgentQueryExecutionContract('삼겹살이랑 와인 조합 추천')).toMatchObject({
      requiredTool: 'get_food_pairings',
      foodPairing: {
        pairingTags: ['pork'],
      },
    });
  });

  it('does not force the pairing tool for mixed-color or decomposed food requests', () => {
    expect(buildAgentQueryExecutionContract('회사 회식 10명, 레드/화이트 반반, 총 20만원')).not.toHaveProperty('requiredTool');
    expect(buildAgentQueryExecutionContract('피노 누아르 vs 가메이, 어떤 게 치킨에 더 맞아?')).not.toHaveProperty('requiredTool');
  });

  it('builds typed search defaults for explicit situational semantics', () => {
    expect(buildAgentQueryExecutionContract('이탈리아 레드 중에 평점 좋고 지금 마실 수 있는 거')).toMatchObject({
      requiresDrinkabilityCheck: true,
      hasEntityMetadataSignal: true,
      searchDefaults: {
        drinking_window: 'now',
      },
    });
    expect(buildAgentQueryExecutionContract('캠핑 가는데 스크류캡이고 차갑게 마실 수 있는 거')).toMatchObject({
      requiresDrinkabilityCheck: false,
      searchDefaults: {
        styles: ['screw_cap', 'chillable'],
        occasion: ['camping'],
      },
    });
    expect(buildAgentQueryExecutionContract('와인 잘 모르는 사람한테 선물할 거, 실패 없는 걸로')).toMatchObject({
      searchDefaults: {
        occasion: ['gift'],
        gift_suitability_min: 0.7,
        beginner_suitability_min: 0.65,
        popularity_min: 0.5,
      },
    });
    expect(buildAgentQueryExecutionContract('와인 잘 모르는 사람한테 선물할 거, 실패 없는 걸로').searchDefaults?.styles)
      .toEqual(expect.arrayContaining(['approachable', 'crowd_pleasing']));
    expect(buildAgentQueryExecutionContract('와인 괜찮은 거 하나만')).toMatchObject({
      searchDefaults: {
        styles: ['crowd_pleasing'],
        popularity_min: 0.5,
      },
    });
    expect(buildAgentQueryExecutionContract('와인 ㄱㅊ은거 하나만').searchDefaults).toBeUndefined();
    expect(buildAgentQueryExecutionContract('와인 입문자 선물용, 달달하면서 도수 낮은 거, 예쁜 라벨이면 좋겠다')).toMatchObject({
      searchDefaults: {
        occasion: ['gift'],
        max_alcohol_pct: 12,
        gift_suitability_min: 0.65,
        beginner_suitability_min: 0.65,
      },
    });
    expect(buildAgentQueryExecutionContract('와인 입문자 선물용, 달달하면서 도수 낮은 거, 예쁜 라벨이면 좋겠다').searchDefaults?.styles)
      .toEqual(expect.arrayContaining(['presentation_forward', 'sweet', 'approachable']));
    expect(buildAgentQueryExecutionContract('데이트 전 와인 선물, 상대방이 뭘 좋아하는지 몰라')).toMatchObject({
      searchDefaults: {
        styles: ['crowd_pleasing'],
        occasion: ['date_night', 'gift'],
      },
    });
    expect(buildAgentQueryExecutionContract('와인 처음 마시는 부모님께 추천할 와인')).toMatchObject({
      searchDefaults: {
        styles: ['approachable', 'crowd_pleasing'],
        recipient_profile: 'parents_first_time',
        beginner_suitability_min: 0.65,
        sweetness_min: 0.2,
        sweetness_max: 0.75,
        acidity_max: 0.75,
        tannin_max: 0.3,
      },
    });
    expect(buildAgentQueryExecutionContract('와인 잘 모르는데 처음 마셔보기 좋은 거 알려줘')).toMatchObject({
      searchDefaults: {
        styles: ['approachable'],
        beginner_suitability_min: 0.65,
      },
    });
    expect(buildAgentQueryExecutionContract('퇴직하는 상사한테 드릴 건데, 격식 있는 와인으로')).toMatchObject({
      searchDefaults: {
        styles: ['crowd_pleasing'],
        occasion: ['gift'],
        min_price_krw: 50_000,
        max_price_krw: 150_000,
        recipient_profile: 'senior_colleague_gift',
        gift_suitability_min: 0.75,
        producer_prestige_min: 0.7,
      },
    });
    expect(buildAgentQueryExecutionContract('온라인 와인 시음회 준비, 참가자 모두가 살 수 있는 거 5만원 이하')).toMatchObject({
      searchDefaults: {
        styles: ['approachable', 'crowd_pleasing'],
        beginner_suitability_min: 0.65,
        popularity_min: 0.5,
        max_price_krw: 50_000,
      },
    });
    expect(buildAgentQueryExecutionContract('스테이크에 어울리는 와인 중에 10만원 이하로')).toMatchObject({
      requiredTool: 'get_food_pairings',
      searchDefaults: {
        max_price_krw: 100_000,
      },
    });
    expect(buildAgentQueryExecutionContract('까쇼 추천해줘')).toMatchObject({
      searchDefaults: {
        grape_primary: 'Cabernet Sauvignon',
      },
    });
    expect(buildAgentQueryExecutionContract('보르도 2018 추천해줘')).toMatchObject({
      searchDefaults: {
        region: 'Bordeaux',
      },
    });
    expect(buildAgentQueryExecutionContract('보졸레누보 올해꺼 나왔는지 확실한 근거 없으면 추정하지 말고 말해줘')).toMatchObject({
      hasTemporalReleaseSignal: true,
      temporalReleaseQuery: '보졸레누보',
      temporalReleaseConceptQuery: true,
      searchDefaults: {
        region: 'Beaujolais',
      },
    });
    expect(buildAgentQueryExecutionContract('셀러에 넣어둘 만한 거, 지금 마시면 아까운 와인')).toMatchObject({
      requiresDrinkabilityCheck: false,
      searchDefaults: {
        occasion: ['cellaring'],
        styles: ['ageworthy'],
      },
    });
    expect(buildAgentQueryExecutionContract('2015년산 중에 지금 바로 마셔야 하는 거 있어?')).toMatchObject({
      requiresDrinkabilityCheck: true,
      hasEntityMetadataSignal: false,
      searchDefaults: {
        drinking_window: 'now',
      },
    });
    expect(buildAgentQueryExecutionContract('아이 태어난 해 와인 사서 성인 될 때 같이 마시려고, 2024년산')).toMatchObject({
      requiresDrinkabilityCheck: false,
      searchDefaults: {
        occasion: ['cellaring'],
        styles: ['ageworthy'],
      },
    });
  });

  it('builds explicit parallel search slots for red plus white requests', () => {
    expect(buildAgentQueryExecutionContract('커플 세트로 레드 화이트 한 병씩, 예쁜 거')).toMatchObject({
      requiredParallelSearches: [
        { wineType: 'red', limit: 1 },
        { wineType: 'white', limit: 1 },
      ],
    });
    expect(buildAgentQueryExecutionContract('회사 회식 10명, 레드/화이트 반반, 총 20만원')).toMatchObject({
      requiredParallelSearches: [
        { wineType: 'red' },
        { wineType: 'white' },
      ],
    });
  });

  it('extracts explicit total budgets for parallel slot budgeting', () => {
    expect(buildAgentQueryExecutionContract('회사 회식 10명, 레드/화이트 반반, 총 20만원')).toMatchObject({
      totalBudgetKrw: 200_000,
      requiredParallelSearches: [
        { wineType: 'red' },
        { wineType: 'white' },
      ],
    });
  });

  it('detects attached Korean comparison particles as explicit drinkability comparison', () => {
    expect(buildAgentQueryExecutionContract('바롤로랑 브루넬로 비교해주고, 둘 중 지금 마시기 좋은 거로 골라줘')).toMatchObject({
      requiresDrinkabilityCheck: true,
      hasEntityMetadataSignal: true,
      searchDefaults: {
        drinking_window: 'now',
      },
    });
  });

  it('detects specific-sku-like queries through the adaptive-budget classifier contract', () => {
    expect(isSpecificSkuLikeQuery('opus one 2018')).toBe(true);
    expect(isSpecificSkuLikeQuery('레드 와인 추천해줘')).toBe(false);
  });

  it('treats metadata-suffixed exact entity queries as exact lookup candidates', () => {
    expect(isExactMetadataEntityLookupCandidate('오푸스원 얼마야?')).toBe(true);
    expect(isExactMetadataEntityLookupCandidate('오퍼스원 얼마야?')).toBe(true);
    expect(isExactMetadataEntityLookupCandidate('오푸스원 지금 마시기 좋아?')).toBe(true);
    expect(isExactMetadataEntityLookupCandidate('Opus One 2027 vintage released yet? If you do not have hard evidence, say you do not know.')).toBe(true);
    expect(isExactMetadataEntityLookupCandidate('Sassicaia 2025 release 있나? 확실한 근거 없으면 추정하지 말고 말해줘')).toBe(true);
    expect(isExactMetadataEntityLookupCandidate('Tignanello 2019 정보')).toBe(true);
    expect(isExactMetadataEntityLookupCandidate('돔페리뇽 추천해줘')).toBe(true);
    expect(isExactMetadataEntityLookupCandidate('레드 와인 추천해줘')).toBe(false);
  });

  it('detects bare exact label anchors that should preserve entity retrieval mode', () => {
    expect(hasBareExactEntityAnchor('돔페리뇽')).toBe(true);
    expect(hasBareExactEntityAnchor('모엣샹동 로제 임페리얼')).toBe(true);
  });

  it('strips structured filters from exact metadata search input while preserving allowed execution keys', () => {
    const normalized = normalizeExactMetadataSearchInput({
      query: 'opus one',
      limit: 3,
      retrieval_mode: 'entity',
      country: 'United States',
      vintage_min: 2018,
      max_price_krw: undefined,
      appellation: null,
    });

    expect(normalized.effectiveInput).toEqual({
      query: 'opus one',
      limit: 3,
      retrieval_mode: 'entity',
    });
    expect(normalized.strippedFilterKeys).toEqual(['country', 'vintage_min']);
  });

  it('extracts the unresolved top search entity id when drinkability is required', () => {
    const pending = extractPendingDrinkabilityEntityIds(
      { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: false },
      [],
      [
        {
          stepId: 'req:0:0',
          tool: 'search_wines',
          kind: 'success',
          result: {
            queryType: 'search',
            results: [
              { entity: { entityId: 'wine-1', canonicalLabel: 'Wine 1' } },
              { entity: { entityId: 'wine-2', canonicalLabel: 'Wine 2' } },
            ],
          },
          durationMs: 1,
        } satisfies ToolOutcome,
      ],
    );

    expect(pending).toEqual(['wine-1']);
  });

  it('does not re-request drinkability ids already checked in prior steps', () => {
    const steps: AgentStep[] = [
      {
        index: 0,
        thought: 'checked',
        action: { tool: 'check_drinking_window', input: { entity_id: 'wine-1' } },
        observation: 'ok',
        durationMs: 1,
        tokenCount: { input: 0, output: 0 },
      },
    ];

    const pending = extractPendingDrinkabilityEntityIds(
      { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: false },
      steps,
      [
        {
          stepId: 'req:0:0',
          tool: 'search_wines',
          kind: 'success',
          result: {
            queryType: 'search',
            results: [{ entity: { entityId: 'wine-1', canonicalLabel: 'Wine 1' } }],
          },
          durationMs: 1,
        } satisfies ToolOutcome,
      ],
    );

    expect(pending).toEqual([]);
  });

  it('extracts unresolved comparison entity ids and excludes completed checks', () => {
    const steps: AgentStep[] = [
      {
        index: 0,
        thought: 'parallel check',
        actionPairs: [
          {
            action: { tool: 'check_drinking_window', input: { entity_id: 'wine-a' } },
            observation: 'ok',
          },
        ],
        actions: [{ tool: 'check_drinking_window', input: { entity_id: 'wine-a' } }],
        observations: ['ok'],
        durationMs: 1,
        tokenCount: { input: 0, output: 0 },
      },
    ];

    const pending = extractPendingDrinkabilityEntityIds(
      { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: false },
      steps,
      [
        {
          stepId: 'req:0:0',
          tool: 'compare_wines',
          kind: 'success',
          result: {
            queryType: 'comparison',
            entities: [
              { topResult: { entity: { entityId: 'wine-a' } } },
              { topResult: { entity: { entityId: 'wine-b' } } },
            ],
          },
          durationMs: 1,
        } satisfies ToolOutcome,
      ],
    );

    expect(pending).toEqual(['wine-b']);
  });

  it('extracts comparison drinkability ids from conceptAggregate representative results when topResult is absent', () => {
    const pending = extractPendingDrinkabilityEntityIds(
      { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: false },
      [],
      [
        {
          stepId: 'req:0:0',
          tool: 'compare_wines',
          kind: 'success',
          result: {
            queryType: 'comparison',
            entities: [
              {
                topResult: null,
                conceptAggregate: {
                  representativeResult: { entity: { entityId: 'wine-a' } },
                },
                allResults: [],
              },
              {
                topResult: null,
                conceptAggregate: {
                  representativeResult: null,
                },
                allResults: [{ entity: { entityId: 'wine-b' } }],
              },
            ],
          },
          durationMs: 1,
        } satisfies ToolOutcome,
      ],
    );

    expect(pending).toEqual(['wine-a', 'wine-b']);
  });

  it('extracts pending drinkability ids from the latest parallel search batch in step order', () => {
    const pending = extractPendingDrinkabilityEntityIds(
      { requiresDrinkabilityCheck: true, hasEntityMetadataSignal: false },
      [],
      [
        {
          stepId: 'req:0:0',
          tool: 'search_wines',
          kind: 'success',
          result: {
            queryType: 'search',
            results: [{ entity: { entityId: 'wine-2015', canonicalLabel: 'Wine 2015' } }],
          },
          durationMs: 1,
        } satisfies ToolOutcome,
        {
          stepId: 'req:0:1',
          tool: 'search_wines',
          kind: 'success',
          result: {
            queryType: 'search',
            results: [{ entity: { entityId: 'wine-2016', canonicalLabel: 'Wine 2016' } }],
          },
          durationMs: 1,
        } satisfies ToolOutcome,
        {
          stepId: 'req:0:2',
          tool: 'search_wines',
          kind: 'success',
          result: {
            queryType: 'search',
            results: [],
          },
          durationMs: 1,
        } satisfies ToolOutcome,
      ],
    );

    expect(pending).toEqual(['wine-2015', 'wine-2016']);
  });
});
