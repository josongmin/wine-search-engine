import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeAgentTool, type AgentToolDeps } from '../../../../src/application/agent/agent-tools.js';
import { stripSideSpecificCompareSharedConstraints } from '../../../../src/application/search/compare-tool-shared-constraints.js';
import { extractSearchConstraints } from '../../../../src/domain/query/service/search-constraint-extractor.js';
import type { SearchExecutorPort } from '../../../../src/application/search/port/search-executor.port.js';
import type { SearchResponseV1 } from '../../../../src/domain/response/model/search-response.js';
import { SOURCE_SYSTEM_VIVINO_SILVER } from '../../../../src/shared/constants/source-systems.js';

function makeSearchResponse(
  results: SearchResponseV1['results'],
  overrides?: Partial<SearchResponseV1>,
): SearchResponseV1 {
  return {
    queryType: 'search',
    engineDecision: {
      decisionStatus: 'resolved',
      nextAction: 'return',
      route: 'hybrid',
      decisionConfidence: 0.9,
      confidenceSemantics: 'calibrated_decision_confidence',
      decisionTraceRef: 'trace-123',
      decisionSnapshot: {
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1',
        threshold_profile_id: 'default',
        planner_version: '1',
        feature_flags: {},
      },
      ...(overrides?.engineDecision ?? {}),
    },
    results,
    meta: {
      requestId: 'req-123',
      queryTimeMs: 10,
      route: 'hybrid',
      version: '1.0.0',
      engine_schema_version: 'search_response_v1',
      ...(overrides?.meta ?? {}),
    },
    ...(overrides?.counterfactuals !== undefined ? { counterfactuals: overrides.counterfactuals } : {}),
    ...(overrides?.clarification !== undefined ? { clarification: overrides.clarification } : {}),
    ...(overrides?.retrievalMode !== undefined ? { retrievalMode: overrides.retrievalMode } : {}),
    ...(overrides?.resultType !== undefined ? { resultType: overrides.resultType } : {}),
    ...(overrides?.parsedConstraints !== undefined ? { parsedConstraints: overrides.parsedConstraints } : {}),
  };
}

