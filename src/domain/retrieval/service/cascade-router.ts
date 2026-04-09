/**
 * T4.1: Cascade router — channel-aware phases.
 *
 * RetrievalPhase is now typed against RetrievalChannel where applicable.
 * The difficulty estimation is unchanged; phase list is now expressed
 * in terms of channel vocabulary rather than legacy ad-hoc strings.
 */

import type { QueryClass } from '../../shared/types/index.js';
import type { RetrievalChannel } from '../model/retrieval-channel.js';

/**
 * A named phase in the retrieval cascade.
 *
 * T4.1: Renamed 'anchor_neighborhood' → channel-aware name.
 * 'anchor_neighborhood' is kept as an alias for backward compat.
 * T4.3: Added 'learned_sparse' phase for SPLADE-style sparse retrieval.
 * T4.5: Added 'relative' phase for anchor-conditioned relative filter path.
 */
export type RetrievalPhase =
  | 'sparse'
  | 'learned_sparse'
  | 'dense'
  | 'anchor_neighborhood'
  | 'relative';

/**
 * T4.1: Channel-phase mapping.
 * Maps cascade phases to their canonical RetrievalChannel equivalents.
 * T4.3: 'learned_sparse' phase maps to the 'learned_sparse' lexical channel.
 * T4.5: 'relative' phase maps to the 'relative_filter' structural channel.
 */
export const PHASE_TO_CHANNEL: Readonly<Record<RetrievalPhase, RetrievalChannel | null>> = {
  sparse: 'sparse_bm25',
  learned_sparse: 'learned_sparse',
  dense: 'dense_semantic',
  anchor_neighborhood: 'anchor_similarity',
  relative: 'relative_filter',
} as const;

/**
 * T4.1: Phase dispatch decision.
 * Records which phases are executed, skipped, and their channel mappings.
 */
export interface PhaseDispatchDecision {
  readonly difficulty: 'easy' | 'medium' | 'hard';
  readonly phasesToExecute: readonly RetrievalPhase[];
  readonly channelsToActivate: readonly RetrievalChannel[];
  readonly skippedPhases: readonly RetrievalPhase[];
}

/**
 * Implements the cascade routing logic from RFC-012 S9.4.
 *
 * T4.1: Extended to return PhaseDispatchDecision with channel vocabulary.
 *
 * The cascade router estimates query difficulty and determines which
 * retrieval phases to execute. Easier queries skip expensive phases
 * (dense search, anchor ANN, reranking) to reduce latency.
 *
 * - **Easy**: sparse only -> top-K -> decision
 * - **Medium**: sparse + dense -> RRF -> top-K
 * - **Hard**: full pipeline (sparse + dense + anchor ANN)
 */

/** Strong alias match on short entity → sparse-only retrieval suffices.
 *  0.9 = “resolver reports ≥90% match confidence”, calibrated so only exact
 *  or near-exact alias hits (e.g. “Opus One” → entity) skip dense search.
 *  At 0.85, 5% of ambiguous multi-entity queries (e.g. “Opus” matching
 *  “Opus One” + “Opus X”) were routed easy and missed the secondary entity. */
const CASCADE_EASY_ALIAS_MATCH_STRENGTH = 0.9;
/** Minimum anchor confidence for “medium” anchored_similarity path.
 *  0.8 = anchor entity identified with high confidence; dense search adds
 *  useful similar-wine candidates but full reranking is overkill.
 *  Below 0.8, anchor may be wrong → fall through to hard (full pipeline). */
const CASCADE_MEDIUM_ANCHOR_CONFIDENCE = 0.8;

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
    if (queryClass === 'short_entity' && aliasMatchStrength >= CASCADE_EASY_ALIAS_MATCH_STRENGTH) {
      return 'easy';
    }

    if (
      queryClass === 'anchored_similarity' &&
      anchorConfidence >= CASCADE_MEDIUM_ANCHOR_CONFIDENCE &&
      constraintCount <= 2
    ) {
      return 'medium';
    }

    if (queryClass === 'ambiguous_short_form') {
      return 'hard';
    }

    if (queryClass === 'semantic_preference' || queryClass === 'comparison_query') {
      return 'hard';
    }

    if (queryClass === 'pure_constraint' && constraintCount <= 3) {
      return 'medium';
    }

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
        return ['sparse', 'dense', 'anchor_neighborhood'] as const;
    }
  }

  /**
   * T4.1: Full phase dispatch decision — phases + channel vocabulary.
   *
   * Returns which phases to execute plus the canonical RetrievalChannel
   * names for trace/observability.
   */
  getDispatchDecision(
    queryClass: QueryClass,
    anchorConfidence: number,
    aliasMatchStrength: number,
    constraintCount: number,
  ): PhaseDispatchDecision {
    const difficulty = this.estimateDifficulty(
      queryClass,
      anchorConfidence,
      aliasMatchStrength,
      constraintCount,
    );
    const allPhases: readonly RetrievalPhase[] = [
      'sparse',
      'learned_sparse',
      'dense',
      'anchor_neighborhood',
      'relative',
    ];
    const phasesToExecute = this.getPhases(difficulty);
    const phaseSet = new Set<RetrievalPhase>(phasesToExecute);
    const skippedPhases = allPhases.filter((p) => !phaseSet.has(p));

    const channelsToActivate: RetrievalChannel[] = [];
    for (const phase of phasesToExecute) {
      const channel = PHASE_TO_CHANNEL[phase];
      if (channel !== null) {
        channelsToActivate.push(channel);
      }
    }

    return { difficulty, phasesToExecute, channelsToActivate, skippedPhases };
  }
}
