/**
 * E6-U3: Decomposition Reuse Map (lock)
 *
 * Decomposition is a REUSE path, not a new runtime:
 *   - Detection: this file (decomposition-detector.ts)
 *   - Model: domain/query/model/query-decomposition.ts
 *   - Adapter seam: application/search/decomposed-search-adapter.ts
 *
 * Do NOT create a decomposition-specific orchestrator stack or a parallel
 * search runtime for decomposed queries. The DecomposedSearchAdapter is the
 * single wiring point — it holds a delegate to the main SearchUseCase.
 *
 * Epic 14, Step 14.1: Query Decomposition Detector
 *
 * Detects "A vs B" style comparison queries and decomposes them into
 * two separate entity resolution queries.
 *
 * Patterns:
 *  - English: "X vs Y", "X versus Y", "compare X and Y"
 *  - Korean: "X와 Y", "X랑 Y 비교", "X 또는 Y"
 */

import {
  toQueryDecompositionHint,
  type QueryDecompositionHint,
} from '../model/query-decomposition.js';

export interface DecompositionResult {
  readonly decomposed: false;
}

export interface SuccessfulDecomposition {
  readonly decomposed: true;
  readonly subQueries: [string, string];
  readonly comparisonIntent: 'compare' | 'recommend_one' | 'list_both';
}

export type DecompositionOutcome = DecompositionResult | SuccessfulDecomposition;

export interface QueryDecompositionAnalysis {
  readonly outcome: DecompositionOutcome;
  readonly hint: QueryDecompositionHint;
}

/**
 * Regex patterns for detecting decomposable comparison queries.
 * Ordered by priority (more specific to less specific).
 */
const COMPARISON_PATTERNS: ReadonlyArray<RegExp> = [
  // English: "X vs Y", "X vs. Y", "X versus Y"
  /(.+?)\s+(?:vs\.?|versus)\s+(.+?)(?:\?|$)/i,

  // English: "compare X and Y", "compare X with Y"
  /(?:compare)\s+(.+?)\s+(?:and|with)\s+(.+?)(?:\?|$)/i,

  // Korean: "X와 Y", "X랑 Y", "X하고 Y"
  /(.+?)\s+(?:와|과|랑|하고|이랑)\s+(.+?)\s+(?:중|비교|비교하면|뭐가|어떤|차이|어느)(?:\?|$)/,

  // English: "X or Y which is better"
  /(.+?)\s+or\s+(.+?)\s+(?:which|better|choice)(?:\?|$)/i,

  // Korean: "X 또는 Y 어느"
  /(.+?)\s+(?:또는|아니면)\s+(.+?)\s+(?:어느|뭐|어떤)(?:\?|$)/,
];

/**
 * Detects whether a query is a decomposable comparison query.
 * Returns sub-queries and inferred comparison intent.
 */
export function detectDecomposition(query: string): DecompositionOutcome {
  for (const pattern of COMPARISON_PATTERNS) {
    const match = pattern.exec(query);
    if (match !== null && match[1] !== undefined && match[2] !== undefined) {
      const subQuery1 = match[1].trim();
      const subQuery2 = match[2].trim();

      // Sanity check: both sub-queries must be non-empty
      if (subQuery1.length > 0 && subQuery2.length > 0) {
        return {
          decomposed: true,
          subQueries: [subQuery1, subQuery2],
          comparisonIntent: inferComparisonIntent(query),
        };
      }
    }
  }

  return { decomposed: false };
}

export function analyzeQueryDecomposition(query: string): QueryDecompositionAnalysis {
  const outcome = detectDecomposition(query);
  return {
    outcome,
    hint: toQueryDecompositionHint(outcome),
  };
}

/**
 * Infers the user's intent from the comparison query.
 * - 'compare': neutral comparison
 * - 'recommend_one': user asking which one is better
 * - 'list_both': user asking for details on both
 */
function inferComparisonIntent(
  query: string,
): 'compare' | 'recommend_one' | 'list_both' {
  const q = query.toLowerCase();

  // "which is better", "추천", "추천해", "어느 게 좋아"
  // Use Unicode-aware boundaries: \b is ASCII-only and silently fails on Korean.
  if (/(?:^|[^\p{L}\p{N}])(?:which|better|recommend|추천|좋아|나은)(?=$|[^\p{L}\p{N}])/iu.test(q)) {
    return 'recommend_one';
  }

  // "both", "둘 다", "정보", "details"
  if (/(?:^|[^\p{L}\p{N}])(?:both|details|information|둘|다|정보)(?=$|[^\p{L}\p{N}])/iu.test(q)) {
    return 'list_both';
  }

  // Default: neutral comparison
  return 'compare';
}

/**
 * Checks if a query looks like a trivial decomposition attempt.
 * (e.g. empty sub-queries after extraction)
 */
export function isValidDecomposition(result: DecompositionOutcome): result is SuccessfulDecomposition {
  if (!result.decomposed) return false;

  const [q1, q2] = result.subQueries;
  // Both must have actual entity-like tokens (not just articles/prepositions)
  return q1.split(/\s+/).length >= 1 && q2.split(/\s+/).length >= 1;
}