describe('executeAgentTool', () => {
  let deps: AgentToolDeps;
  let mockSearchUseCase: SearchExecutorPort;

  beforeEach(() => {
    mockSearchUseCase = {
      execute: vi.fn(),
    };
    deps = {
      searchUseCase: mockSearchUseCase,
    };
  });

  it('serializes structured search inputs into parser-compatible clauses', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'search_wines',
      {
        query: '레드 와인 추천',
        exclude_grapes: ['Merlot', 'Cabernet Sauvignon'],
        exclude_regions: ['France'],
        max_price_krw: 50_000,
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0] ?? [];
    expect(request?.query).toContain('50_000원 이하'.replace('_', ''));
    expect(request?.query).toContain('not Merlot');
    expect(request?.query).toContain('not Cabernet Sauvignon');
    expect(request?.query).toContain('not France');
    expect(request?.query).not.toContain('under 50000 KRW');
    expect(request?.query).not.toContain('not from France');

    const parsed = extractSearchConstraints(request!.query);
    expect(parsed.maxPriceKrw).toBe(50_000);
    expect(parsed.excludeGrapes).toEqual(
      expect.arrayContaining(['Merlot', 'Cabernet Sauvignon']),
    );
    expect(parsed.excludeCountries).toContain('France');
  });

  it('serializes multiple semantic styles into parser-compatible clauses', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'search_wines',
      {
        query: '선물용 와인 추천',
        styles: ['approachable', 'crowd_pleasing'],
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls.at(-1) ?? [];
    expect(request?.query).not.toContain('approachable');
    expect(request?.query).not.toContain('crowd pleasing');
  });

  it('normalizes singular style arrays into structured styles', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'search_wines',
      {
        query: '와인 처음 마시는 부모님께 추천할 와인',
        style: ['slightly sweet', 'fruity', 'gentle acidity'],
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls.at(-1) ?? [];
    expect(request?.query).toContain('와인 처음 마시는 부모님께 추천할 와인');
    expect(request?.preferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: 'style', operator: 'in', value: ['slightly sweet'] }),
      expect.objectContaining({ attribute: 'style', operator: 'in', value: ['fruity'] }),
      expect.objectContaining({ attribute: 'style', operator: 'in', value: ['gentle acidity'] }),
    ]));
  });

  it('pushes grape_primary into structured filters and retrieval text for varietal queries', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'search_wines',
      {
        query: '까쇼 추천해줘',
        grape_primary: 'Cabernet Sauvignon',
        wine_type: 'red',
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls.at(-1) ?? [];
    expect(request?.query).toContain('Cabernet Sauvignon');
    expect(request?.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: 'grape_primary', operator: '=', value: 'Cabernet Sauvignon' }),
      expect.objectContaining({ attribute: 'wine_type', operator: '=', value: 'red' }),
    ]));
  });

  it('surfaces accessibility grounding and popularity for online tasting recommendations', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([
        {
          entity: {
            entityId: 'wine-1',
            canonicalLabel: 'Accessible Wine',
            type: 'wine',
            priceRange: '$30',
          },
          relevanceScore: 0.91,
          match: {
            matchType: 'hybrid',
            scoreComponents: {
              lexical: 0.8,
              semantic: 0.8,
              attribute: 0.8,
              popularity: 0.73,
              preferenceAlignment: 0.6,
            },
          },
          constraints: { matched: ['max_price_krw'], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
      ]),
    );

    const result = await executeAgentTool(
      'search_wines',
      {
        query: '온라인 와인 시음회 준비, 참가자 모두가 살 수 있는 거',
        max_price_krw: 50_000,
        styles: ['approachable', 'crowd_pleasing'],
      },
      deps,
      'req-123',
    );

    expect(result.observation).toContain('ACCESSIBILITY_GROUNDING');
    expect(result.observation).toContain('popularity_score: 0.73');
    expect(result.observation).toContain('"popularity_score":0.73');
    expect(result.observation).toContain('do not claim a specific store carries');
  });

  it('does not serialize abstract learned styles into search query text', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'search_wines',
      {
        query: '예쁜 라벨 선물용 와인',
        styles: ['presentation_forward', 'approachable'],
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls.at(-1) ?? [];
    expect(request?.query).not.toContain('approachable');
    expect(request?.query).not.toContain('presentation_forward');
    expect(request?.preferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: 'style', operator: 'in', value: ['presentation_forward'] }),
      expect.objectContaining({ attribute: 'style', operator: 'in', value: ['approachable'] }),
    ]));
  });

  it('pushes max_alcohol_pct into structured preferences for low-alcohol queries', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'search_wines',
      {
        query: '도수 낮은 달달한 와인',
        style: 'sweet',
        max_alcohol_pct: 12,
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls.at(-1) ?? [];
    expect(request?.query).toContain('sweet');
    expect(request?.query).toContain('low alcohol 12% 이하');
    expect(request?.preferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: 'alcohol_pct', operator: '<=', value: 12 }),
      expect.objectContaining({ attribute: 'sweetness', operator: '>=', value: 0.5 }),
    ]));
    expect(request?.filters).toBeUndefined();
  });

  it('compiles sweet style into structured sweetness preference and retrieval text', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'search_wines',
      {
        query: '달달한 선물용 와인',
        styles: ['sweet', 'approachable'],
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls.at(-1) ?? [];
    expect(request?.query).not.toContain('approachable');
    expect(request?.query).toContain('sweet');
    expect(request?.preferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: 'sweetness', operator: '>=', value: 0.5 }),
      expect.objectContaining({ attribute: 'style', operator: 'in', value: ['approachable'] }),
    ]));
    expect(request?.filters).toBeUndefined();
  });

  it('compiles typed sensory search preferences without rewriting the lexical anchor', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'search_wines',
      {
        query: '와인 처음 마시는 부모님께 추천할 와인',
        recipient_profile: 'parents_first_time',
        sweetness_min: 0.2,
        sweetness_max: 0.75,
        acidity_max: 0.75,
        tannin_max: 0.3,
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls.at(-1) ?? [];
    expect(request?.query).toBe('와인 처음 마시는 부모님께 추천할 와인');
    expect(request?.preferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: 'sweetness', operator: '>=', value: 0.2 }),
      expect.objectContaining({ attribute: 'sweetness', operator: '<=', value: 0.75 }),
      expect.objectContaining({ attribute: 'acidity', operator: '<=', value: 0.75 }),
      expect.objectContaining({ attribute: 'tannin', operator: '<=', value: 0.3 }),
      expect.objectContaining({ attribute: 'recipient_profile', operator: '=', value: 'parents_first_time' }),
    ]));
  });

  it('raises limit to the diversity floor when want_diversity is true', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'search_wines',
      {
        query: '레드 와인 다양하게 추천',
        want_diversity: true,
        limit: 3,
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0] ?? [];
    expect(request?.limit).toBe(5);
  });

  it('runs typed diversity discovery when want_diversity has no explicit wine type', async () => {
    vi.mocked(mockSearchUseCase.execute)
      .mockResolvedValueOnce(
        makeSearchResponse([
          {
            entity: { entityId: 'wine-red-1', canonicalLabel: 'Red A', type: 'wine', wineType: 'red', style: 'medium red' },
            relevanceScore: 0.91,
            match: { matchType: 'hybrid', scoreComponents: { lexical: 0.8, semantic: 0.8, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
            constraints: { matched: ['occasion'], unmet: ['style'], inferred: [] },
            uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
            evidenceItems: [],
          },
        ]),
      )
      .mockResolvedValueOnce(
        makeSearchResponse([
          {
            entity: { entityId: 'wine-white-1', canonicalLabel: 'White A', type: 'wine', wineType: 'white', style: 'crisp white' },
            relevanceScore: 0.88,
            match: { matchType: 'hybrid', scoreComponents: { lexical: 0.7, semantic: 0.8, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
            constraints: { matched: ['occasion'], unmet: ['style'], inferred: [] },
            uncertainty: { uncertaintyConfidence: 0.88, missingInfo: [], approximationUsed: false },
            evidenceItems: [],
          },
        ]),
      )
      .mockResolvedValueOnce(
        makeSearchResponse([
          {
            entity: { entityId: 'wine-spark-1', canonicalLabel: 'Sparkling A', type: 'wine', wineType: 'sparkling', style: 'sparkling' },
            relevanceScore: 0.86,
            match: { matchType: 'hybrid', scoreComponents: { lexical: 0.7, semantic: 0.79, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
            constraints: { matched: ['occasion'], unmet: ['style'], inferred: [] },
            uncertainty: { uncertaintyConfidence: 0.86, missingInfo: [], approximationUsed: false },
            evidenceItems: [],
          },
        ]),
      )
      .mockResolvedValueOnce(
        makeSearchResponse([
          {
            entity: { entityId: 'wine-red-2', canonicalLabel: 'Red B', type: 'wine', wineType: 'red', style: 'medium red' },
            relevanceScore: 0.84,
            match: { matchType: 'hybrid', scoreComponents: { lexical: 0.7, semantic: 0.78, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
            constraints: { matched: ['occasion'], unmet: ['style'], inferred: [] },
            uncertainty: { uncertaintyConfidence: 0.84, missingInfo: [], approximationUsed: false },
            evidenceItems: [],
          },
        ]),
      );

    const result = await executeAgentTool(
      'search_wines',
      { query: '선물용 다양하게 추천', want_diversity: true, limit: 5 },
      deps,
      'req-123',
    );

    expect(vi.mocked(mockSearchUseCase.execute)).toHaveBeenCalledTimes(3);

    const calls = vi.mocked(mockSearchUseCase.execute).mock.calls;
    const typedFilters = calls.map(([request]) =>
      request?.filters?.find((filter) => filter.attribute === 'wine_type')?.value,
    );
    expect(typedFilters).toEqual(['white', 'sparkling', 'red']);
    expect(result.observation).toContain('wine_type: white');
    expect(result.observation).toContain('wine_type: sparkling');
    expect(result.observation).toContain('wine_type: red');
  });

  it('merges runtime metadata across typed diversity responses instead of leaking the first shard', async () => {
    vi.mocked(mockSearchUseCase.execute)
      .mockResolvedValueOnce(
        makeSearchResponse([
          {
            entity: { entityId: 'wine-white-1', canonicalLabel: 'White A', type: 'wine', wineType: 'white' },
            relevanceScore: 0.82,
            match: { matchType: 'hybrid', scoreComponents: { lexical: 0.8, semantic: 0.8, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
            constraints: { matched: ['occasion'], unmet: [], inferred: [] },
            uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
            evidenceItems: [{ type: 'identity', source: 'test', contribution: 'positive', strength: 'high', provenance: 'test' }],
          },
        ], {
          engineDecision: {
            decisionTraceRef: 'trace-white',
            runtimeCorrelationRef: 'req-123:diversity:white',
            degradationReasons: ['typed_probe_partial'],
          },
          meta: {
            requestId: 'req-123:diversity:white',
            runtimeCorrelationRef: 'req-123:diversity:white',
            queryTimeMs: 15,
            executionMode: 'degraded',
            degradationReasons: ['typed_probe_partial'],
          },
        }),
      )
      .mockResolvedValueOnce(
        makeSearchResponse([
          {
            entity: { entityId: 'wine-spark-1', canonicalLabel: 'Sparkling A', type: 'wine', wineType: 'sparkling' },
            relevanceScore: 0.91,
            match: { matchType: 'hybrid', scoreComponents: { lexical: 0.8, semantic: 0.8, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
            constraints: { matched: ['occasion'], unmet: [], inferred: [] },
            uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
            evidenceItems: [{ type: 'identity', source: 'test', contribution: 'positive', strength: 'high', provenance: 'test' }],
          },
        ], {
          engineDecision: {
            decisionTraceRef: 'trace-sparkling',
            runtimeCorrelationRef: 'req-123:diversity:sparkling',
          },
          meta: {
            requestId: 'req-123:diversity:sparkling',
            runtimeCorrelationRef: 'req-123:diversity:sparkling',
            queryTimeMs: 42,
          },
        }),
      )
      .mockResolvedValueOnce(
        makeSearchResponse([
          {
            entity: { entityId: 'wine-red-1', canonicalLabel: 'Red A', type: 'wine', wineType: 'red' },
            relevanceScore: 0.85,
            match: { matchType: 'hybrid', scoreComponents: { lexical: 0.8, semantic: 0.8, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
            constraints: { matched: ['occasion'], unmet: [], inferred: [] },
            uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
            evidenceItems: [{ type: 'identity', source: 'test', contribution: 'positive', strength: 'high', provenance: 'test' }],
          },
        ], {
          engineDecision: {
            decisionTraceRef: 'trace-red',
            runtimeCorrelationRef: 'req-123:diversity:red',
          },
          meta: {
            requestId: 'req-123:diversity:red',
            runtimeCorrelationRef: 'req-123:diversity:red',
            queryTimeMs: 28,
          },
        }),
      );

    const result = await executeAgentTool(
      'search_wines',
      { query: '선물용 다양하게 추천', want_diversity: true, limit: 5 },
      deps,
      'req-123',
    );

    const raw = result.rawResult as SearchResponseV1;
    expect(raw.meta.requestId).toBe('req-123');
    expect(raw.meta.runtimeCorrelationRef).toBe('req-123');
    expect(raw.meta.queryTimeMs).toBe(42);
    expect(raw.meta.executionMode).toBe('degraded');
    expect(raw.meta.degradationReasons).toEqual(['typed_probe_partial']);
    expect(raw.engineDecision.runtimeCorrelationRef).toBe('req-123');
    expect(raw.engineDecision.decisionTraceRef).toBe('trace-sparkling');
    expect(raw.results[0]?.entity.wineType).toBe('sparkling');
  });

  it('skips typed diversity discovery when query already mentions wine types', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'search_wines',
      { query: '레드랑 화이트 다양하게 추천', want_diversity: true, limit: 5 },
      deps,
      'req-123',
    );

    expect(vi.mocked(mockSearchUseCase.execute)).toHaveBeenCalledTimes(1);
  });

  it('preserves semantic style and price clauses inside typed diversity discovery queries', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'search_wines',
      {
        query: '와인 잘 모르는 사람한테 선물할 거',
        styles: ['approachable', 'crowd_pleasing'],
        max_price_krw: 50000,
        want_diversity: true,
        limit: 5,
      },
      deps,
      'req-123',
    );

    expect(vi.mocked(mockSearchUseCase.execute)).toHaveBeenCalledTimes(3);
    for (const [request] of vi.mocked(mockSearchUseCase.execute).mock.calls) {
      expect(request?.query).toContain('와인 잘 모르는 사람한테 선물할 거');
      expect(request?.query).not.toContain('approachable');
      expect(request?.query).not.toContain('crowd pleasing');
      expect(request?.query).toContain('50000원 이하');
    }
  });

  it('rewrites structured multi-course queries to pairing-focused retrieval cores', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'search_wines',
      {
        query: '결혼기념일 코스요리 에피타이저용 화이트 추천',
        wine_type: 'white',
        max_price_krw: 150_000,
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0] ?? [];
    expect(request?.query).toContain('aperitif');
    expect(request?.query).toContain('white');
    expect(request?.query).toContain('wine');
    expect(request?.query).toContain('결혼기념일');
    expect(request?.query).toContain('코스요리');
  });

  it('rewrites colloquial grape queries to canonical retrieval cores', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'search_wines',
      {
        query: '까쇼 추천해줘',
        wine_type: 'red',
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0] ?? [];
    expect(request?.query).toContain('cabernet sauvignon');
    expect(request?.query).toContain('wine');
    expect(request?.query).not.toContain('추천해줘');
    expect(request?.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'wine_type', value: 'red' }),
      ]),
    );
  });

  it('rewrites Korean food-suffix pairing queries to canonical pairing cores', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'search_wines',
      {
        query: '메인 소고기용 레드 추천',
        wine_type: 'red',
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0] ?? [];
    expect(request?.query).toContain('beef');
    expect(request?.query).toContain('red');
    expect(request?.query).toContain('wine');
    expect(request?.query).toContain('소고기용');
  });

  it('transliterates short bare Korean entity queries to canonical Latin retrieval cores', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'search_wines',
      {
        query: '보졸레 누보',
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0] ?? [];
    expect(request?.query).toBe('beaujolais nouveau');
  });

  it('canonicalizes short Korean exact-entity price queries before dispatch', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'search_wines',
      {
        query: '오퍼스원 얼마야?',
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls.at(-1) ?? [];
    expect(request?.query).toBe('opus one');
  });

  it('canonicalizes short Korean drinkability entity queries before dispatch', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'search_wines',
      {
        query: '오푸스원 지금 마시기 좋아?',
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls.at(-1) ?? [];
    expect(request?.query).toBe('opus one');
  });

  it('preserves the resolved lexical nucleus when structured filters exist', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'search_wines',
      {
        query: '보졸레 누보 올해꺼 나왔어?',
        wine_type: 'red',
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0] ?? [];
    expect(request?.query).toMatch(/보졸레|beaujolais/i);
    expect(request?.query).toContain('wine');
  });

  it('forwards search_wines limit to the search use case', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'search_wines',
      {
        query: '레드 와인 추천',
        limit: 3,
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0] ?? [];
    expect(request?.limit).toBe(3);
  });

  it('uses the narrow drinking-window projection before full entity hydration', async () => {
    const drinkingWindowEntityLookup = vi.fn().mockResolvedValue({
      entityId: 'wine-opus-one-2018',
      canonicalLabel: 'Opus One 2018',
      drinkingWindowStart: 2024,
      drinkingWindowEnd: 2038,
      drinkingWindowModelVersion: 'dw-v1',
    });
    const entityLookup = vi.fn().mockRejectedValue(new Error('full hydration must not run'));
    deps = {
      searchUseCase: mockSearchUseCase,
      drinkingWindowEntityLookup,
      entityLookup,
    };

    const result = await executeAgentTool(
      'check_drinking_window',
      {
        entity_id: 'wine-opus-one-2018',
        target_year: 2026,
      },
      deps,
      'req-123',
    );

    expect(drinkingWindowEntityLookup).toHaveBeenCalledWith('wine-opus-one-2018');
    expect(entityLookup).not.toHaveBeenCalled();
    expect(result.observation).toContain('Opus One 2018: drinking window 2024-2038');
    expect(result.observation).toContain('currently drinkable');
    expect(result.rawResult).toMatchObject({
      drinkingWindowStart: 2024,
      drinkingWindowEnd: 2038,
      currentlyDrinkable: true,
      modelVersion: 'dw-v1',
    });
  });

  it('falls back to authoritative search projection when direct drinkability lookup lacks window data', async () => {
    const drinkingWindowEntityLookup = vi.fn().mockResolvedValue({
      entityId: 'wine-opus-one-2018',
      canonicalLabel: 'Opus One 2018',
    });
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([
        {
          entity: {
            entityId: 'wine-opus-one-2018',
            canonicalLabel: 'Opus One 2018',
          },
          drinkingWindow: {
            drinkingWindowStart: 2021,
            drinkingWindowEnd: 2032,
            currentlyDrinkable: true,
            confidence: 'medium',
            modelVersion: 'search-dw-v1',
          },
        } as SearchResponseV1['results'][number],
      ]),
    );
    deps = {
      searchUseCase: mockSearchUseCase,
      drinkingWindowEntityLookup,
    };

    const result = await executeAgentTool(
      'check_drinking_window',
      {
        entity_id: 'wine-opus-one-2018',
        target_year: 2026,
      },
      deps,
      'req-123',
    );

    expect(drinkingWindowEntityLookup).toHaveBeenCalledWith('wine-opus-one-2018');
    expect(vi.mocked(mockSearchUseCase.execute)).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'Opus One 2018',
        options: expect.objectContaining({ mode: 'entity' }),
      }),
      'req-123',
      {},
    );
    expect(result.observation).toContain('Opus One 2018: drinking window 2021-2032');
    expect(result.rawResult).toMatchObject({
      drinkingWindowStart: 2021,
      drinkingWindowEnd: 2032,
      currentlyDrinkable: true,
      modelVersion: 'search-dw-v1',
    });
  });

  it('reuses grounded drinkability projection captured from a prior compare/search step', async () => {
    deps = {
      searchUseCase: mockSearchUseCase,
      groundedDrinkingWindowLookup: vi.fn().mockReturnValue({
        entityId: 'wine-opus-one-2018',
        canonicalLabel: 'Opus One 2018',
        drinkingWindowStart: 2021,
        drinkingWindowEnd: 2032,
        drinkingWindowModelVersion: 'comparison-dw-v1',
      }),
    };

    const result = await executeAgentTool(
      'check_drinking_window',
      {
        entity_id: 'wine-opus-one-2018',
        target_year: 2026,
      },
      deps,
      'req-123',
    );

    expect(vi.mocked(mockSearchUseCase.execute)).not.toHaveBeenCalled();
    expect(result.observation).toContain('Opus One 2018: drinking window 2021-2032');
    expect(result.observation).toContain('currently drinkable');
    expect(result.rawResult).toMatchObject({
      drinkingWindowStart: 2021,
      drinkingWindowEnd: 2032,
      currentlyDrinkable: true,
      modelVersion: 'comparison-dw-v1',
    });
  });

  it('forwards abortSignal to search use case execution context', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );
    const controller = new AbortController();

    await executeAgentTool(
      'search_wines',
      {
        query: '레드 와인 추천',
      },
      deps,
      'req-123',
      { abortSignal: controller.signal },
    );

    const call = vi.mocked(mockSearchUseCase.execute).mock.calls[0];
    expect(call?.[2]).toEqual(expect.objectContaining({ abortSignal: controller.signal }));
  });

  it('serializes pairing budgets into parser-compatible KRW text', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'get_food_pairings',
      {
        food: 'steak',
        max_price_krw: 30_000,
        color: 'red',
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0] ?? [];
    expect(request?.query).toContain('30000원 이하');
    expect(request?.query).not.toContain('under 30000 KRW');
    expect(request?.options).toEqual({ mode: 'hybrid', explain: false, clarification: false });

    const parsed = extractSearchConstraints(request!.query);
    expect(parsed.maxPriceKrw).toBe(30_000);
  });

  it('accepts pairing color both without adding an impossible color filter', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'get_food_pairings',
      {
        food: '쌈싸먹을 때',
        color: 'both',
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0] ?? [];
    expect(request?.query).toContain('wine pairing for 쌈싸먹을 때');
    expect(request?.query).not.toContain('both');
  });

  it('forwards typed pairing objectives as structured constraints', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    const result = await executeAgentTool(
      'get_food_pairings',
      {
        food: '매운 떡볶이',
        color: 'white',
        sweetness_target: 0.35,
        acidity_min: 6,
        tannin_max: 3,
        styles: ['off_dry'],
        pairing_tags: ['spicy_food'],
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0] ?? [];
    expect(request?.query).toContain('off_dry');
    expect(request?.query).toContain('spicy_food');
    expect(request?.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: 'wine_type', operator: '=', value: 'white' }),
    ]));
    expect(request?.preferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: 'sweetness', operator: '>=', value: 0.2 }),
      expect.objectContaining({ attribute: 'sweetness', operator: '<=', value: 0.6 }),
      expect.objectContaining({ attribute: 'sweetness', operator: '=', value: 0.35 }),
      expect.objectContaining({ attribute: 'acidity', operator: '>=', value: 6 }),
      expect.objectContaining({ attribute: 'tannin', operator: '<=', value: 3 }),
      expect.objectContaining({ attribute: 'pairing', operator: 'in', value: ['spicy_food'] }),
    ]));
    expect(result.observation).toContain('PAIRING_OBJECTIVE_STYLES: off_dry');
    expect(result.observation).toContain('PAIRING_STYLE_GUIDANCE: For spicy food');
  });

  it('rejects placeholder food values for get_food_pairings', async () => {
    const result = await executeAgentTool(
      'get_food_pairings',
      { food: 'TBD' },
      deps,
      'req-123',
    );

    expect(result.observation).toContain('Invalid input for get_food_pairings');
    expect(result.observation).toMatch(/placeholder/i);
    expect(result.rawResult).toBeNull();
  });

  it('rejects placeholder compare queries', async () => {
    const result = await executeAgentTool(
      'compare_wines',
      { query_a: '__TO_BE_FILLED__', query_b: 'Barolo' },
      deps,
      'req-123',
    );

    expect(result.observation).toContain('Invalid input for compare_wines');
    expect(result.observation).toMatch(/placeholder/i);
    expect(result.rawResult).toBeNull();
  });

  it('forwards shared structured comparison constraints through decomposed search', async () => {
    const mockDecomposedSearchExecute = vi.fn().mockResolvedValue({
      queryType: 'comparison',
      originalQuery: 'Barolo vs Brunello di Montalcino',
      comparisonIntent: 'compare',
      entities: [],
      overallStatus: 'resolved',
      requestId: 'req-123',
      executionTimeMs: 12,
      authorityTraceRef: 'cmp-trace',
      runtimeCorrelationRef: 'req-123',
    });
    deps = {
      ...deps,
      decomposedSearchExecute: mockDecomposedSearchExecute,
    };

    await executeAgentTool(
      'compare_wines',
      {
        query_a: 'Barolo',
        query_b: 'Brunello di Montalcino',
        max_price_krw: 50_000,
        country: 'Italy',
        vintage_min: 2018,
      },
      deps,
      'req-123',
    );

    const [
      subQueries,
      ,
      originalQuery,
      ,
      ,
      parentContext,
      ,
      retrievalSubQueries,
    ] = mockDecomposedSearchExecute.mock.calls[0] ?? [];
    expect(subQueries).toEqual(['Barolo', 'Brunello di Montalcino']);
    expect(retrievalSubQueries[0].toLowerCase()).toContain('barolo wine');
    expect(retrievalSubQueries[1].toLowerCase()).toContain('brunello di montalcino wine');
    expect(retrievalSubQueries[0]).toContain('50000원 이하');
    expect(retrievalSubQueries[1]).toContain('50000원 이하');
    expect(originalQuery).toContain('50000원 이하');
    expect(parentContext?.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'country', operator: '=', value: 'Italy' }),
        expect.objectContaining({ attribute: 'vintage_year', operator: '>=', value: 2018 }),
      ]),
    );
  });

  it('preserves concept aggregate evidence in compare grounding output', async () => {
    const mockDecomposedSearchExecute = vi.fn().mockResolvedValue({
      queryType: 'comparison',
      originalQuery: 'Barolo vs Brunello di Montalcino',
      comparisonIntent: 'compare',
      entities: [
        {
          subQuery: 'Barolo',
          comparisonMode: 'concept',
          canonicalConcept: 'Barolo',
          conceptEntityType: 'appellation',
          conceptAggregate: {
            canonicalConcept: 'Barolo',
            conceptEntityType: 'appellation',
            representativeResult: {
              entity: { entityId: 'barolo-1', canonicalLabel: 'Massolino Barolo', type: 'wine', wineType: 'red' },
              match: { matchType: 'hybrid', scoreComponents: { lexical: 1, semantic: 1, attribute: 1, popularity: 1, preferenceAlignment: 1 } },
              relevanceScore: 0.9,
              constraints: { matched: [], unmet: [], inferred: [] },
              uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
              evidenceItems: [],
            },
            prototypeAxis: [
              {
                entity: { entityId: 'barolo-1', canonicalLabel: 'Massolino Barolo', type: 'wine', wineType: 'red' },
                match: { matchType: 'hybrid', scoreComponents: { lexical: 1, semantic: 1, attribute: 1, popularity: 1, preferenceAlignment: 1 } },
                relevanceScore: 0.9,
                constraints: { matched: [], unmet: [], inferred: [] },
                uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
                evidenceItems: [],
              },
              {
                entity: { entityId: 'barolo-2', canonicalLabel: 'Vietti Barolo Castiglione', type: 'wine', wineType: 'red' },
                match: { matchType: 'hybrid', scoreComponents: { lexical: 0.9, semantic: 0.9, attribute: 0.9, popularity: 0.9, preferenceAlignment: 0.9 } },
                relevanceScore: 0.88,
                constraints: { matched: [], unmet: [], inferred: [] },
                uncertainty: { uncertaintyConfidence: 0.88, missingInfo: [], approximationUsed: false },
                evidenceItems: [],
              },
            ],
            aggregateResultCount: 2,
          },
          topResult: {
            entity: { entityId: 'barolo-1', canonicalLabel: 'Massolino Barolo', type: 'wine', wineType: 'red' },
            match: { matchType: 'hybrid', scoreComponents: { lexical: 1, semantic: 1, attribute: 1, popularity: 1, preferenceAlignment: 1 } },
            relevanceScore: 0.9,
            constraints: { matched: [], unmet: [], inferred: [] },
            uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
            evidenceItems: [],
          },
          resultCount: 2,
          resolutionStatus: 'resolved',
          allResults: [],
        },
        {
          subQuery: 'Brunello di Montalcino',
          comparisonMode: 'concept',
          canonicalConcept: 'Brunello di Montalcino',
          conceptEntityType: 'appellation',
          conceptAggregate: {
            canonicalConcept: 'Brunello di Montalcino',
            conceptEntityType: 'appellation',
            representativeResult: null,
            prototypeAxis: [],
            aggregateResultCount: 0,
          },
          topResult: null,
          resultCount: 0,
          resolutionStatus: 'resolved',
          allResults: [],
        },
      ],
      overallStatus: 'resolved',
      requestId: 'req-123',
      executionTimeMs: 12,
      authorityTraceRef: 'cmp-trace',
      runtimeCorrelationRef: 'req-123',
    });
    deps = {
      ...deps,
      decomposedSearchExecute: mockDecomposedSearchExecute,
    };

    const result = await executeAgentTool(
      'compare_wines',
      {
        query_a: 'Barolo',
        query_b: 'Brunello di Montalcino',
      },
      deps,
      'req-123',
    );

    expect(result.observation).toContain('prototype_count: 2');
    expect(result.observation).toContain('comparison_concept: Barolo');
    expect(result.observation).toContain('"comparison_legs"');
    expect(result.observation).toContain('"aggregate_result_count":2');
    expect(result.observation).toContain('"prototype_axis"');
  });

  it('removes side-specific comparison identity fields from shared comparison context', async () => {
    const mockDecomposedSearchExecute = vi.fn().mockResolvedValue({
      queryType: 'comparison',
      originalQuery: '바롤로 vs 브루넬로',
      comparisonIntent: 'compare',
      entities: [],
      overallStatus: 'resolved',
      requestId: 'req-123',
      executionTimeMs: 12,
      authorityTraceRef: 'cmp-trace',
      runtimeCorrelationRef: 'req-123',
    });
    deps = {
      ...deps,
      decomposedSearchExecute: mockDecomposedSearchExecute,
    };

    await executeAgentTool(
      'compare_wines',
      {
        query_a: '바롤로',
        query_b: '브루넬로',
        appellation: 'Barolo',
        max_price_krw: 100_000,
      },
      deps,
      'req-123',
    );

    const [
      subQueries,
      ,
      originalQuery,
      ,
      ,
      parentContext,
      ,
      retrievalSubQueries,
    ] = mockDecomposedSearchExecute.mock.calls[0] ?? [];
    expect(subQueries).toEqual(['바롤로', '브루넬로']);
    expect(originalQuery).toContain('100000원 이하');
    expect(originalQuery).not.toContain('Barolo');
    expect(retrievalSubQueries[0]).toContain('100000원 이하');
    expect(retrievalSubQueries[1]).toContain('100000원 이하');
    expect(retrievalSubQueries[1]).not.toContain('Barolo');
    expect(parentContext?.filters).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'appellation' }),
      ]),
    );
  });

  it('forwards side-specific comparison filters through the agent tool executor', async () => {
    const mockDecomposedSearchExecute = vi.fn().mockResolvedValue({
      queryType: 'comparison',
      originalQuery: '말벡 vs 말벡',
      comparisonIntent: 'compare',
      entities: [],
      overallStatus: 'resolved',
      requestId: 'req-123',
      executionTimeMs: 12,
      authorityTraceRef: 'cmp-trace',
      runtimeCorrelationRef: 'req-123',
    });
    deps = {
      ...deps,
      decomposedSearchExecute: mockDecomposedSearchExecute,
    };

    await executeAgentTool(
      'compare_wines',
      {
        query_a: '말벡',
        query_b: '말벡',
        country_a: 'France',
        country_b: 'Argentina',
        region_b: 'Mendoza',
        grape_primary_a: 'Malbec',
        grape_primary_b: 'Malbec',
        wine_type_a: 'red',
        wine_type_b: 'red',
      },
      deps,
      'req-123',
    );

    const [
      subQueries,
      ,
      ,
      ,
      ,
      parentContext,
      ,
      retrievalSubQueries,
    ] = mockDecomposedSearchExecute.mock.calls.at(-1) ?? [];

    expect(subQueries).toEqual(['말벡', '말벡']);
    expect(retrievalSubQueries[0].toLowerCase()).toContain('malbec');
    expect(retrievalSubQueries[1].toLowerCase()).toContain('malbec');
    expect(parentContext?.filters ?? []).toHaveLength(0);
    expect(parentContext?.perSideFilters?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'country', operator: '=', value: 'France' }),
        expect.objectContaining({ attribute: 'grape_primary', operator: '=', value: 'Malbec' }),
        expect.objectContaining({ attribute: 'wine_type', operator: '=', value: 'red' }),
      ]),
    );
    expect(parentContext?.perSideFilters?.[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'country', operator: '=', value: 'Argentina' }),
        expect.objectContaining({ attribute: 'region', operator: '=', value: 'Mendoza' }),
        expect.objectContaining({ attribute: 'grape_primary', operator: '=', value: 'Malbec' }),
        expect.objectContaining({ attribute: 'wine_type', operator: '=', value: 'red' }),
      ]),
    );
  });

  it('rescues failed exact-vintage compare sides through authoritative entity search', async () => {
    const mockDecomposedSearchExecute = vi.fn().mockResolvedValue({
      queryType: 'comparison',
      originalQuery: 'Opus One 2018 vs Almaviva 2019',
      comparisonIntent: 'compare',
      entities: [
        {
          subQuery: 'opus one 2018',
          comparisonMode: 'entity',
          topResult: null,
          resultCount: 0,
          resolutionStatus: 'failed',
          allResults: [],
        },
        {
          subQuery: 'almaviva 2019',
          comparisonMode: 'entity',
          topResult: null,
          resultCount: 0,
          resolutionStatus: 'ambiguous',
          allResults: [],
        },
      ],
      overallStatus: 'failed',
      requestId: 'req-123',
      executionTimeMs: 12,
    });
    deps = {
      ...deps,
      decomposedSearchExecute: mockDecomposedSearchExecute,
    };
    vi.mocked(mockSearchUseCase.execute)
      .mockResolvedValueOnce(makeSearchResponse([
        {
          entity: { entityId: 'opus-one-2018', canonicalLabel: 'Opus One 2018', type: 'wine', vintage: 2018, wineType: 'red' },
          match: { matchType: 'entity', scoreComponents: { lexical: 1, semantic: 1, attribute: 1, popularity: 1, preferenceAlignment: 1 } },
          relevanceScore: 0.99,
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.99, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
      ]))
      .mockResolvedValueOnce(makeSearchResponse([
        {
          entity: { entityId: 'almaviva-2019', canonicalLabel: 'Almaviva 2019', type: 'wine', vintage: 2019, wineType: 'red' },
          match: { matchType: 'entity', scoreComponents: { lexical: 1, semantic: 1, attribute: 1, popularity: 1, preferenceAlignment: 1 } },
          relevanceScore: 0.98,
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.98, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
      ]));

    const result = await executeAgentTool(
      'compare_wines',
      {
        query_a: 'Opus One 2018',
        query_b: 'Almaviva 2019',
        vintage_min_a: 2018,
        vintage_max_a: 2018,
        vintage_min_b: 2019,
        vintage_max_b: 2019,
      },
      deps,
      'req-123',
    );

    expect(mockSearchUseCase.execute).toHaveBeenCalledTimes(2);
    expect(result.observation).toContain('Opus One 2018');
    expect(result.observation).toContain('Almaviva 2019');
    expect(result.observation).toContain('entity_id: opus-one-2018');
    expect(result.observation).toContain('entity_id: almaviva-2019');
  });

  it.each([
    { field: 'country', queryA: 'France', queryB: 'Italy', value: 'France' },
    { field: 'region', queryA: 'Bordeaux', queryB: 'Burgundy', value: 'Bordeaux' },
    { field: 'appellation', queryA: 'Barolo', queryB: 'Brunello di Montalcino', value: 'Barolo' },
    { field: 'grape_primary', queryA: 'Pinot Noir', queryB: 'Syrah', value: 'Pinot Noir' },
    { field: 'wine_type', queryA: 'red', queryB: 'white', value: 'red' },
  ] as const)('strips side-specific shared compare $field constraints', ({ field, queryA, queryB, value }) => {
    const input = {
      query_a: queryA,
      query_b: queryB,
      max_price_krw: 100_000,
      [field]: value,
    };

    const stripped = stripSideSpecificCompareSharedConstraints(input);

    expect(stripped).not.toHaveProperty(field);
    expect(stripped).toMatchObject({
      query_a: queryA,
      query_b: queryB,
      max_price_krw: 100_000,
    });
  });

  it('preserves shared compare constraints that do not identify exactly one comparison side', () => {
    const input = {
      query_a: 'Barolo',
      query_b: 'Brunello di Montalcino',
      country: 'Italy',
      max_price_krw: 100_000,
    };

    expect(stripSideSpecificCompareSharedConstraints(input)).toEqual(input);
  });

  it('forwards occasion and suitability constraints as structured preferences', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'search_wines',
      {
        query: '와인 초보자 선물',
        occasion: ['gift'],
        gift_suitability_min: 0.8,
        beginner_suitability_min: 0.7,
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls.at(-1) ?? [];
    expect(request?.preferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: 'occasion', operator: 'in', value: ['gift'] }),
      expect.objectContaining({ attribute: 'gift_suitability', operator: '>=', value: 0.8 }),
      expect.objectContaining({ attribute: 'beginner_suitability', operator: '>=', value: 0.7 }),
    ]));
    expect(request?.filters).toBeUndefined();
  });

  it('keeps representative anchor queries free of duplicated structured recommendation clauses', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'search_wines',
      {
        query: 'Opus One anniversary gift',
        occasion: ['anniversary'],
        styles: ['approachable'],
        max_price_krw: 50_000,
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls.at(-1) ?? [];
    expect(request?.query).toBe('opus one');
    expect(request?.query).not.toContain('anniversary');
    expect(request?.query).not.toContain('approachable');
    expect(request?.query).not.toContain('50000원 이하');
    expect(request?.preferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: 'occasion', operator: 'in', value: ['anniversary'] }),
      expect.objectContaining({ attribute: 'style', operator: 'in', value: ['approachable'] }),
    ]));
    expect(request?.filters).toBeUndefined();
  });

  it('suppresses duplicated structured entity clauses when typed filters already cover recommendation anchors', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'search_wines',
      {
        query: 'best Bordeaux under 100 dollars',
        region: 'Bordeaux',
        max_price_krw: 135_000,
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls.at(-1) ?? [];
    expect(request?.query).toBe('wine');
    expect(request?.query).not.toContain('bordeaux');
    expect(request?.query).not.toContain('135000원 이하');
  });

  it('retains wine type semantics when typed geography filters suppress duplicated lexical anchors', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'search_wines',
      {
        query: '이탈리아 레드 가성비',
        country: 'Italy',
        wine_type: 'red',
        max_price_krw: 50_000,
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls.at(-1) ?? [];
    expect(request?.query).toBe('red wine');
    expect(request?.query).not.toContain('italy');
    expect(request?.query).not.toContain('50000원 이하');
  });

  it('forwards drinking-window objective as a structured preference', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'search_wines',
      {
        query: '이탈리아 레드',
        drinking_window: 'now',
        drinking_window_target_year: 2026,
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls.at(-1) ?? [];
    expect(request?.preferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: 'drinking_window', operator: '=', value: 2026 }),
    ]));
  });

  it('post-filters results using structured exclusion inputs', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([
        {
          entity: {
            entityId: 'wine-1',
            canonicalLabel: 'House Merlot',
            type: 'wine',
            grapes: ['Merlot'],
            region: 'France',
          },
          relevanceScore: 0.9,
          match: {
            matchType: 'hybrid',
            scoreComponents: {
              lexical: 0.8,
              semantic: 0.8,
              attribute: 0.8,
              popularity: 0.5,
              preferenceAlignment: 0.5,
            },
          },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
        {
          entity: {
            entityId: 'wine-2',
            canonicalLabel: 'Syrah Reserve',
            type: 'wine',
            grapes: ['Syrah'],
            region: 'Spain',
          },
          relevanceScore: 0.8,
          match: {
            matchType: 'hybrid',
            scoreComponents: {
              lexical: 0.7,
              semantic: 0.7,
              attribute: 0.7,
              popularity: 0.5,
              preferenceAlignment: 0.5,
            },
          },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.8, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
      ]),
    );

    const result = await executeAgentTool(
      'search_wines',
      {
        query: '레드 와인 추천',
        exclude_grapes: ['Merlot'],
        exclude_regions: ['France'],
      },
      deps,
      'req-123',
    );

    const filtered = result.rawResult as SearchResponseV1;
    expect(filtered.results).toHaveLength(1);
    expect(filtered.results[0]?.entity.canonicalLabel).toBe('Syrah Reserve');
    expect(result.observation).toContain('Excluded 1 result(s)');
    expect(result.observation).toContain('merlot');
    expect(result.observation).toContain('france');
  });

  it('keeps raw-query negation filtering working for existing prompts', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([
        {
          entity: {
            entityId: 'wine-1',
            canonicalLabel: 'House Merlot',
            type: 'wine',
            grapes: ['Merlot'],
          },
          relevanceScore: 0.9,
          match: {
            matchType: 'hybrid',
            scoreComponents: {
              lexical: 0.8,
              semantic: 0.8,
              attribute: 0.8,
              popularity: 0.5,
              preferenceAlignment: 0.5,
            },
          },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
        {
          entity: {
            entityId: 'wine-2',
            canonicalLabel: 'Syrah Reserve',
            type: 'wine',
            grapes: ['Syrah'],
          },
          relevanceScore: 0.8,
          match: {
            matchType: 'hybrid',
            scoreComponents: {
              lexical: 0.7,
              semantic: 0.7,
              attribute: 0.7,
              popularity: 0.5,
              preferenceAlignment: 0.5,
            },
          },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.8, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
      ]),
    );

    const result = await executeAgentTool(
      'search_wines',
      { query: 'red wine not Merlot' },
      deps,
      'req-123',
    );

    const filtered = result.rawResult as SearchResponseV1;
    expect(filtered.results).toHaveLength(1);
    expect(filtered.results[0]?.entity.canonicalLabel).toBe('Syrah Reserve');
  });

  it('returns NEGATION_FALLBACK with unfiltered results when all results match negation terms', async () => {
    // Regression: previously returned "검색 결과가 없습니다" with empty rawResult when
    // all results matched the exclusion filter. This caused the agent to give up with
    // "찾을 수 없었습니다" even when relevant wines existed in the index (wrong grape listed).
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([
        {
          entity: {
            entityId: 'wine-1',
            canonicalLabel: 'Chateau Margaux Cabernet Sauvignon',
            type: 'wine',
            grapes: ['Cabernet Sauvignon'],
          },
          relevanceScore: 0.9,
          match: {
            matchType: 'hybrid',
            scoreComponents: { lexical: 0.8, semantic: 0.8, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 },
          },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
      ]),
    );

    const result = await executeAgentTool(
      'search_wines',
      { query: 'red wine not Cabernet Sauvignon', exclude_grapes: ['Cabernet Sauvignon'] },
      deps,
      'req-123',
    );

    // Must NOT return empty — returns unfiltered results with NEGATION_FALLBACK instruction.
    expect(result.observation).toContain('NEGATION_FALLBACK');
    expect(result.observation).toContain('YOU MUST skip');
    // rawResult should contain the original (unfiltered) results so agent can find alternatives.
    const raw = result.rawResult as SearchResponseV1;
    expect(raw.results).toHaveLength(1);
  });

  it('tags observation with RETRIEVAL_QUALITY: reliable when ≥3 results and few constraints', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([
        {
          entity: { entityId: 'wine-1', canonicalLabel: 'Wine A', type: 'wine' },
          relevanceScore: 0.9,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.8, semantic: 0.8, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
        {
          entity: { entityId: 'wine-2', canonicalLabel: 'Wine B', type: 'wine' },
          relevanceScore: 0.8,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.7, semantic: 0.7, attribute: 0.7, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.8, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
        {
          entity: { entityId: 'wine-3', canonicalLabel: 'Wine C', type: 'wine' },
          relevanceScore: 0.7,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.6, semantic: 0.6, attribute: 0.6, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.7, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
      ]),
    );

    const result = await executeAgentTool('search_wines', { query: '레드 와인 추천' }, deps, 'req-123');
    expect(result.observation).toContain('RETRIEVAL_QUALITY: reliable');
    expect(result.observation).toContain('GROUNDING_JSON:');
  });

  it('includes structured GROUNDING_JSON with returned wine labels', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([
        {
          entity: {
            entityId: 'wine-1',
            canonicalLabel: 'Wine A',
            type: 'wine',
            region: 'Bordeaux',
            country: 'France',
            grapes: ['Merlot'],
          },
          relevanceScore: 0.9,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.8, semantic: 0.8, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
      ]),
    );

    const result = await executeAgentTool('search_wines', { query: '보르도 추천' }, deps, 'req-123');
    expect(result.observation).toContain('GROUNDING_JSON:');
    expect(result.observation).toContain('"canonical_label":"Wine A"');
    expect(result.observation).toContain('"region":"Bordeaux"');
    expect(result.observation).toContain('"country":"France"');
  });

  it('selects recipient-profile evidence coverage for first-time parents summaries', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([
        {
          entity: {
            entityId: 'wine-beaujolais-1',
            canonicalLabel: 'Beaujolais Village',
            type: 'wine',
            region: 'Beaujolais',
            grapes: ['Gamay'],
            wineType: 'red',
            sweetness: 0.02,
          },
          relevanceScore: 0.98,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.9, semantic: 0.9, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: ['recipient_profile'], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
        {
          entity: {
            entityId: 'wine-beaujolais-2',
            canonicalLabel: 'Second Gamay',
            type: 'wine',
            region: 'Beaujolais',
            grapes: ['Gamay'],
            wineType: 'red',
            sweetness: 0.01,
          },
          relevanceScore: 0.97,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.9, semantic: 0.9, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: ['recipient_profile'], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
        {
          entity: {
            entityId: 'wine-napa-red',
            canonicalLabel: 'Napa Cabernet',
            type: 'wine',
            region: 'Napa Valley',
            grapes: ['Cabernet Sauvignon'],
            wineType: 'red',
            tannin: 0.8,
            sweetness: 0.01,
          },
          relevanceScore: 0.96,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.9, semantic: 0.9, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
        {
          entity: {
            entityId: 'wine-light-rose',
            canonicalLabel: 'Gentle Light Rose',
            type: 'wine',
            grapes: ['Grenache'],
            wineType: 'rosé',
            style: 'light rosé',
            tannin: 0.1,
            body: 0.3,
            sweetness: 0.25,
          },
          relevanceScore: 0.68,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.6, semantic: 0.6, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: ['recipient_profile'], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
        {
          entity: {
            entityId: 'wine-moscato',
            canonicalLabel: 'Sweet Moscato',
            type: 'wine',
            grapes: ['Moscato'],
            wineType: 'sparkling',
            style: 'slightly sweet',
            sweetness: 0.45,
          },
          relevanceScore: 0.70,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.6, semantic: 0.6, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: ['recipient_profile', 'sweetness'], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
      ]),
    );

    const result = await executeAgentTool(
      'search_wines',
      {
        query: '와인 처음 마시는 부모님께 달콤한 와인 추천',
        recipient_profile: 'parents_first_time',
      },
      deps,
      'req-123',
    );

    expect(result.observation).toContain('Sweet Moscato');
    expect(result.observation).toContain('Gentle Light Rose');
    expect(result.observation).toContain('Beaujolais Village');
    expect(result.observation.indexOf('Sweet Moscato')).toBeLessThan(result.observation.indexOf('Gentle Light Rose'));
    expect(result.observation.indexOf('Gentle Light Rose')).toBeLessThan(result.observation.indexOf('Beaujolais Village'));
    expect(result.observation).not.toContain('Second Gamay');
    expect(result.observation).not.toContain('Napa Cabernet');
    expect(result.observation).toContain('"recipient_profile":"parents_first_time"');
    expect(result.observation).toContain('"profile_evidence":["sweet_light","fruit_forward"]');
    expect(result.observation).toContain('"profile_evidence":["sweet_light","light_rose","soft_structure"]');
    expect(result.observation).toContain('"profile_evidence":["fruit_forward","low_tannin_red"]');
    expect(result.observation).toContain('"claimable_attributes":[');
    expect(result.observation).toContain('"profile_evidence:light_rose"');
    expect(result.observation).toContain('"matched_constraint:recipient_profile"');
    const marker = 'GROUNDING_JSON: ';
    const markerIndex = result.observation.lastIndexOf(marker);
    const grounding = JSON.parse(result.observation.slice(markerIndex + marker.length)) as {
      readonly wines: readonly { readonly canonical_label: string }[];
    };
    expect(grounding.wines.map((wine) => wine.canonical_label)).toEqual([
      'Sweet Moscato',
      'Gentle Light Rose',
      'Beaujolais Village',
    ]);
  });

  it('marks non-resolved search results as unconfirmed candidates before grounding JSON', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([
        {
          entity: {
            entityId: 'wine-1',
            canonicalLabel: 'Candidate A',
            type: 'wine',
          },
          relevanceScore: 0.9,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.8, semantic: 0.8, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
      ], {
        retrievalMode: 'entity_lookup',
        engineDecision: {
          decisionStatus: 'ambiguous',
          nextAction: 'clarify',
        },
      }),
    );

    const result = await executeAgentTool('search_wines', { query: '모호한 와인', retrieval_mode: 'entity' }, deps, 'req-123');
    expect(result.observation).toContain('RESOLUTION_NOT_CONFIRMED');
    expect(result.observation).toContain('do not state any candidate as the confirmed exact match');
    expect(result.observation).toContain('GROUNDING_JSON:');
  });

  it('marks resolved exact-name collisions as unconfirmed when labels violate the exact lookup contract', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([
        {
          entity: {
            entityId: 'wine-1',
            canonicalLabel: '2012 Château Pétrus Saute-Loup Reserve de la Famille Pomerol',
            producer: 'Château Pétrus',
            type: 'wine',
          },
          relevanceScore: 0.9,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.8, semantic: 0.8, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
      ], {
        retrievalMode: 'entity_lookup',
        engineDecision: {
          decisionStatus: 'resolved',
          nextAction: 'return',
        },
      }),
    );

    const result = await executeAgentTool('search_wines', { query: '페트뤼스', retrieval_mode: 'entity' }, deps, 'req-123');
    expect(result.observation).toContain('RESOLUTION_NOT_CONFIRMED');
    expect(result.observation).toContain('Exact-label contract target=Pétrus');
    expect(result.observation).toContain('do not state any candidate as the confirmed exact match');
  });

  it('does not mark exact-name vintage labels as collisions', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([
        {
          entity: {
            entityId: 'wine-1',
            canonicalLabel: 'Pétrus 2016',
            producer: 'Pétrus',
            type: 'wine',
          },
          relevanceScore: 0.9,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.8, semantic: 0.8, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
      ], {
        retrievalMode: 'entity_lookup',
        engineDecision: {
          decisionStatus: 'resolved',
          nextAction: 'return',
        },
      }),
    );

    const result = await executeAgentTool('search_wines', { query: '페트뤼스', retrieval_mode: 'entity' }, deps, 'req-123');
    expect(result.observation).not.toContain('RESOLUTION_NOT_CONFIRMED');
    expect(result.observation).toContain('Pétrus 2016');
  });

  it('marks curated brand-family surfaces as non-exact even when search returns concrete wines', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([
        {
          entity: {
            entityId: 'wine-1',
            canonicalLabel: 'Moët & Chandon Brut Impérial NV',
            producer: 'Moët & Chandon',
            type: 'wine',
          },
          relevanceScore: 0.9,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.8, semantic: 0.8, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
      ], {
        retrievalMode: 'attribute_search',
        engineDecision: {
          decisionStatus: 'resolved',
          nextAction: 'return',
        },
      }),
    );

    const result = await executeAgentTool('search_wines', { query: '모엣' }, deps, 'req-123');
    expect(result.observation).toContain('RESOLUTION_NOT_CONFIRMED');
    expect(result.observation).toContain('brand family, not a single cuvee');
    expect(result.observation).toContain('do not state any candidate as the confirmed exact match');
    expect(result.observation).not.toContain('Moet & Chandon Brut Imperial');
  });

  it('marks non-exact intent around a known label as unconfirmed exact lookup evidence', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([
        {
          entity: {
            entityId: 'wine-1',
            canonicalLabel: 'Sassicaia 2018',
            producer: 'Tenuta San Guido',
            type: 'wine',
          },
          relevanceScore: 0.9,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.8, semantic: 0.8, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
      ], {
        retrievalMode: 'recommendation',
        resultType: 'entity_set',
        engineDecision: {
          decisionStatus: 'resolved',
          nextAction: 'return',
        },
      }),
    );

    const result = await executeAgentTool('search_wines', { query: '사씨카이아 스타일' }, deps, 'req-123');
    expect(result.observation).toContain('RESOLUTION_NOT_CONFIRMED');
    expect(result.observation).toContain('non-exact lookup intent around Sassicaia');
    expect(result.observation).toContain('not a single confirmed wine entity request');
    expect(result.observation).not.toContain('Sassicaia 2018');
  });

  it('marks descriptive category surfaces as non-exact exact lookup evidence', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([
        {
          entity: {
            entityId: 'wine-1',
            canonicalLabel: '2021 Columbia Crest Soft Merlot',
            producer: 'Columbia Crest',
            type: 'wine',
          },
          relevanceScore: 0.9,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.8, semantic: 0.8, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
      ], {
        retrievalMode: 'attribute_search',
        resultType: 'entity_set',
        engineDecision: {
          decisionStatus: 'resolved',
          nextAction: 'return',
        },
      }),
    );

    const result = await executeAgentTool('search_wines', { query: '메를로 명작' }, deps, 'req-123');
    expect(result.observation).toContain('RESOLUTION_NOT_CONFIRMED');
    expect(result.observation).toContain('descriptive grape category');
    expect(result.observation).toContain('not a single wine entity');
    expect(result.observation).not.toContain('2021 Columbia Crest Soft Merlot');
  });

  it('keeps descriptive non-exact guard after search query augmentation', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([
        {
          entity: {
            entityId: 'wine-1',
            canonicalLabel: '2021 Columbia Crest Soft Merlot',
            producer: 'Columbia Crest',
            type: 'wine',
          },
          relevanceScore: 0.9,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.8, semantic: 0.8, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
      ], {
        retrievalMode: 'attribute_search',
        resultType: 'entity_set',
        engineDecision: {
          decisionStatus: 'resolved',
          nextAction: 'return',
        },
      }),
    );

    const result = await executeAgentTool('search_wines', { query: '메를로 명작 Merlot wine, Merlot' }, deps, 'req-123');
    expect(result.observation).toContain('RESOLUTION_NOT_CONFIRMED');
    expect(result.observation).toContain('descriptive grape category');
    expect(result.observation).not.toContain('2021 Columbia Crest Soft Merlot');
  });

  it('does not apply exact-match uncertainty guard to recommendation candidate sets', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([
        {
          entity: {
            entityId: 'wine-1',
            canonicalLabel: 'Candidate A',
            type: 'wine',
          },
          relevanceScore: 0.9,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.8, semantic: 0.8, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
        {
          entity: {
            entityId: 'wine-2',
            canonicalLabel: 'Candidate B',
            type: 'wine',
          },
          relevanceScore: 0.8,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.7, semantic: 0.7, attribute: 0.7, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.8, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
      ], {
        resultType: 'entity_set',
        engineDecision: {
          decisionStatus: 'ambiguous',
          nextAction: 'clarify',
        },
      }),
    );

    const result = await executeAgentTool('search_wines', { query: '상사 선물 와인 추천' }, deps, 'req-123');

    expect(result.observation).not.toContain('RESOLUTION_NOT_CONFIRMED');
    expect(result.observation).not.toContain('Ask a targeted clarification');
    expect(result.observation).toContain('GROUNDING_JSON:');
  });

  it('keeps lineage in observation but omits source_record_refs from GROUNDING_JSON when present', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([
        {
          entity: {
            entityId: 'wine-1',
            canonicalLabel: 'Wine A',
            type: 'wine',
            sourceRecordRefs: [
              { sourceSystem: SOURCE_SYSTEM_VIVINO_SILVER, sourceRecordId: 'ref-abc' },
            ],
          },
          relevanceScore: 0.9,
          match: {
            matchType: 'hybrid',
            scoreComponents: {
              lexical: 0.8,
              semantic: 0.8,
              attribute: 0.8,
              popularity: 0.5,
              preferenceAlignment: 0.5,
            },
          },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
      ]),
    );

    const result = await executeAgentTool('search_wines', { query: 'test lineage' }, deps, 'req-123');
    expect(result.observation).toContain(`lineage: ${SOURCE_SYSTEM_VIVINO_SILVER}:ref-abc`);
    expect(result.observation).not.toContain('"source_record_refs"');
    expect(result.observation).not.toContain(`"source_system":"${SOURCE_SYSTEM_VIVINO_SILVER}"`);
    expect(result.observation).not.toContain('"source_record_id":"ref-abc"');
  });

  it('uses deterministic coverage selection for want_diversity observations', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([
        {
          entity: { entityId: 'wine-red-1', canonicalLabel: 'Red A', type: 'wine', producer: 'Producer A', region: 'Napa Valley', wineType: 'red', style: 'bold' },
          relevanceScore: 0.95,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.9, semantic: 0.9, attribute: 0.9, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.95, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
        {
          entity: { entityId: 'wine-red-2', canonicalLabel: 'Red B', type: 'wine', producer: 'Producer B', region: 'Bordeaux', wineType: 'red', style: 'structured' },
          relevanceScore: 0.91,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.85, semantic: 0.85, attribute: 0.85, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.91, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
        {
          entity: { entityId: 'wine-white-1', canonicalLabel: 'White A', type: 'wine', producer: 'Producer C', region: 'Mosel', wineType: 'white', style: 'crisp' },
          relevanceScore: 0.89,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.82, semantic: 0.82, attribute: 0.82, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.89, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
        {
          entity: { entityId: 'wine-spark-1', canonicalLabel: 'Sparkling A', type: 'wine', producer: 'Producer D', region: 'Champagne', wineType: 'sparkling', style: 'sparkling' },
          relevanceScore: 0.87,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.8, semantic: 0.8, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.87, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
      ]),
    );

    const result = await executeAgentTool(
      'search_wines',
      { query: '선물용 다양하게 추천', want_diversity: true },
      deps,
      'req-123',
    );

    expect(result.observation).toContain('wine_type: red');
    expect(result.observation).toContain('wine_type: white');
    expect(result.observation).toContain('wine_type: sparkling');
    expect(result.observation).not.toContain('4. ');

    const groundingJsonMarker = 'GROUNDING_JSON: ';
    const groundingJson = result.observation.slice(
      result.observation.lastIndexOf(groundingJsonMarker) + groundingJsonMarker.length,
    );
    expect(groundingJson).toContain('"entity_id":"wine-red-1"');
    expect(groundingJson).toContain('"entity_id":"wine-white-1"');
    expect(groundingJson).toContain('"entity_id":"wine-spark-1"');
    expect(groundingJson).not.toContain('"entity_id":"wine-red-2"');
    expect(groundingJson).toContain('"wine_type":"sparkling"');
  });

  it('tags observation with RETRIEVAL_QUALITY: unreliable when 0 results', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(makeSearchResponse([]));
    const result = await executeAgentTool('search_wines', { query: '레드 와인 추천' }, deps, 'req-123');
    expect(result.observation).toContain('RETRIEVAL_QUALITY: unreliable');
  });

  // BUG-DS02: LLMs routinely emit numeric fields as strings ("3" instead of 3).
  // zod-coerce schemas must silently coerce these to numbers.
  it('coerces string limit to number (BUG-DS02)', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(makeSearchResponse([]));
    await expect(
      executeAgentTool('search_wines', { query: '레드 와인', limit: '5' }, deps, 'req-123'),
    ).resolves.not.toThrow();
    const [req] = vi.mocked(mockSearchUseCase.execute).mock.calls[0] ?? [];
    expect(req?.limit).toBe(5);
  });

  it('coerces string max_price_krw to number (BUG-DS02)', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(makeSearchResponse([]));
    await executeAgentTool('search_wines', { query: '와인', max_price_krw: '50000' }, deps, 'req-123');
    const [req] = vi.mocked(mockSearchUseCase.execute).mock.calls[0] ?? [];
    const parsed = (await import('../../../../src/domain/query/service/search-constraint-extractor.js')).extractSearchConstraints(req!.query);
    expect(parsed.maxPriceKrw).toBe(50_000);
  });

  it('coerces string min_price_krw to number and preserves range in query text', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(makeSearchResponse([]));
    await executeAgentTool(
      'search_wines',
      { query: '집들이 선물용 와인', min_price_krw: '10000', max_price_krw: '20000' },
      deps,
      'req-123',
    );
    const [req] = vi.mocked(mockSearchUseCase.execute).mock.calls.at(-1) ?? [];
    expect(req?.query).toContain('1~2만원');
    const parsed = (await import('../../../../src/domain/query/service/search-constraint-extractor.js')).extractSearchConstraints(req!.query);
    expect(parsed.minPriceKrw).toBe(10_000);
    expect(parsed.maxPriceKrw).toBe(20_000);
  });

  it('price post-filter: drops wines with USD price above max_price_krw budget', async () => {
    // 100000 KRW ≈ $74.07 USD. Wine at $80 should be dropped; wine at $60 should be kept.
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([
        {
          entity: { entityId: 'wine-cheap', canonicalLabel: 'Budget Blanc', type: 'wine', priceRange: '$60' },
          relevanceScore: 0.9,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.8, semantic: 0.8, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
        {
          entity: { entityId: 'wine-pricey', canonicalLabel: 'Pricey Rouge', type: 'wine', priceRange: '$80' },
          relevanceScore: 0.85,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.7, semantic: 0.7, attribute: 0.7, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.85, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
      ]),
    );

    const result = await executeAgentTool('search_wines', { query: '10만원 이하', max_price_krw: 100_000 }, deps, 'req-123');
    const filtered = result.rawResult as SearchResponseV1;
    expect(filtered.results).toHaveLength(1);
    expect(filtered.results[0]?.entity.entityId).toBe('wine-cheap');
  });

  it('alcohol preference: keeps known over-ceiling wines but demotes them behind compliant results', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([
        {
          entity: { entityId: 'wine-low', canonicalLabel: 'Low Alcohol Moscato', type: 'wine', alcoholPct: 7.5 },
          relevanceScore: 0.9,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.8, semantic: 0.8, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
        {
          entity: { entityId: 'wine-high', canonicalLabel: 'High Alcohol Red', type: 'wine', alcoholPct: 14.5 },
          relevanceScore: 0.85,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.7, semantic: 0.7, attribute: 0.7, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.85, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
        {
          entity: { entityId: 'wine-unknown', canonicalLabel: 'Unknown Alcohol Sparkling', type: 'wine' },
          relevanceScore: 0.8,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.7, semantic: 0.7, attribute: 0.7, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.8, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
      ]),
    );

    const result = await executeAgentTool('search_wines', { query: '도수 낮은 달달한 와인', max_alcohol_pct: 12 }, deps, 'req-123');
    const filtered = result.rawResult as SearchResponseV1;
    expect(filtered.results.map((item) => item.entity.entityId)).toEqual(['wine-low', 'wine-unknown', 'wine-high']);
    expect(result.observation).toContain('[ALCOHOL_PREFERENCE: 12% 이하를 우선 정렬했습니다.');
    expect(result.observation).toContain('뒤로 보냈고');
  });

  it('preserves parseable GROUNDING_JSON when long observations are capped', async () => {
    const longLineage = 'lineage-segment-'.repeat(80);
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([
        {
          entity: {
            entityId: 'wine-1',
            canonicalLabel: 'Long Wine One',
            type: 'wine',
            region: 'Napa Valley',
            priceRange: '$10',
            sourceRecordRefs: [{ sourceSystem: longLineage, sourceRecordId: longLineage }],
          },
          relevanceScore: 0.9,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.8, semantic: 0.8, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
        {
          entity: {
            entityId: 'wine-2',
            canonicalLabel: 'Long Wine Two',
            type: 'wine',
            region: 'Burgundy',
            priceRange: '$12',
            sourceRecordRefs: [{ sourceSystem: longLineage, sourceRecordId: longLineage }],
          },
          relevanceScore: 0.8,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.7, semantic: 0.7, attribute: 0.7, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.8, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
      ]),
    );

    const result = await executeAgentTool('search_wines', { query: '긴 결과' }, deps, 'req-123');
    const marker = 'GROUNDING_JSON: ';
    const markerIndex = result.observation.lastIndexOf(marker);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    expect(() => JSON.parse(result.observation.slice(markerIndex + marker.length))).not.toThrow();
  });

  it('keeps GROUNDING_JSON parseable when the grounding payload itself exceeds the cap', async () => {
    const longText = 'very-long-grounding-field-'.repeat(30);
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse(
        Array.from({ length: 5 }, (_, index) => ({
          entity: {
            entityId: `wine-heavy-${index}`,
            canonicalLabel: `${longText}${index}`,
            type: 'wine',
            producer: `${longText}producer-${index}`,
            region: `${longText}region-${index}`,
            wineType: 'red',
            grapes: [`${longText}grape-a`, `${longText}grape-b`, `${longText}grape-c`],
            style: `${longText}style-${index}`,
            priceRange: '$10',
          },
          relevanceScore: 0.9 - index * 0.01,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.8, semantic: 0.8, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        })),
      ),
    );

    const result = await executeAgentTool('search_wines', { query: '긴 grounding 결과' }, deps, 'req-123');
    const marker = 'GROUNDING_JSON: ';
    const markerIndex = result.observation.lastIndexOf(marker);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    expect(result.observation.length).toBeLessThanOrEqual(2000);
    const parsed = JSON.parse(result.observation.slice(markerIndex + marker.length)) as { truncated_for_observation_cap?: boolean };
    expect(parsed.truncated_for_observation_cap).toBe(true);
  });

  it('price post-filter: drops wines with no price data (strict budget enforcement)', async () => {
    // Regression: previously wines with priceRange=undefined passed the filter,
    // letting budget-violating unpriced wines through. Now they are dropped.
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([
        {
          entity: { entityId: 'wine-priced', canonicalLabel: 'Priced Wine', type: 'wine', priceRange: '$30' },
          relevanceScore: 0.9,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.8, semantic: 0.8, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
        {
          entity: { entityId: 'wine-nodata', canonicalLabel: 'Unknown Price Wine', type: 'wine' },
          relevanceScore: 0.85,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.7, semantic: 0.7, attribute: 0.7, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.85, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
      ]),
    );

    const result = await executeAgentTool('search_wines', { query: '5만원 이하', max_price_krw: 50_000 }, deps, 'req-123');
    const filtered = result.rawResult as SearchResponseV1;
    // wine-nodata has no price → dropped under strict budget enforcement
    expect(filtered.results).toHaveLength(1);
    expect(filtered.results[0]?.entity.entityId).toBe('wine-priced');
  });

  it('price post-filter: falls back to lenient mode when strict filter removes all results', async () => {
    // When ALL results have no price data, strict filtering would leave 0 results.
    // Fallback allows unpriced wines through so agent can still respond.
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([
        {
          entity: { entityId: 'wine-a', canonicalLabel: 'Wine A', type: 'wine' },
          relevanceScore: 0.9,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.8, semantic: 0.8, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
        {
          entity: { entityId: 'wine-b', canonicalLabel: 'Wine B', type: 'wine' },
          relevanceScore: 0.8,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.7, semantic: 0.7, attribute: 0.7, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.8, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
      ]),
    );

    const result = await executeAgentTool('search_wines', { query: '편의점 와인', max_price_krw: 15_000 }, deps, 'req-123');
    const filtered = result.rawResult as SearchResponseV1;
    // Strict filter drops both (no price data), lenient fallback keeps both
    expect(filtered.results).toHaveLength(2);
    expect(result.observation).not.toContain('검색 결과가 없습니다');
  });

  it('price post-filter: enforces min/max KRW range when both bounds are present', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([
        {
          entity: { entityId: 'wine-low', canonicalLabel: 'Cheap Wine', type: 'wine', priceRange: '$5' },
          relevanceScore: 0.9,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.8, semantic: 0.8, attribute: 0.8, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
        {
          entity: { entityId: 'wine-mid', canonicalLabel: 'Housewarming Pick', type: 'wine', priceRange: '$12' },
          relevanceScore: 0.88,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.78, semantic: 0.78, attribute: 0.78, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.88, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
        {
          entity: { entityId: 'wine-high', canonicalLabel: 'Over Budget', type: 'wine', priceRange: '$25' },
          relevanceScore: 0.85,
          match: { matchType: 'hybrid', scoreComponents: { lexical: 0.75, semantic: 0.75, attribute: 0.75, popularity: 0.5, preferenceAlignment: 0.5 } },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.85, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
      ]),
    );

    const result = await executeAgentTool(
      'search_wines',
      { query: '집들이 선물용 와인', min_price_krw: 10_000, max_price_krw: 20_000 },
      deps,
      'req-123',
    );
    const filtered = result.rawResult as SearchResponseV1;
    expect(filtered.results).toHaveLength(1);
    expect(filtered.results[0]?.entity.entityId).toBe('wine-mid');
    expect(result.observation).toContain('10000원 이상 20000원 이하');
    expect(result.observation).toContain('(~16,200원)');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Regression: Bug 1 — enriched query must not exceed security gate (MAX_QUERY_LENGTH=500)
  // Previously MAX_ENRICHED_QUERY_LEN=700 caused enriched queries to be blocked by
  // the 500-char security gate in query-sanitizer.ts.
  // ──────────────────────────────────────────────────────────────────────────
  it('enriched query never exceeds MAX_QUERY_LENGTH (500) even with long base query and clauses', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(makeSearchResponse([]));

    // Base query at exactly 490 chars — just under the limit but with clauses would exceed
    const longBase = '레드 와인 '.repeat(60).slice(0, 490);
    await executeAgentTool(
      'search_wines',
      {
        query: longBase,
        exclude_grapes: ['Merlot', 'Cabernet Sauvignon', 'Pinot Noir'],
        exclude_regions: ['France', 'Italy'],
        max_price_krw: 50_000,
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0] ?? [];
    expect(request?.query.length).toBeLessThanOrEqual(500);
  });

  it('enriched query with short base and many clauses stays within 500 chars', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(makeSearchResponse([]));

    await executeAgentTool(
      'search_wines',
      {
        query: '레드 와인',
        exclude_grapes: ['Merlot', 'Cabernet Sauvignon'],
        exclude_regions: ['France'],
        max_price_krw: 50_000,
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0] ?? [];
    expect(request?.query.length).toBeLessThanOrEqual(500);
  });

  describe('search_wines corpus_limited signal', () => {
    it('emits corpus_limited when wine type has few entities', async () => {
      const { InMemoryCorpusCardinalityCache } = await import(
        '../../../../src/domain/retrieval/service/corpus-cardinality-cache.js'
      );
      const cache = new InMemoryCorpusCardinalityCache(
        new Map([['red', 7000], ['sparkling', 50]]),
      );
      const mockSearch = vi.fn().mockResolvedValue(makeSearchResponse([]));
      const depsWithCardinality: AgentToolDeps = {
        ...deps,
        searchUseCase: { execute: mockSearch } as unknown as SearchExecutorPort,
        corpusCardinality: cache,
      };
      const result = await executeAgentTool(
        'search_wines',
        { query: '프로세코 추천', wine_type: 'sparkling' },
        depsWithCardinality,
        'req-123',
      );
      expect(result.observation).toContain('RETRIEVAL_QUALITY: corpus_limited');
      expect(result.observation).not.toContain('unreliable');
    });

    it('emits unreliable for large corpus with 0 results', async () => {
      const { InMemoryCorpusCardinalityCache } = await import(
        '../../../../src/domain/retrieval/service/corpus-cardinality-cache.js'
      );
      const cache = new InMemoryCorpusCardinalityCache(
        new Map([['red', 7000]]),
      );
      const mockSearch = vi.fn().mockResolvedValue(makeSearchResponse([]));
      const depsWithCardinality: AgentToolDeps = {
        ...deps,
        searchUseCase: { execute: mockSearch } as unknown as SearchExecutorPort,
        corpusCardinality: cache,
      };
      const result = await executeAgentTool(
        'search_wines',
        { query: '2025 Opus One' },
        depsWithCardinality,
        'req-123',
      );
      expect(result.observation).toContain('RETRIEVAL_QUALITY: unreliable');
      expect(result.observation).not.toContain('corpus_limited');
    });

    it('does not emit corpus_limited for generic 0-result queries without an explicit wine type', async () => {
      const { InMemoryCorpusCardinalityCache } = await import(
        '../../../../src/domain/retrieval/service/corpus-cardinality-cache.js'
      );
      const mockSearch = vi.fn().mockResolvedValue(makeSearchResponse([]));
      const depsWithCardinality: AgentToolDeps = {
        ...deps,
        searchUseCase: { execute: mockSearch } as unknown as SearchExecutorPort,
        corpusCardinality: InMemoryCorpusCardinalityCache.empty(),
      };
      const result = await executeAgentTool(
        'search_wines',
        { query: '와인 입문자 선물용 달달하면서 도수 낮은 거, 예쁜 라벨' },
        depsWithCardinality,
        'req-123',
      );
      expect(result.observation).toContain('RETRIEVAL_QUALITY: unreliable');
      expect(result.observation).not.toContain('corpus_limited');
    });
  });
});
