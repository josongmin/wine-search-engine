import {
  RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY,
  RETRIEVAL_CHANNEL_DENSE_SEMANTIC,
  RETRIEVAL_CHANNEL_LEARNED_SPARSE,
  RETRIEVAL_CHANNEL_RELATIVE_FILTER,
  RETRIEVAL_CHANNEL_SPARSE_BM25
} from '../model/retrieval-channel.js';
/**
 * T4.1: Cascade router — channel-aware phases.
 *
 * RetrievalPhase is now typed against RetrievalChannel where applicable.
 * The difficulty estimation is unchanged; phase list is now expressed
 * in terms of channel vocabulary rather than legacy ad-hoc strings.
 */

import type { QueryClass } from '../../shared/types/index.js';
import type {
  ConstraintGraph,
  ConstraintGraphNode,
} from '../../query/model/constraint-graph.js';
import type { RetrievalChannel } from '../model/retrieval-channel.js';

/**
 * A named phase in the retrieval cascade.
 *
 * T4.1: Renamed 'anchor_neighborhood' → channel-aware name.
 * 'anchor_neighborhood' is kept as an alias for backward compat.
 * T4.3: Added RETRIEVAL_CHANNEL_LEARNED_SPARSE phase for SPLADE-style sparse retrieval.
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
 * T4.3: RETRIEVAL_CHANNEL_LEARNED_SPARSE phase maps to the RETRIEVAL_CHANNEL_LEARNED_SPARSE lexical channel.
 * T4.5: 'relative' phase maps to the RETRIEVAL_CHANNEL_RELATIVE_FILTER structural channel.
 */
export const PHASE_TO_CHANNEL: Readonly<Record<RetrievalPhase, RetrievalChannel | null>> = {
  sparse: RETRIEVAL_CHANNEL_SPARSE_BM25,
  learned_sparse: RETRIEVAL_CHANNEL_LEARNED_SPARSE,
  dense: RETRIEVAL_CHANNEL_DENSE_SEMANTIC,
  anchor_neighborhood: RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY,
  relative: RETRIEVAL_CHANNEL_RELATIVE_FILTER,
} as const;

/**
 * T4.1: Phase dispatch decision.
 * Records which phases are executed, skipped, and their channel mappings.
 */
