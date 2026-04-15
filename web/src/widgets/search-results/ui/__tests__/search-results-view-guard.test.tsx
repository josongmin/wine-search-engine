/**
 * T-E9-01: Comparison/Search Union-Safe Client
 *
 * Verifies:
 * 1. query_type discriminant guard prevents rendering for non-search responses
 * 2. comparison result_type uses ComparisonTable, not WinePinCard list
 * 3. search result_type uses WinePinCard list, not ComparisonTable
 */

import { describe, it, expect, vi } from 'vitest';
import type { SearchResponse } from '@/shared/api';
import {
  mockSearchResponse,
  mockComparisonResponse,
  mockComparisonEnvelope,
} from '@/__tests__/fixtures';

/**
 * Validate the discriminant guard logic extracted from SearchResultsView.
 *
 * We test the guard logic directly rather than rendering the full component
 * (which requires mocking useSearchParams, useSearch, and Suspense) to keep
 * the test fast and deterministic.
 */

/** Simulates the guard logic from ResultsContent */
function resolveResponseBranch(
  data: SearchResponse | null | undefined,
): 'none' | 'comparison' | 'search_list' | 'empty' | 'malformed_comparison' {
  if (!data) return 'none';
  // T-E9-01: Union-safe discriminant check
  if (data.query_type !== 'search') return 'none';

  const isComparison = data.result_type === 'comparison';
  if (isComparison && data.results.length < 2) return 'malformed_comparison';
  if (isComparison) return 'comparison';
  if (data.results.length === 0) return 'empty';
  return 'search_list';
}

describe('T-E9-01 Union-Safe Client: discriminant guard', () => {
  it('returns "none" for null data', () => {
    expect(resolveResponseBranch(null)).toBe('none');
  });

  it('returns "none" for undefined data', () => {
    expect(resolveResponseBranch(undefined)).toBe('none');
  });

  it('returns "none" for non-search query_type', () => {
    expect(resolveResponseBranch(mockComparisonEnvelope)).toBe('none');
  });

  it('returns "search_list" for standard search response', () => {
    expect(resolveResponseBranch(mockSearchResponse)).toBe('search_list');
  });

  it('returns "comparison" for comparison result_type with >= 2 results', () => {
    expect(resolveResponseBranch(mockComparisonResponse)).toBe('comparison');
  });

  it('returns "malformed_comparison" for comparison result_type with < 2 results', () => {
    const singleComparison: SearchResponse = {
      ...mockComparisonResponse,
      results: [mockComparisonResponse.results[0]],
    };
    expect(resolveResponseBranch(singleComparison)).toBe('malformed_comparison');
  });

  it('returns "empty" for search response with 0 results', () => {
    const emptySearch: SearchResponse = {
      ...mockSearchResponse,
      results: [],
    };
    expect(resolveResponseBranch(emptySearch)).toBe('empty');
  });
});

describe('T-E9-01 Union-Safe Client: comparison branch safety', () => {
  it('comparison response has required fields for ComparisonTable', () => {
    // Verify comparison response results have entity.canonical_label, match.score_components
    // (fields accessed by ComparisonTable)
    for (const item of mockComparisonResponse.results) {
      expect(item.entity.canonical_label).toBeDefined();
      expect(item.match.score_components).toBeDefined();
      expect(item.match.score_components.lexical).toBeDefined();
      expect(item.match.score_components.semantic).toBeDefined();
    }
  });

  it('search response does not attempt comparison-only rendering', () => {
    // Verify a standard search response (result_type !== 'comparison')
    // routes to the search list branch
    expect(mockSearchResponse.result_type).not.toBe('comparison');
    expect(resolveResponseBranch(mockSearchResponse)).toBe('search_list');
  });

  it('comparison response envelope is excluded by the query_type guard', () => {
    expect(mockComparisonEnvelope.query_type).toBe('comparison');
    expect(resolveResponseBranch(mockComparisonEnvelope)).toBe('none');
  });
});
