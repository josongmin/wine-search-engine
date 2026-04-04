import type { QueryClass } from '../../shared/types/index.js';

/**
 * A named phase in the retrieval cascade.
 */
export type RetrievalPhase = 'sparse' | 'dense' | 'anchor_neighborhood' | 'rerank';

/**
 * Implements the cascade routing logic from RFC-012 S9.4.
 *
 * The cascade router estimates query difficulty and determines which
 * retrieval phases to execute. Easier queries skip expensive phases
 * (dense search, anchor ANN, reranking) to reduce latency.
 *
 * - **Easy**: sparse only -> top-K -> decision
 * - **Medium**: sparse + dense -> RRF -> top-K
 * - **Hard**: full pipeline (sparse + dense + anchor ANN + rerank)
 */
export class CascadeRouter {
  /**
   * Estimate how difficult a query is to resolve, determining which
   * retrieval phases are needed.
   *
   * @param queryClass - The classification of the user query.
   * @param anchorConfidence - Confidence that the anchor entity is correct, in [0, 1].
   * @param aliasMatchStrength - Strength of alias matching for the query, in [0, 1].
   * @param constraintCount - Number of constraints parsed from the query.
   * @returns A difficulty level governing the retrieval cascade.
   */
  estimateDifficulty(
    queryClass: QueryClass,
    anchorConfidence: number,
    aliasMatchStrength: number,
    constraintCount: number,
  ): 'easy' | 'medium' | 'hard' {
    // Direct entity lookups with a strong alias match are easy
    if (queryClass === 'short_entity' && aliasMatchStrength >= 0.9) {
      return 'easy';
    }

    // Anchor-bearing queries with high confidence and few constraints are medium
    if (
      queryClass === 'anchored_similarity' &&
      anchorConfidence >= 0.8 &&
      constraintCount <= 2
    ) {
      return 'medium';
    }

    // Ambiguous short forms always need the full pipeline
    if (queryClass === 'ambiguous_short_form') {
      return 'hard';
    }

    // Semantic preference queries need dense search at minimum
    if (queryClass === 'semantic_preference' || queryClass === 'comparison_query') {
      return 'hard';
    }

    // Pure constraint queries with few constraints can be medium
    if (queryClass === 'pure_constraint' && constraintCount <= 3) {
      return 'medium';
    }

    // Many constraints or unknown class => hard
    if (constraintCount > 3 || queryClass === 'unknown') {
      return 'hard';
    }

    return 'medium';
  }

  /**
   * Return the ordered list of retrieval phases for a given difficulty level.
   *
   * @param difficulty - The estimated difficulty.
   * @returns Phases to execute, in order.
   */
  getPhases(difficulty: 'easy' | 'medium' | 'hard'): readonly RetrievalPhase[] {
    switch (difficulty) {
      case 'easy':
        return ['sparse'] as const;
      case 'medium':
        return ['sparse', 'dense'] as const;
      case 'hard':
        return ['sparse', 'dense', 'anchor_neighborhood', 'rerank'] as const;
    }
  }
}
