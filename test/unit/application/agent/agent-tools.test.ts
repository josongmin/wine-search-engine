import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeAgentTool, type AgentToolDeps } from '../../../../src/application/agent/agent-tools.js';
import { extractSearchConstraints } from '../../../../src/domain/query/service/search-constraint-extractor.js';
import type { SearchExecutorPort } from '../../../../src/application/search/port/search-executor.port.js';
import type { SearchResponseV1 } from '../../../../src/domain/response/model/search-response.js';
import { SOURCE_SYSTEM_VIVINO_SILVER } from '../../../../src/shared/constants/source-systems.js';

function makeSearchResponse(
  results: SearchResponseV1['results'],
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
    },
    results,
    meta: {
      requestId: 'req-123',
      queryTimeMs: 10,
      route: 'hybrid',
      version: '1.0.0',
      engine_schema_version: 'search_response_v1',
    },
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
    expect(request?.query).not.toContain('결혼기념일');
    expect(request?.query).not.toContain('코스요리');
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
    expect(request?.query).not.toContain('소고기용');
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

  it('preserves the lexical nucleus when structured filters exist but no semantic anchor survives reconstruction', async () => {
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
    expect(request?.query).toContain('red');
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
    expect(call?.[2]).toEqual({ abortSignal: controller.signal });
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
    expect(request?.query).toContain('wines for 쌈싸먹을 때');
    expect(request?.query).not.toContain('both');
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
          entity: { entityId: 'wine-1', canonicalLabel: 'Wine A', type: 'wine', region: 'Bordeaux', grapes: ['Merlot'] },
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
  });

  it('includes source_record_refs in GROUNDING_JSON and lineage in observation when present', async () => {
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
    expect(result.observation).toContain('"source_record_refs"');
    expect(result.observation).toContain(`"source_system":"${SOURCE_SYSTEM_VIVINO_SILVER}"`);
    expect(result.observation).toContain('"source_record_id":"ref-abc"');
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
});
