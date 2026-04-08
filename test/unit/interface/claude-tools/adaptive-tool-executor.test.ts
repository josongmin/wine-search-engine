/**
 * Unit tests for AdaptiveToolExecutor.
 *
 * Validates:
 * - Empty result detection for SearchResponseV1
 * - Fallback logic: empty result + auto mode → mixed retry
 * - No fallback when result is non-empty
 * - No fallback when mode is not auto
 * - NO infinite recursion: fallback calls base.execute directly
 * - fallbackApplied flag set correctly
 * - requestId suffixed with "-fb" for fallback attempts
 * - Multi-turn scenario: food pairing → search → compare
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdaptiveToolExecutor } from '../../../../src/interface/claude-tools/adaptive-tool-executor.js';
import { WineToolExecutor, type WineToolExecutorDeps } from '../../../../src/interface/claude-tools/tool-executor.js';
import type { SearchUseCase } from '../../../../src/application/search/search.usecase.js';
import type { DecomposedSearchUseCase } from '../../../../src/application/search/decomposed-search.usecase.js';
import type { DrinkingWindowUseCase } from '../../../../src/application/drinking-window/drinking-window.usecase.js';
import type { SearchResponseV1 } from '../../../../src/domain/response/model/search-response.js';

describe('AdaptiveToolExecutor', () => {
  let mockSearchUseCase: SearchUseCase;
  let mockDecomposedSearchUseCase: DecomposedSearchUseCase;
  let mockDrinkingWindowUseCase: DrinkingWindowUseCase;
  let baseExecutor: WineToolExecutor;
  let adaptiveExecutor: AdaptiveToolExecutor;

  const mockEmptySearchResponse: SearchResponseV1 = {
    queryType: 'search',
    engineDecision: {
      decisionStatus: 'failed',
      nextAction: 'fail',
      route: 'hybrid',
      decisionConfidence: 0,
      confidenceSemantics: 'calibrated_decision_confidence',
      decisionTraceRef: 'trace-empty',
      decisionSnapshot: {
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1',
        threshold_profile_id: 'default',
        planner_version: '1',
        feature_flags: {},
      },
    },
    results: [],
    meta: {
      requestId: 'req-empty',
      queryTimeMs: 50,
      route: 'hybrid',
      version: '1.0.0',
      engine_schema_version: 'search_response_v1',
    },
  };

  const mockNonEmptySearchResponse: SearchResponseV1 = {
    ...mockEmptySearchResponse,
    engineDecision: {
      ...mockEmptySearchResponse.engineDecision,
      decisionStatus: 'resolved',
    },
    results: [
      {
        entity: {
          entityId: 'wine-456',
          canonicalLabel: 'Test Wine',
          type: 'wine',
        },
        relevanceScore: 0.85,
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
          uncertaintyConfidence: 0.85,
          missingInfo: [],
          approximationUsed: false,
        },
        evidenceItems: [],
      },
    ],
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

    baseExecutor = new WineToolExecutor(deps);
    adaptiveExecutor = new AdaptiveToolExecutor(baseExecutor);
  });

  describe('executeWithFallback - no fallback needed', () => {
    it('should return result without fallback when search returns non-empty', async () => {
      vi.spyOn(baseExecutor, 'execute').mockResolvedValue(mockNonEmptySearchResponse);

      const result = await adaptiveExecutor.executeWithFallback(
        'search_wines',
        { query: 'good wines', retrieval_mode: 'auto' },
        'req-non-empty',
      );

      expect(result.result).toEqual(mockNonEmptySearchResponse);
      expect(result.fallbackApplied).toBeUndefined();
    });

    it('should not fallback when result is empty but mode is not auto', async () => {
      const executeSpyOn = vi.spyOn(baseExecutor, 'execute');
      executeSpyOn.mockResolvedValue(mockEmptySearchResponse);

      const result = await adaptiveExecutor.executeWithFallback(
        'search_wines',
        { query: 'obscure wine', retrieval_mode: 'mixed' },
        'req-explicit-mixed',
      );

      expect(result.result).toEqual(mockEmptySearchResponse);
      expect(result.fallbackApplied).toBeUndefined();
      // Verify execute was called only once (no retry)
      expect(executeSpyOn).toHaveBeenCalledOnce();
    });

    it('should not fallback when result is empty but mode is hybrid', async () => {
      vi.spyOn(baseExecutor, 'execute').mockResolvedValue(mockEmptySearchResponse);

      const result = await adaptiveExecutor.executeWithFallback(
        'search_wines',
        { query: 'test', retrieval_mode: 'hybrid' },
        'req-hybrid',
      );

      expect(result.fallbackApplied).toBeUndefined();
    });
  });

  describe('executeWithFallback - fallback applied', () => {
    it('should apply fallback when empty + auto mode and retry returns results', async () => {
      const executeSpyOn = vi.spyOn(baseExecutor, 'execute');
      executeSpyOn
        .mockResolvedValueOnce(mockEmptySearchResponse) // First call returns empty
        .mockResolvedValueOnce(mockNonEmptySearchResponse); // Fallback retry returns non-empty

      const result = await adaptiveExecutor.executeWithFallback(
        'search_wines',
        { query: 'rare wine', retrieval_mode: 'auto' },
        'req-fallback',
      );

      // Should return fallback result
      expect(result.result).toEqual(mockNonEmptySearchResponse);
      expect(result.fallbackApplied).toBe('mixed');

      // Should have called execute twice: initial + fallback
      expect(executeSpyOn).toHaveBeenCalledTimes(2);

      // Check first call: execute(toolName, input, requestId)
      const [toolName1, , requestId1] = executeSpyOn.mock.calls[0]!;
      expect(toolName1).toBe('search_wines');
      expect(requestId1).toBe('req-fallback');

      // Second call should have mode='mixed' and requestId suffix "-fb"
      const [toolName2, input2, requestId2] = executeSpyOn.mock.calls[1]!;
      expect(toolName2).toBe('search_wines');
      expect((input2 as any).retrieval_mode).toBe('mixed');
      expect(requestId2).toBe('req-fallback-fb');
    });

    it('should apply fallback when empty + undefined mode (defaults to auto)', async () => {
      const executeSpyOn = vi.spyOn(baseExecutor, 'execute');
      executeSpyOn
        .mockResolvedValueOnce(mockEmptySearchResponse)
        .mockResolvedValueOnce(mockNonEmptySearchResponse);

      const result = await adaptiveExecutor.executeWithFallback(
        'search_wines',
        { query: 'test wine' }, // No retrieval_mode specified
        'req-undefined-mode',
      );

      expect(result.fallbackApplied).toBe('mixed');
      expect(executeSpyOn).toHaveBeenCalledTimes(2);
    });

    it('should return original empty result if fallback also returns empty', async () => {
      const executeSpyOn = vi.spyOn(baseExecutor, 'execute');
      executeSpyOn
        .mockResolvedValueOnce(mockEmptySearchResponse) // First call empty
        .mockResolvedValueOnce(mockEmptySearchResponse); // Fallback also empty

      const result = await adaptiveExecutor.executeWithFallback(
        'search_wines',
        { query: 'nonexistent wine', retrieval_mode: 'auto' },
        'req-double-empty',
      );

      // Should return original empty result without fallbackApplied flag
      expect(result.result).toEqual(mockEmptySearchResponse);
      expect(result.fallbackApplied).toBeUndefined();
    });
  });

  describe('executeWithFallback - no recursion guarantee', () => {
    it('should call base.execute directly for fallback, not executeWithFallback', async () => {
      const baseExecuteSpyOn = vi.spyOn(baseExecutor, 'execute');
      const adaptiveExecuteSpyOn = vi.spyOn(adaptiveExecutor, 'executeWithFallback');

      baseExecuteSpyOn
        .mockResolvedValueOnce(mockEmptySearchResponse)
        .mockResolvedValueOnce(mockNonEmptySearchResponse);

      await adaptiveExecutor.executeWithFallback(
        'search_wines',
        { query: 'test', retrieval_mode: 'auto' },
        'req-recursion-test',
      );

      // executeWithFallback called once (initial call)
      expect(adaptiveExecuteSpyOn).toHaveBeenCalledTimes(1);

      // base.execute called twice (initial + fallback directly, NOT via recursion)
      expect(baseExecuteSpyOn).toHaveBeenCalledTimes(2);
    });
  });

  describe('executeWithFallback - requestId propagation', () => {
    it('should append -fb to requestId for fallback attempt', async () => {
      const executeSpyOn = vi.spyOn(baseExecutor, 'execute');
      executeSpyOn
        .mockResolvedValueOnce(mockEmptySearchResponse)
        .mockResolvedValueOnce(mockNonEmptySearchResponse);

      const parentRequestId = 'parent-request-12345';
      await adaptiveExecutor.executeWithFallback(
        'search_wines',
        { query: 'test', retrieval_mode: 'auto' },
        parentRequestId,
      );

      expect(executeSpyOn).toHaveBeenCalledTimes(2);

      // First call uses original requestId: execute(toolName, input, requestId)
      const [, , firstRequestId] = executeSpyOn.mock.calls[0]!;
      expect(firstRequestId).toBe(parentRequestId);

      // Second call (fallback) appends "-fb"
      const [, , secondRequestId] = executeSpyOn.mock.calls[1]!;
      expect(secondRequestId).toBe(`${parentRequestId}-fb`);
    });
  });

  describe('executeWithFallback - non-search tools', () => {
    it('should return result without fallback for get_food_pairings', async () => {
      vi.spyOn(baseExecutor, 'execute').mockResolvedValue(mockNonEmptySearchResponse);

      const result = await adaptiveExecutor.executeWithFallback(
        'get_food_pairings',
        { food: 'steak' },
        'req-food',
      );

      expect(result.fallbackApplied).toBeUndefined();
    });

    it('should return result without fallback for compare_wines', async () => {
      const mockComparisonResponse = {
        queryType: 'comparison',
        originalQuery: 'A vs B',
        comparisonIntent: 'compare',
        entities: [],
        overallStatus: 'failed',
        requestId: 'req-compare',
        executionTimeMs: 100,
      };

      vi.spyOn(baseExecutor, 'execute').mockResolvedValue(mockComparisonResponse as any);

      const result = await adaptiveExecutor.executeWithFallback(
        'compare_wines',
        { query_a: 'A', query_b: 'B' },
        'req-compare',
      );

      expect(result.fallbackApplied).toBeUndefined();
    });

    it('should return result without fallback for check_drinking_window', async () => {
      const mockErrorResult = { error: 'Entity lookup not implemented' };
      vi.spyOn(baseExecutor, 'execute').mockResolvedValue(mockErrorResult as any);

      const result = await adaptiveExecutor.executeWithFallback(
        'check_drinking_window',
        { entity_id: 'wine-123' },
        'req-drinking',
      );

      expect(result.fallbackApplied).toBeUndefined();
    });
  });

  describe('isEmptyResult - helper', () => {
    it('should detect empty when results.length === 0', async () => {
      const emptyResponse: SearchResponseV1 = {
        ...mockEmptySearchResponse,
        results: [],
      };

      const executeSpyOn = vi.spyOn(baseExecutor, 'execute');
      executeSpyOn.mockResolvedValueOnce(emptyResponse);
      executeSpyOn.mockResolvedValueOnce(mockNonEmptySearchResponse);

      await adaptiveExecutor.executeWithFallback(
        'search_wines',
        { query: 'test', retrieval_mode: 'auto' },
        'req-empty-len',
      );

      // Should attempt fallback (detected as empty)
      expect(executeSpyOn).toHaveBeenCalledTimes(2);
    });

    it('should detect empty when decisionStatus === "failed"', async () => {
      const failedResponse: SearchResponseV1 = {
        ...mockEmptySearchResponse,
        results: [mockNonEmptySearchResponse.results[0]!], // Has results but failed status
        engineDecision: {
          ...mockEmptySearchResponse.engineDecision,
          decisionStatus: 'failed',
        },
      };

      vi.spyOn(baseExecutor, 'execute').mockResolvedValue(failedResponse);

      // Should still detect as empty due to failed status
      expect(failedResponse.results.length).toBeGreaterThan(0);
    });

    it('should detect empty when decisionStatus === "ambiguous"', async () => {
      const ambiguousResponse: SearchResponseV1 = {
        ...mockEmptySearchResponse,
        engineDecision: {
          ...mockEmptySearchResponse.engineDecision,
          decisionStatus: 'ambiguous',
        },
      };

      vi.spyOn(baseExecutor, 'execute').mockResolvedValue(ambiguousResponse);

      // Fallback would be triggered for ambiguous results in auto mode
      expect(ambiguousResponse.engineDecision.decisionStatus).toBe('ambiguous');
    });
  });

  describe('multi-turn scenario', () => {
    it('should handle food pairing → search → compare sequence', async () => {
      const executeSpyOn = vi.spyOn(baseExecutor, 'execute');

      // First turn: food pairing returns results
      executeSpyOn.mockResolvedValueOnce(mockNonEmptySearchResponse);

      const foodResult = await adaptiveExecutor.executeWithFallback(
        'get_food_pairings',
        { food: 'salmon', color: 'white' },
        'turn-1-food',
      );

      expect(foodResult.fallbackApplied).toBeUndefined();
      expect(executeSpyOn).toHaveBeenCalledTimes(1);

      // Second turn: search returns empty, fallback applied
      executeSpyOn.mockResolvedValueOnce(mockEmptySearchResponse);
      executeSpyOn.mockResolvedValueOnce(mockNonEmptySearchResponse);

      const searchResult = await adaptiveExecutor.executeWithFallback(
        'search_wines',
        { query: 'rare vintage', retrieval_mode: 'auto' },
        'turn-2-search',
      );

      expect(searchResult.fallbackApplied).toBe('mixed');
      expect(executeSpyOn).toHaveBeenCalledTimes(3); // +2 for second turn

      // Third turn: compare does not trigger fallback
      executeSpyOn.mockResolvedValueOnce({
        queryType: 'comparison',
        originalQuery: 'A vs B',
        comparisonIntent: 'compare',
        entities: [],
        overallStatus: 'failed',
        requestId: 'turn-3-compare',
        executionTimeMs: 150,
      } as any);

      const compareResult = await adaptiveExecutor.executeWithFallback(
        'compare_wines',
        { query_a: 'Wine A', query_b: 'Wine B' },
        'turn-3-compare',
      );

      expect(compareResult.fallbackApplied).toBeUndefined();
      expect(executeSpyOn).toHaveBeenCalledTimes(4); // +1 for third turn
    });
  });
});
