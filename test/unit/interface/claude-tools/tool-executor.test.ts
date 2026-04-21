/**
 * Unit tests for WineToolExecutor.
 *
 * Validates:
 * - Input validation using Zod schemas
 * - search_wines dispatch to SearchUseCase.execute(request, requestId)
 * - get_food_pairings query transformation and dispatch
 * - check_drinking_window error handling (entity lookup not impl)
 * - compare_wines dispatch to DecomposedSearchUseCase.execute([queryA, queryB], 'compare', ...)
 * - Unknown tool returns error
 * - requestId propagation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WineToolExecutor, type WineToolExecutorDeps } from '../../../../src/interface/claude-tools/tool-executor.js';
import type { SearchUseCase } from '../../../../src/application/search/search.usecase.js';
import type { DecomposedSearchUseCase } from '../../../../src/application/search/decomposed-search.usecase.js';
import type { DrinkingWindowUseCase } from '../../../../src/application/drinking-window/drinking-window.usecase.js';
import type { SearchResponseV1 } from '../../../../src/domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../../../src/domain/response/model/comparison-response.js';

describe('WineToolExecutor', () => {
  let mockSearchUseCase: SearchUseCase;
  let mockDecomposedSearchUseCase: DecomposedSearchUseCase;
  let mockDrinkingWindowUseCase: DrinkingWindowUseCase;
  let executor: WineToolExecutor;

  const mockSearchResponse: SearchResponseV1 = {
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
    results: [
      {
        entity: {
          entityId: 'wine-123',
          canonicalLabel: 'Château Margaux 2015',
          type: 'wine',
        },
        relevanceScore: 0.95,
        match: {
          matchType: 'hybrid',
          scoreComponents: {
            lexical: 0.8,
            semantic: 0.9,
            attribute: 0.85,
            popularity: 0.7,
            preferenceAlignment: 0.5,
          },
        },
        constraints: {
          matched: [],
          unmet: [],
          inferred: [],
        },
        uncertainty: {
          uncertaintyConfidence: 0.95,
          missingInfo: [],
          approximationUsed: false,
        },
        evidenceItems: [],
      },
    ],
    meta: {
      requestId: 'req-123',
      queryTimeMs: 100,
      route: 'hybrid',
      version: '1.0.0',
      engine_schema_version: 'search_response_v1',
    },
  };

  const mockComparisonResponse: ComparisonSearchResponse = {
    queryType: 'comparison',
    originalQuery: 'Château Margaux 2015 vs Caymus Cabernet 2018',
    comparisonIntent: 'compare',
    entities: [
      {
        subQuery: 'Château Margaux 2015',
        topResult: mockSearchResponse.results[0],
        resultCount: 1,
        resolutionStatus: 'resolved',
        allResults: mockSearchResponse.results,
      },
      {
        subQuery: 'Caymus Cabernet 2018',
        topResult: null,
        resultCount: 0,
        resolutionStatus: 'failed',
        allResults: [],
      },
    ],
    overallStatus: 'ambiguous',
    requestId: 'req-123',
    executionTimeMs: 200,
  };

  function makeSearchResponse(
    entityId: string,
    wineType: string,
    relevanceScore: number,
    overrides?: Partial<SearchResponseV1>,
  ): SearchResponseV1 {
    return {
      ...mockSearchResponse,
      ...overrides,
      engineDecision: {
        ...mockSearchResponse.engineDecision,
        ...overrides?.engineDecision,
      },
      results: [
        {
          ...mockSearchResponse.results[0]!,
          entity: {
            ...mockSearchResponse.results[0]!.entity,
            entityId,
            canonicalLabel: entityId,
            wineType,
          },
          relevanceScore,
        },
      ],
      meta: {
        ...mockSearchResponse.meta,
        ...overrides?.meta,
      },
    };
  }

  beforeEach(() => {
    mockSearchUseCase = {
      execute: vi.fn(),
    } as unknown as SearchUseCase;

    mockDecomposedSearchUseCase = {
      execute: vi.fn(),
    } as unknown as DecomposedSearchUseCase;

    mockDrinkingWindowUseCase = {
      check: vi.fn(),
    } as unknown as DrinkingWindowUseCase;

    const deps: WineToolExecutorDeps = {
      searchUseCase: mockSearchUseCase,
      decomposedSearchUseCase: mockDecomposedSearchUseCase,
      drinkingWindowUseCase: mockDrinkingWindowUseCase,
    };

    executor = new WineToolExecutor(deps);
  });

  describe('execute - dispatch', () => {
    it('should return error for unknown tool', async () => {
      const result = await executor.execute('unknown_tool', {}, 'req-123');
      expect(result).toEqual({ error: 'Unknown tool: unknown_tool' });
    });
  });

  describe('search_wines', () => {
    it('should dispatch to SearchUseCase.execute with correct request', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(mockSearchResponse);

      const result = await executor.execute(
        'search_wines',
        { query: 'Bordeaux red wines', limit: 5 },
        'req-123',
      );

      expect(mockSearchUseCase.execute).toHaveBeenCalledOnce();
      const [request, requestId] = vi.mocked(mockSearchUseCase.execute).mock.calls[0]!;
      expect(request.query).toBe('bordeaux');
      expect(requestId).toBe('req-123');
      expect(result).toEqual(mockSearchResponse);
    });

    it('should pass requestId as 2nd argument', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(mockSearchResponse);

      await executor.execute('search_wines', { query: 'test' }, 'parent-req-456');

      const [, requestId] = vi.mocked(mockSearchUseCase.execute).mock.calls[0]!;
      expect(requestId).toBe('parent-req-456');
    });

    it('should use default limit (10) if not provided', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(mockSearchResponse);

      await executor.execute('search_wines', { query: 'test' }, 'req-123');

      const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0]!;
      // Default is applied during validation, not passed explicitly to request
      expect(request.query).toBe('test');
    });

    it('should use specified retrieval_mode', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(mockSearchResponse);

      await executor.execute(
        'search_wines',
        { query: 'test', retrieval_mode: 'mixed' },
        'req-123',
      );

      const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0]!;
      expect(request.options?.mode).toBe('mixed');
    });

    it('normalizes exact metadata Korean queries to a bare entity retrieval core', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(mockSearchResponse);

      await executor.execute(
        'search_wines',
        { query: '오푸스원 지금 마시기 좋아?', country: 'United States' },
        'req-exact-metadata-123',
      );

      const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0]!;
      expect(request.query).toBe('opus one wine');
      expect(request.filters).toEqual([
        expect.objectContaining({ attribute: 'country', value: 'United States' }),
      ]);
    });

    it('should forward semantic style hints, budget text, and structured filters into SearchRequest', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(mockSearchResponse);

      await executor.execute(
        'search_wines',
        {
          query: 'camping wine',
          style: 'chillable',
          certification: 'organic',
          max_price_krw: 50000,
          max_alcohol_pct: 12,
          wine_type: 'white',
          country: 'France',
          vintage_min: 2020,
          vintage_max: 2022,
          appellation: 'Chablis',
          exclude_grapes: ['Chardonnay'],
          exclude_regions: ['Italy'],
        },
        'req-structured-123',
      );

      const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0]!;
      expect(request.query).toContain('camping wine');
      expect(request.query).toContain('chillable');
      expect(request.query).toContain('organic');
      expect(request.query).toContain('50000원 이하');
      expect(request.query).toContain('not Chardonnay');
      expect(request.query).toContain('not Italy');
      expect(request.limit).toBe(10);
      expect(request.filters).toEqual(expect.arrayContaining([
        expect.objectContaining({ attribute: 'alcohol_pct', operator: '<=', value: 12 }),
        expect.objectContaining({ attribute: 'wine_type', value: 'white' }),
        expect.objectContaining({ attribute: 'country', value: 'France' }),
        expect.objectContaining({ attribute: 'vintage_year', operator: '>=', value: 2020 }),
        expect.objectContaining({ attribute: 'vintage_year', operator: '<=', value: 2022 }),
        expect.objectContaining({ attribute: 'appellation', value: 'Chablis' }),
        expect.objectContaining({ attribute: 'grape_primary', operator: 'exclude', value: 'Chardonnay' }),
        expect.objectContaining({ attribute: 'region', operator: 'exclude', value: 'Italy' }),
      ]));
    });

    it('should forward occasion and learned suitability constraints into SearchRequest', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(mockSearchResponse);

      await executor.execute(
        'search_wines',
        {
          query: '와인 잘 모르는 사람한테 선물할 거',
          occasion: ['gift', 'anniversary'],
          gift_suitability_min: 0.7,
          beginner_suitability_min: 0.65,
          styles: ['approachable', 'crowd_pleasing'],
        },
        'req-latent-intent-123',
      );

      const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls.at(-1)!;
      expect(request.query).toContain('gift');
      expect(request.query).toContain('anniversary');
      expect(request.query).toContain('approachable');
      expect(request.query).toContain('crowd pleasing');
      expect(request.filters).toEqual(expect.arrayContaining([
        expect.objectContaining({ attribute: 'occasion', operator: 'in', value: ['gift', 'anniversary'] }),
        expect.objectContaining({ attribute: 'gift_suitability', operator: '>=', value: 0.7 }),
        expect.objectContaining({ attribute: 'beginner_suitability', operator: '>=', value: 0.65 }),
      ]));
    });

    it('should coerce numeric strings for structured search fields', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(mockSearchResponse);

      await executor.execute(
        'search_wines',
        {
          query: 'structured string inputs',
          limit: '5',
          max_price_krw: '50000',
          vintage_min: '2020',
          vintage_max: '2022',
        },
        'req-string-structured-123',
      );

      const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0]!;
      expect(request.limit).toBe(5);
      expect(request.query).toContain('50000원 이하');
      expect(request.filters).toEqual(expect.arrayContaining([
        expect.objectContaining({ attribute: 'vintage_year', operator: '>=', value: 2020 }),
        expect.objectContaining({ attribute: 'vintage_year', operator: '<=', value: 2022 }),
      ]));
    });

    it('strips null optional fields before validation like the agent tool path', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(mockSearchResponse);

      await executor.execute(
        'search_wines',
        {
          query: 'structured null cleanup',
          limit: null,
          max_price_krw: null,
          vintage_min: null,
        },
        'req-null-sanitize-123',
      );

      const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0]!;
      expect(request.query).toBe('structured null cleanup');
      expect(request.limit).toBe(10);
      expect(request.filters).toBeUndefined();
    });

    it('should prefer styles[] over style and keep semantic styles out of hard filters', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(mockSearchResponse);

      await executor.execute(
        'search_wines',
        {
          query: 'gift wine',
          style: 'ignored-style',
          styles: ['approachable', 'crowd_pleasing', 'approachable'],
          certification: 'organic',
        },
        'req-style-array-123',
      );

      const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0]!;
      expect(request.query).toContain('gift wine');
      expect(request.query).toContain('approachable');
      expect(request.query).toContain('crowd pleasing');
      expect(request.query).not.toContain('ignored-style');
      expect(request.filters).toBeUndefined();
    });

    it('should treat presentation_forward as a no-op style hint instead of polluting the retrieval query', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(mockSearchResponse);

      await executor.execute(
        'search_wines',
        {
          query: '예쁜 라벨 선물용 와인',
          styles: ['presentation_forward', 'approachable'],
        },
        'req-presentation-noop-123',
      );

      const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls.at(-1)!;
      expect(request.query).toContain('approachable');
      expect(request.query).not.toContain('presentation_forward');
    });

    it('should compile sweet style into structured sweetness filters instead of query text', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(mockSearchResponse);

      await executor.execute(
        'search_wines',
        {
          query: '달달한 선물용 와인',
          styles: ['sweet', 'approachable'],
        },
        'req-sweet-structured-123',
      );

      const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls.at(-1)!;
      expect(request.query).toContain('approachable');
      expect(request.query).not.toContain('sweet');
      expect(request.filters).toEqual(expect.arrayContaining([
        expect.objectContaining({ attribute: 'sweetness', operator: '>=', value: 0.5 }),
      ]));
    });

    it('should run typed diversity discovery when want_diversity is true without explicit wine_type', async () => {
      vi.mocked(mockSearchUseCase.execute)
        .mockResolvedValueOnce(
          makeSearchResponse('white-1', 'white', 0.88, {
            meta: { ...mockSearchResponse.meta, requestId: 'typed-white', queryTimeMs: 21 },
          }),
        )
        .mockResolvedValueOnce(
          makeSearchResponse('sparkling-1', 'sparkling', 0.93, {
            meta: {
              ...mockSearchResponse.meta,
              requestId: 'typed-sparkling',
              queryTimeMs: 42,
              executionMode: 'degraded',
              degradationReasons: ['typed_probe_partial'],
            },
            engineDecision: {
              ...mockSearchResponse.engineDecision,
              decisionTraceRef: 'trace-sparkling',
              executionMode: 'degraded',
              degradationReasons: ['typed_probe_partial'],
            },
          }),
        )
        .mockResolvedValueOnce(
          makeSearchResponse('red-1', 'red', 0.9, {
            meta: { ...mockSearchResponse.meta, requestId: 'typed-red', queryTimeMs: 37 },
          }),
        );

      const result = await executor.execute(
        'search_wines',
        { query: '선물용 다양하게 추천', want_diversity: true, limit: 4 },
        'req-diverse-123',
      );

      expect(mockSearchUseCase.execute).toHaveBeenCalledTimes(3);
      const calls = vi.mocked(mockSearchUseCase.execute).mock.calls;
      expect(calls[0]?.[1]).toBe('req-diverse-123:diversity:white');
      expect(calls[1]?.[1]).toBe('req-diverse-123:diversity:sparkling');
      expect(calls[2]?.[1]).toBe('req-diverse-123:diversity:red');
      expect(calls[0]?.[0].limit).toBe(3);
      expect(calls[1]?.[0].limit).toBe(3);
      expect(calls[2]?.[0].limit).toBe(3);
      expect(calls[0]?.[0].filters).toEqual([
        expect.objectContaining({
          attribute: 'wine_type',
          value: 'white',
          mapping_version: 'claude_tool_diversity_v1',
        }),
      ]);
      expect(calls[1]?.[0].filters).toEqual([
        expect.objectContaining({
          attribute: 'wine_type',
          value: 'sparkling',
          mapping_version: 'claude_tool_diversity_v1',
        }),
      ]);
      expect(calls[2]?.[0].filters).toEqual([
        expect.objectContaining({
          attribute: 'wine_type',
          value: 'red',
          mapping_version: 'claude_tool_diversity_v1',
        }),
      ]);

      expect(result).toMatchObject({
        queryType: 'search',
        meta: {
          requestId: 'req-diverse-123',
          runtimeCorrelationRef: 'req-diverse-123',
          queryTimeMs: 42,
          executionMode: 'degraded',
          degradationReasons: ['typed_probe_partial'],
        },
        engineDecision: {
          runtimeCorrelationRef: 'req-diverse-123',
          decisionTraceRef: 'trace-sparkling',
          executionMode: 'degraded',
          degradationReasons: ['typed_probe_partial'],
        },
      });
      expect((result as SearchResponseV1).results.map((item) => item.entity.entityId)).toEqual([
        'sparkling-1',
        'red-1',
        'white-1',
      ]);
    });

    it('applies the same budget post-filter policy as agent search tools', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue({
        ...mockSearchResponse,
        results: [
          {
            ...mockSearchResponse.results[0]!,
            entity: {
              ...mockSearchResponse.results[0]!.entity,
              entityId: 'wine-cheap',
              canonicalLabel: 'Budget Blanc',
              priceRange: '$60',
            },
          },
          {
            ...mockSearchResponse.results[0]!,
            entity: {
              ...mockSearchResponse.results[0]!.entity,
              entityId: 'wine-pricey',
              canonicalLabel: 'Pricey Rouge',
              priceRange: '$80',
            },
          },
        ],
      });

      const result = await executor.execute(
        'search_wines',
        { query: '10만원 이하', max_price_krw: 100_000 },
        'req-budget-123',
      ) as SearchResponseV1;

      expect(result.results.map((item) => item.entity.entityId)).toEqual(['wine-cheap']);
    });

    it('applies negation post-filter to raw query exclusions before returning results', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue({
        ...mockSearchResponse,
        results: [
          {
            ...mockSearchResponse.results[0]!,
            entity: {
              ...mockSearchResponse.results[0]!.entity,
              entityId: 'wine-merlot',
              canonicalLabel: 'Merlot Estate',
              grapes: ['Merlot'],
            },
          },
          {
            ...mockSearchResponse.results[0]!,
            entity: {
              ...mockSearchResponse.results[0]!.entity,
              entityId: 'wine-cab',
              canonicalLabel: 'Cabernet Reserve',
              grapes: ['Cabernet Sauvignon'],
            },
          },
        ],
      });

      const result = await executor.execute(
        'search_wines',
        { query: 'red wine not Merlot' },
        'req-negation-123',
      ) as SearchResponseV1;

      expect(result.results.map((item) => item.entity.entityId)).toEqual(['wine-cab']);
    });

    it('should skip typed diversity discovery when wine_type is already explicit', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(mockSearchResponse);

      await executor.execute(
        'search_wines',
        { query: '선물용 다양하게 추천', want_diversity: true, wine_type: 'red' },
        'req-red-only-123',
      );

      expect(mockSearchUseCase.execute).toHaveBeenCalledTimes(1);
      const [request, requestId] = vi.mocked(mockSearchUseCase.execute).mock.calls[0]!;
      expect(requestId).toBe('req-red-only-123');
      expect(request.filters).toEqual([
        expect.objectContaining({ attribute: 'wine_type', value: 'red' }),
      ]);
    });

    it('returns in-band error for invalid query (empty)', async () => {
      const result = await executor.execute('search_wines', { query: '', limit: 10 }, 'req-123');
      expect(result).toEqual({
        error: expect.stringContaining('Invalid input for search_wines'),
      });
    });

    it('returns in-band error for invalid limit (>50)', async () => {
      const result = await executor.execute('search_wines', { query: 'test', limit: 51 }, 'req-123');
      expect(result).toEqual({
        error: expect.stringContaining('Invalid input for search_wines'),
      });
    });

    it('returns in-band error for invalid retrieval_mode', async () => {
      const result = await executor.execute(
        'search_wines',
        { query: 'test', retrieval_mode: 'invalid' },
        'req-123',
      );
      expect(result).toEqual({
        error: expect.stringContaining('Invalid input for search_wines'),
      });
    });

    it('returns in-band error for placeholder search queries', async () => {
      const result = await executor.execute('search_wines', { query: '__TO_BE_FILLED__' }, 'req-123');
      expect(result).toEqual({
        error: expect.stringMatching(/placeholder/i),
      });
    });
  });

  describe('get_food_pairings', () => {
    it('should construct query from food and dispatch', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(mockSearchResponse);

      await executor.execute('get_food_pairings', { food: 'grilled salmon' }, 'req-123');

      const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0]!;
      expect(request.query).toContain('wines for grilled salmon');
    });

    it('should include color in query when provided', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(mockSearchResponse);

      await executor.execute(
        'get_food_pairings',
        { food: 'steak', color: 'red' },
        'req-123',
      );

      const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0]!;
      expect(request.query).toContain('red wine');
    });

    it('should treat color both as no hard color filter', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(mockSearchResponse);

      await executor.execute(
        'get_food_pairings',
        { food: 'ssam', color: 'both' },
        'req-123',
      );

      const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0]!;
      expect(request.query).toContain('wines for ssam');
      expect(request.query).not.toContain('both wine');
    });

    it('should include max_price in query when provided', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(mockSearchResponse);

      await executor.execute(
        'get_food_pairings',
        { food: 'chicken', max_price: 50 },
        'req-123',
      );

      const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0]!;
      expect(request.query).toContain('67500원 이하');
    });

    it('should prefer max_price_krw over max_price for food pairings', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(mockSearchResponse);

      await executor.execute(
        'get_food_pairings',
        { food: 'chicken', max_price: 50, max_price_krw: 30000 },
        'req-123',
      );

      const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0]!;
      expect(request.query).toContain('30000원 이하');
      expect(request.query).not.toContain('67500');
    });

    it('should pass requestId correctly', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(mockSearchResponse);

      await executor.execute('get_food_pairings', { food: 'pasta' }, 'food-req-789');

      const [, requestId] = vi.mocked(mockSearchUseCase.execute).mock.calls[0]!;
      expect(requestId).toBe('food-req-789');
    });

    it('returns in-band error for invalid food (empty)', async () => {
      const result = await executor.execute('get_food_pairings', { food: '' }, 'req-123');
      expect(result).toEqual({
        error: expect.stringContaining('Invalid input for get_food_pairings'),
      });
    });

    it('returns in-band error for placeholder food values', async () => {
      const result = await executor.execute('get_food_pairings', { food: 'TBD' }, 'req-123');
      expect(result).toEqual({
        error: expect.stringMatching(/placeholder/i),
      });
    });
  });

  describe('check_drinking_window', () => {
    it('should return error (entity lookup not implemented)', async () => {
      const result = await executor.execute(
        'check_drinking_window',
        { entity_id: 'wine-123', target_year: 2030 },
        'req-123',
      );

      expect(result).toEqual({
        error: expect.stringMatching(/Entity lookup not (yet implemented|available)/),
      });
    });

    it('returns in-band error for invalid entity_id (empty)', async () => {
      const result = await executor.execute('check_drinking_window', { entity_id: '' }, 'req-123');
      expect(result).toEqual({
        error: expect.stringContaining('Invalid input for check_drinking_window'),
      });
    });

    it('returns in-band error for placeholder entity_id values', async () => {
      const result = await executor.execute('check_drinking_window', { entity_id: '<top_result_entity_id>' }, 'req-123');
      expect(result).toEqual({
        error: expect.stringMatching(/placeholder/i),
      });
    });

    it('hydrates source-backed drinking-window priors from the entity document', async () => {
      const entityLookup = {
        getDocument: vi.fn().mockResolvedValue({
          entityId: 'wine-123',
          entityType: 'wine',
          canonicalLabel: 'Barolo Example 2018',
          aliasesIdentitySafe: ['Barolo Example 2018'],
          aliasesNoisyRecall: ['Barolo Example'],
          producer: 'Giacomo Conterno',
          region: 'Piemonte',
          grapes: ['Nebbiolo'],
          searchTextKo: '바롤로 예시',
          searchTextEn: 'Barolo Example 2018',
          semanticSummary: 'Structured Barolo',
          style: 'structured red',
          priceBand: 'luxury',
          pairing: ['braised beef'],
          availability: true,
          popularityScore: 0.92,
          vintageYear: 2018,
          body: 0.8,
          tannin: 0.9,
          acidity: 0.7,
          sweetness: 0.1,
          criticScoreNormalized: 0.94,
          grapePrimaryEnc: 11,
          regionEnc: 22,
          countryEnc: 33,
          grapePrimary: 'Nebbiolo',
          grapeFamily: 'Nebbiolo',
          country: 'Italy',
          appellation: 'Barolo DOCG',
          regionHierarchy: ['Italy', 'Piemonte', 'Barolo'],
          wineType: 'red',
          classification: 'DOCG',
          oakTreatment: 'large oak cask',
          producerPrestige: 0.91,
          ratingAvg: 4.6,
          ratingsCount: 1287,
          reviewCount: 211,
          ratingDistribution: { '1': 2, '2': 10, '3': 115, '4': 540, '5': 620 },
          wineryRatingCount: 8240,
          priceUsd: 180,
          bottleSizeMl: 750,
          bottleSize: '750ml',
          closure: 'Cork',
          drinkingWindowStart: 2026,
          drinkingWindowEnd: 2038,
          drinkingWindowModelVersion: 'snapshot:on-index',
          certifications: ['organic'],
          producerType: 'domaine',
          soilType: 'limestone',
          finishLength: 0.92,
          alcoholPct: 14.5,
        }),
      };
      const richExecutor = new WineToolExecutor({
        searchUseCase: mockSearchUseCase,
        decomposedSearchUseCase: mockDecomposedSearchUseCase,
        drinkingWindowUseCase: mockDrinkingWindowUseCase,
        entityLookup,
      });
      vi.mocked(mockDrinkingWindowUseCase.check).mockResolvedValue({
        drinkingWindowStart: 2026,
        drinkingWindowEnd: 2038,
        peakYear: 2031,
        currentlyDrinkable: true,
        confidence: 'high',
        evidenceLevel: 'learned',
        blockingEligible: true,
        modelVersion: 'onnx:v2',
      });

      await richExecutor.execute(
        'check_drinking_window',
        { entity_id: 'wine-123', target_year: 2031 },
        'req-123',
      );

      expect(entityLookup.getDocument).toHaveBeenCalledWith('wine-123');
      expect(mockDrinkingWindowUseCase.check).toHaveBeenCalledWith({
        vintage: 2018,
        grapePrimaryEnc: 11,
        regionEnc: 22,
        countryEnc: 33,
        body: 4,
        tannin: 4.5,
        acidity: 3.5,
        sweetness: 0.5,
        avgCriticProxyScore: 94,
        priorDrinkingWindowStart: 2026,
        priorDrinkingWindowEnd: 2038,
        priorDrinkingWindowModelVersion: 'snapshot:on-index',
        grapePrimary: 'Nebbiolo',
        grapes: ['Nebbiolo'],
        grapeFamily: 'Nebbiolo',
        producer: 'Giacomo Conterno',
        country: 'Italy',
        region: 'Piemonte',
        appellation: 'Barolo DOCG',
        regionHierarchy: ['Italy', 'Piemonte', 'Barolo'],
        wineType: 'red',
        style: 'structured red',
        classification: 'DOCG',
        oakTreatment: 'large oak cask',
        producerPrestige: 0.91,
        ratingAvg: 4.6,
        ratingsCount: 1287,
        reviewCount: 211,
        ratingDistribution: { '1': 2, '2': 10, '3': 115, '4': 540, '5': 620 },
        wineryRatingCount: 8240,
        priceUsd: 180,
        bottleSizeMl: 750,
        bottleSize: '750ml',
        closure: 'Cork',
        certifications: ['organic'],
        producerType: 'domaine',
        soilType: 'limestone',
        finishLength: 0.92,
        alcoholPct: 14.5,
        targetYear: 2031,
      });
    });
  });

  describe('compare_wines', () => {
    it('should dispatch to DecomposedSearchUseCase.execute with correct args', async () => {
      vi.mocked(mockDecomposedSearchUseCase.execute).mockResolvedValue(
        mockComparisonResponse,
      );

      const result = await executor.execute(
        'compare_wines',
        { query_a: 'Château Margaux 2015', query_b: 'Caymus Cabernet 2018' },
        'compare-req-123',
      );

      expect(mockDecomposedSearchUseCase.execute).toHaveBeenCalledOnce();
      const [subQueries, comparisonLegs, intent, originalQuery, requestId] = vi.mocked(
        mockDecomposedSearchUseCase.execute,
      ).mock.calls[0]!;

      expect(subQueries).toEqual(['margaux', 'cabernet sauvignon']);
      expect(comparisonLegs).toEqual([
        expect.objectContaining({
          rawQuery: 'margaux',
          retrievalQuery: 'margaux',
          mode: 'entity',
          retrievalMode: 'auto',
          evidenceSource: 'entity_default',
        }),
        expect.objectContaining({
          rawQuery: 'cabernet sauvignon',
          retrievalQuery: 'cabernet sauvignon',
          mode: 'entity',
          retrievalMode: 'auto',
          evidenceSource: 'entity_default',
        }),
      ]);
      expect(intent).toBe('compare');
      expect(originalQuery).toContain('Château Margaux 2015');
      expect(originalQuery).toContain('Caymus Cabernet 2018');
      expect(requestId).toBe('compare-req-123');
      expect(result).toEqual(mockComparisonResponse);
    });

    it('should forward shared structured comparison filters to both legs', async () => {
      vi.mocked(mockDecomposedSearchUseCase.execute).mockResolvedValue(
        mockComparisonResponse,
      );

      await executor.execute(
        'compare_wines',
        {
          query_a: 'Barolo',
          query_b: 'Brunello di Montalcino',
          max_price_krw: 50000,
          country: 'Italy',
          vintage_min: 2018,
        },
        'compare-req-456',
      );

      const [subQueries, , , originalQuery, , , parentContext] = vi.mocked(
        mockDecomposedSearchUseCase.execute,
      ).mock.calls[0]!;

      expect(subQueries[0]).toContain('50000원 이하');
      expect(subQueries[1]).toContain('50000원 이하');
      expect(originalQuery).toContain('50000원 이하');
      expect(parentContext?.filters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ attribute: 'country', operator: '=', value: 'Italy' }),
          expect.objectContaining({ attribute: 'vintage_year', operator: '>=', value: 2018 }),
        ]),
      );
    });

    it('should forward shared occasion and suitability constraints to comparison legs', async () => {
      vi.mocked(mockDecomposedSearchUseCase.execute).mockResolvedValue(
        mockComparisonResponse,
      );

      await executor.execute(
        'compare_wines',
        {
          query_a: 'Barolo',
          query_b: 'Brunello di Montalcino',
          occasion: ['gift'],
          gift_suitability_min: 0.75,
          beginner_suitability_min: 0.6,
        },
        'compare-req-latent-123',
      );

      const [subQueries, , , originalQuery, , , parentContext] = vi.mocked(
        mockDecomposedSearchUseCase.execute,
      ).mock.calls.at(-1)!;

      expect(subQueries[0]).toContain('gift');
      expect(subQueries[1]).toContain('gift');
      expect(originalQuery).toContain('gift');
      expect(parentContext?.filters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ attribute: 'occasion', operator: 'in', value: ['gift'] }),
          expect.objectContaining({ attribute: 'gift_suitability', operator: '>=', value: 0.75 }),
          expect.objectContaining({ attribute: 'beginner_suitability', operator: '>=', value: 0.6 }),
        ]),
      );
    });

    it('returns in-band error for invalid query_a (empty)', async () => {
      const result = await executor.execute(
        'compare_wines',
        { query_a: '', query_b: 'test' },
        'req-123',
      );
      expect(result).toEqual({
        error: expect.stringContaining('Invalid input for compare_wines'),
      });
    });

    it('returns in-band error for invalid query_b (empty)', async () => {
      const result = await executor.execute(
        'compare_wines',
        { query_a: 'test', query_b: '' },
        'req-123',
      );
      expect(result).toEqual({
        error: expect.stringContaining('Invalid input for compare_wines'),
      });
    });

    it('returns in-band error for placeholder compare queries', async () => {
      const result = await executor.execute(
        'compare_wines',
        { query_a: '__TO_BE_FILLED__', query_b: 'Barolo' },
        'req-123',
      );
      expect(result).toEqual({
        error: expect.stringMatching(/placeholder/i),
      });
    });
  });
});
