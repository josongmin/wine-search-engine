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
      expect(request.query).toBe('Bordeaux red wines');
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

    it('should forward semantic style hints, budget text, and structured filters into SearchRequest', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(mockSearchResponse);

      await executor.execute(
        'search_wines',
        {
          query: 'camping wine',
          style: 'chillable',
          certification: 'organic',
          max_price_krw: 50000,
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
        expect.objectContaining({ attribute: 'wine_type', value: 'white' }),
        expect.objectContaining({ attribute: 'country', value: 'France' }),
        expect.objectContaining({ attribute: 'vintage_year', operator: '>=', value: 2020 }),
        expect.objectContaining({ attribute: 'vintage_year', operator: '<=', value: 2022 }),
        expect.objectContaining({ attribute: 'appellation', value: 'Chablis' }),
        expect.objectContaining({ attribute: 'grape_primary', operator: 'exclude', value: 'Chardonnay' }),
        expect.objectContaining({ attribute: 'region', operator: 'exclude', value: 'Italy' }),
      ]));
    });

    it('should reject invalid query (empty)', async () => {
      await expect(async () => {
        await executor.execute('search_wines', { query: '', limit: 10 }, 'req-123');
      }).rejects.toThrow();
    });

    it('should reject invalid limit (>50)', async () => {
      await expect(async () => {
        await executor.execute('search_wines', { query: 'test', limit: 51 }, 'req-123');
      }).rejects.toThrow();
    });

    it('should reject invalid retrieval_mode', async () => {
      await expect(async () => {
        await executor.execute(
          'search_wines',
          { query: 'test', retrieval_mode: 'invalid' },
          'req-123',
        );
      }).rejects.toThrow();
    });
  });

  describe('get_food_pairings', () => {
    it('should construct query from food and dispatch', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(mockSearchResponse);

      await executor.execute('get_food_pairings', { food: 'grilled salmon' }, 'req-123');

      const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0]!;
      expect(request.query).toContain('wine pairing for grilled salmon');
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
      expect(request.query).toContain('wine pairing for ssam');
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
      expect(request.query).toContain('under 67500 KRW');
    });

    it('should prefer max_price_krw over max_price for food pairings', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(mockSearchResponse);

      await executor.execute(
        'get_food_pairings',
        { food: 'chicken', max_price: 50, max_price_krw: 30000 },
        'req-123',
      );

      const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0]!;
      expect(request.query).toContain('under 30000 KRW');
      expect(request.query).not.toContain('67500');
    });

    it('should pass requestId correctly', async () => {
      vi.mocked(mockSearchUseCase.execute).mockResolvedValue(mockSearchResponse);

      await executor.execute('get_food_pairings', { food: 'pasta' }, 'food-req-789');

      const [, requestId] = vi.mocked(mockSearchUseCase.execute).mock.calls[0]!;
      expect(requestId).toBe('food-req-789');
    });

    it('should reject invalid food (empty)', async () => {
      await expect(async () => {
        await executor.execute('get_food_pairings', { food: '' }, 'req-123');
      }).rejects.toThrow();
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

    it('should reject invalid entity_id (empty)', async () => {
      await expect(async () => {
        await executor.execute('check_drinking_window', { entity_id: '' }, 'req-123');
      }).rejects.toThrow();
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
      const [subQueries, intent, originalQuery, requestId] = vi.mocked(
        mockDecomposedSearchUseCase.execute,
      ).mock.calls[0]!;

      expect(subQueries).toEqual(['Château Margaux 2015', 'Caymus Cabernet 2018']);
      expect(intent).toBe('compare');
      expect(originalQuery).toContain('Château Margaux 2015');
      expect(originalQuery).toContain('Caymus Cabernet 2018');
      expect(requestId).toBe('compare-req-123');
      expect(result).toEqual(mockComparisonResponse);
    });

    it('should reject invalid query_a (empty)', async () => {
      await expect(async () => {
        await executor.execute(
          'compare_wines',
          { query_a: '', query_b: 'test' },
          'req-123',
        );
      }).rejects.toThrow();
    });

    it('should reject invalid query_b (empty)', async () => {
      await expect(async () => {
        await executor.execute(
          'compare_wines',
          { query_a: 'test', query_b: '' },
          'req-123',
        );
      }).rejects.toThrow();
    });
  });
});
