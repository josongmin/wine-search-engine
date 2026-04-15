/**
 * ADR-014 Phase 1b.3b: graph-native soft weight for the ranker.
 *
 * When the compiled query ships a `ConstraintGraph`, the soft tier's
 * partial-satisfaction ratio is computed over the soft-tier subgraph
 * under AND / OR / XOR semantics, not the flat confidence-weighted
 * average. Under a trivial AND-only soft subgraph this collapses to
 * "matched soft slots / required soft slots", matching the pre-PR5
 * `computeSoftConstraint` fallback when no structured boosts are active.
 *
 * The ranker still prefers the `retrievalPlan.softBoosts` /
 * `retrievalPlan.inferredBoosts` confidence-weighted path when those
 * arrays are non-empty — this helper only replaces the flat fallback for
 * graph-aware branch semantics.
 */

import type { ConstraintGraph } from '../../query/model/constraint-graph.js';
import { computeGraphCoverage } from '../../query/service/compute-graph-coverage.js';
import { projectSoftTierSubgraph } from '../../query/service/graph-tier-projection.js';

export interface GraphSoftWeightInput {
  readonly graph: ConstraintGraph;
  readonly matchedAttributes: ReadonlySet<string>;
}

/**
 * Soft-tier coverage ratio on the soft subgraph.
 *
 * - Empty soft subgraph → 1 (no obligations, trivially covered).
 * - Trivial AND-all soft subgraph → |matched soft| / |required soft|.
 * - OR branch → 1 when any branch satisfied, otherwise the
 *   `coverageRatio` surfaced by `computeGraphCoverage` on its
 *   matched+unmet slot set.
 * - XOR branch → 1 when exactly one branch satisfied, otherwise the
 *   full-tree ratio.
 */
export function computeGraphSoftWeight(input: GraphSoftWeightInput): number {
  const softSubgraph = projectSoftTierSubgraph(input.graph);
  const coverage = computeGraphCoverage(softSubgraph, input.matchedAttributes);
  return coverage.coverageRatio;
}
