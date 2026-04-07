/**
 * Epic 14: Comparison Search Response Type
 *
 * Returned when a query is decomposed into multiple entity resolutions.
 * Structure: originalQuery → [subQuery A → resolve A, subQuery B → resolve B]
 */

import type { ResultItem } from './result-item.js';
import type { DecisionStatus } from '../../shared/types/index.js';

/**
 * Single entity in a comparison result.
 */
export interface ComparisonEntity {
  /** The sub-query used to resolve this entity. */
  readonly subQuery: string;

  /** Top-ranked result item (null if no match). */
  readonly topResult: ResultItem | null;

  /** Total number of matching results. */
  readonly resultCount: number;

  /** Resolution status: resolved, ambiguous, no_match, etc. */
  readonly resolutionStatus: DecisionStatus;

  /** All candidate results (for detailed comparison). */
  readonly allResults: readonly ResultItem[];
}

/**
 * Comparison search response for "A vs B" queries.
 */
export interface ComparisonSearchResponse {
  readonly queryType: 'comparison';
  readonly originalQuery: string;

  /** User intent: 'compare' (neutral), 'recommend_one' (which is better), 'list_both' (details). */
  readonly comparisonIntent: 'compare' | 'recommend_one' | 'list_both';

  /** Two entities being compared. */
  readonly entities: [ComparisonEntity, ComparisonEntity];

  /** Overall resolution status (resolved if both resolved; ambiguous if one ambiguous, etc.). */
  readonly overallStatus: DecisionStatus;

  /** Execution metadata. */
  readonly requestId: string;
  readonly executionTimeMs: number;
  readonly authorityTraceRef?: string | undefined;
  readonly runtimeCorrelationRef?: string | undefined;
}
