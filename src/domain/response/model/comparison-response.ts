/**
 * Epic 14: Comparison Search Response Type
 *
 * Returned when a query is decomposed into multiple entity resolutions.
 * Structure: originalQuery → [subQuery A → resolve A, subQuery B → resolve B]
 */

import type { ResultItem } from './result-item.js';
import type { DecisionStatus } from '../../shared/types/index.js';

export type ComparisonEntityMode = 'entity' | 'concept';
export type ComparisonConceptEntityType =
  | 'country'
  | 'region'
  | 'appellation'
  | 'grape_primary'
  | 'wine_type';

/**
 * Concept/category comparison evidence that preserves the full candidate set
 * instead of collapsing the leg to a single representative top result.
 */
export interface ComparisonConceptAggregate {
  /** Canonical concept label for this concept leg. */
  readonly canonicalConcept: string;

  /** Structured field represented by `canonicalConcept`. */
  readonly conceptEntityType: ComparisonConceptEntityType;

  /** Representative result retained for backward-compatible top-result semantics. */
  readonly representativeResult: ResultItem | null;

  /** Full prototype axis for this concept leg, preserving all candidate evidence. */
  readonly prototypeAxis: readonly ResultItem[];

  /** Aggregate cardinality for the concept result set. */
  readonly aggregateResultCount: number;
}

/**
 * Single entity in a comparison result.
 */
export interface ComparisonEntity {
  /** The sub-query used to resolve this entity. */
  readonly subQuery: string;

  /** Whether this leg resolved a concrete entity or a concept/category representative set. */
  readonly comparisonMode?: ComparisonEntityMode | undefined;

  /** Canonical concept label used for concept/category comparisons. */
  readonly canonicalConcept?: string | undefined;

  /** Structured field represented by `canonicalConcept` for concept comparisons. */
  readonly conceptEntityType?: ComparisonConceptEntityType | undefined;

  /**
   * Concept/category aggregate evidence. Present only for concept legs so
   * callers can reason over the full prototype set instead of just `topResult`.
   */
  readonly conceptAggregate?: ComparisonConceptAggregate | undefined;

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