interface PhaseDispatchDecision {
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

// ─── Constraint-graph-aware difficulty signals ────────────────────────────────
//
// Background: the legacy heuristic compares `constraintCount` to flat
// thresholds, treating "red AND Bordeaux AND dry" identically to
// "red OR white OR rosé" — they both have constraintCount=3, yet the
// AND query is genuinely hard (candidates collapse) while the OR query
// is easy (candidates expand). When a ConstraintGraph is available we
// derive AND-depth (required-attribute count) and OR-breadth (avg
// alternative count per OR group) and combine them into an explicit
// effective-complexity score.
//
// Formula:
//   effectiveConstraintComplexity = andDepth - LOG_FACTOR * log(1 + orBreadth)
//
// Rationale:
//   * andDepth is the count of "hard AND" required attributes — each one
//     directly narrows the candidate set, so it enters the score linearly.
//   * orBreadth widens the set sub-linearly (each extra alternative has
//     diminishing impact on the final candidate count under typical
//     attribute distributions). log(1 + x) is the natural sub-linear
//     dampener and treats orBreadth=0 as zero credit.
//   * LOG_FACTOR is a heuristic prior — set so two OR alternatives
//     (orBreadth≈2, log(3)≈1.10, 0.7*1.10≈0.77) approximately cancel one
//     extra AND constraint. The exact value will be calibrated by a
//     downstream sweep against bench-measured difficulty; current value
//     is the SOTA++ heuristic prior baseline.

/** Multiplier applied to log(1+orBreadth) when computing
 *  effectiveConstraintComplexity. See block comment above for derivation.
 *  Heuristic prior pending an offline difficulty-sweep calibration; exported
 *  + drift-locked by a regression test so the value cannot change silently
 *  without an explicit, intentional test amendment. */
export const LOG_FACTOR = 0.7;

// NOTE: there is intentionally no live CASCADE_EASY_THRESHOLD constant.
// An 'easy' (sparse-only) graph-aware route was prototyped (W4) but removed
// because it (a) dropped dense recall for andDepth=0 constraint queries with
// no recall justification and (b) was unreachable in prod — the only prod
// caller (candidate-pool.ts getDispatchDecision) never passes `graph`, so the
// graph-aware branch never runs. Below-hard graph queries route 'medium'
// (sparse + dense). If a graph-gated sparse-only fast path is reintroduced
// later, restore the threshold const here AND validate it against a recall
// benchmark before wiring `graph` into the prod caller.

/** effectiveConstraintComplexity at or above this threshold → 'hard'.
 *  Calibrated against the legacy `constraintCount > 3` cutoff: with
 *  AND-only inputs and orBreadth=0, andDepth=3 lands just under 3.0,
 *  andDepth=4 crosses it. Mixed queries with substantial OR breadth
 *  stay below the cutoff even at higher andDepth. */
const CASCADE_HARD_THRESHOLD = 3.0;

interface ConstraintGraphAnalysis {
  readonly andDepth: number;
  readonly orBreadth: number;
  readonly effectiveComplexity: number;
}

/**
 * Inspect a ConstraintGraph and derive AND-depth + OR-breadth signals.
 *
 * - `andDepth` = total count of slot nodes that sit under a `group_and`
 *   (transitively) — i.e. required attributes that all must hold. Slots
 *   reachable only through `group_or` / `group_xor` ancestors are
 *   excluded because they can be satisfied by alternatives, not all
 *   simultaneously.
 * - `orBreadth` = mean child count across `group_or` and `group_xor`
 *   nodes (0 when none exist). Using the mean (not the max) prevents a
 *   single very-wide OR group from dominating the score; queries with
 *   many small OR groups still raise the breadth gradually.
 * - `effectiveComplexity` = `andDepth - LOG_FACTOR * log(1 + orBreadth)`.
 *
 * Returns andDepth=0, orBreadth=0 for an empty graph (no slot nodes).
 */
export function analyzeConstraintGraph(
  graph: ConstraintGraph,
): ConstraintGraphAnalysis {
  const nodesById = new Map<string, ConstraintGraphNode>();
  for (const node of graph.nodes) {
    nodesById.set(node.nodeId, node);
  }

  // Find slots reachable only through AND ancestors. Walk from each
  // group_and's children; if a child is a slot, count it. If it's an
  // and-group, recurse. Stop at or/xor groups (those children are
  // optional, not required-all).
  let andDepth = 0;
  const orChildCounts: number[] = [];

  const visitedAndChildren = new Set<string>();
  for (const node of graph.nodes) {
    if (node.kind === 'group_and') {
      for (const childId of node.children) {
        collectAndReachableSlots(childId);
      }
    } else if (node.kind === 'group_or' || node.kind === 'group_xor') {
      orChildCounts.push(node.children.length);
    }
  }

  function collectAndReachableSlots(nodeId: string): void {
    if (visitedAndChildren.has(nodeId)) return;
    visitedAndChildren.add(nodeId);
    const child = nodesById.get(nodeId);
    if (child === undefined) return;
    if (child.kind === 'slot') {
      andDepth += 1;
      return;
    }
    if (child.kind === 'group_and') {
      for (const grandChildId of child.children) {
        collectAndReachableSlots(grandChildId);
      }
      return;
    }
    // group_or / group_xor / subquery: do NOT descend into; their slots
    // are alternatives, not required-all.
  }

  const orBreadth =
    orChildCounts.length === 0
      ? 0
      : orChildCounts.reduce((acc, n) => acc + n, 0) / orChildCounts.length;

  const effectiveComplexity =
    andDepth - LOG_FACTOR * Math.log(1 + orBreadth);

  return { andDepth, orBreadth, effectiveComplexity };
}

export class CascadeRouter {
  /**
   * Estimate how difficult a query is to resolve, determining which
   * retrieval phases are needed.
   *
   * When `graph` is supplied, AND-depth + OR-breadth derived from the
   * graph replace the flat `constraintCount` heuristic for the
   * constraint-driven branches. When `graph` is absent, the legacy
   * `constraintCount` heuristic is preserved verbatim (backward-compat
   * for callers that have not yet been wired to ConstraintGraph).
   *
   * @param queryClass - The classification of the user query.
   * @param anchorConfidence - Confidence that the anchor entity is correct, in [0, 1].
   * @param aliasMatchStrength - Strength of alias matching for the query, in [0, 1].
   * @param constraintCount - Number of constraints parsed from the query.
   * @param graph - Optional ConstraintGraph used to derive AND/OR semantics.
   * @returns A difficulty level governing the retrieval cascade.
   */
  estimateDifficulty(
    queryClass: QueryClass,
    anchorConfidence: number,
    aliasMatchStrength: number,
    constraintCount: number,
    graph?: ConstraintGraph,
  ): 'easy' | 'medium' | 'hard' {
    if (
      (queryClass === 'exact_entity' || queryClass === 'short_entity') &&
      aliasMatchStrength >= CASCADE_EASY_ALIAS_MATCH_STRENGTH
    ) {
      return 'easy';
    }

    if (queryClass === 'ambiguous_short_form') {
      return 'hard';
    }

    if (queryClass === 'semantic_preference' || queryClass === 'comparison_query') {
      return 'hard';
    }

    if (graph !== undefined) {
      const analysis = analyzeConstraintGraph(graph);

      if (
        queryClass === 'anchored_similarity' &&
        anchorConfidence >= CASCADE_MEDIUM_ANCHOR_CONFIDENCE &&
        analysis.effectiveComplexity < CASCADE_HARD_THRESHOLD
      ) {
        return 'medium';
      }

      if (analysis.effectiveComplexity >= CASCADE_HARD_THRESHOLD) {
        return 'hard';
      }
      if (queryClass === 'unknown') {
        return 'hard';
      }
      // Below CASCADE_HARD_THRESHOLD (OR-heavy / few-AND queries) → 'medium':
      // sparse + dense. Dense recall is deliberately KEPT even for pure-OR /
      // andDepth=0 queries — see the CASCADE_EASY_THRESHOLD removal note near
      // CASCADE_HARD_THRESHOLD for why the 'easy' (sparse-only) graph route was
      // dropped. The 'easy' difficulty (getPhases('easy')) therefore has no
      // live prod entry point today.
      return 'medium';
    }

    // ── Backward-compat fallback (no graph available) ─────────────────
    if (
      queryClass === 'anchored_similarity' &&
      anchorConfidence >= CASCADE_MEDIUM_ANCHOR_CONFIDENCE &&
      constraintCount <= 2
    ) {
      return 'medium';
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
    graph?: ConstraintGraph,
  ): PhaseDispatchDecision {
    const difficulty = this.estimateDifficulty(
      queryClass,
      anchorConfidence,
      aliasMatchStrength,
      constraintCount,
      graph,
    );
    const allPhases: readonly RetrievalPhase[] = [
      'sparse',
      RETRIEVAL_CHANNEL_LEARNED_SPARSE,
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
