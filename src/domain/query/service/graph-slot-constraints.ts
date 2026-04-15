/**
 * ADR-014 Phase 1b.3b: project a tier-scoped `NormalizedConstraint[]` out
 * of a `ConstraintGraph`.
 *
 * Specialized retrievers (browse-producer, browse-region,
 * compare-against-anchor) extract their Vespa sparse-filter tokens from
 * `plan.constraints.hard`. Under the graph-native ranker plane, the
 * authoritative source is the graph's hard-tier slot subgraph —
 * extracting from the flat bundle silently drops OR / XOR context in
 * hybrid graphs.
 *
 * This helper returns the flat list of `NormalizedConstraint` values
 * derived from the graph's slot nodes at a given tier, in node
 * insertion order. For the Phase-1a trivial graph (one `group_and` root
 * with every atom as a slot child) the emitted list is byte-identical
 * to `plan.constraints.hard` (same order, same `(attribute, operator,
 * value, confidence)` shape). Hybrid graphs flatten OR / XOR disjunctions
 * to the union of their slot entries — Vespa sparse filters are
 * AND-of-ORs by construction, so disjunction semantics surface naturally
 * via the per-attribute filter builder.
 *
 * Pure function; memoisation-safe; no I/O.
 */

import type {
  ConstraintGraph,
  SlotNode,
} from '../model/constraint-graph.js';
import type { NormalizedConstraint } from '../../shared/types/constraint-bundle.js';
import type { ConstraintTier } from '../../shared/types/constraint-atom.js';

function slotToConstraint(slot: SlotNode): NormalizedConstraint {
  return {
    attribute: slot.attribute,
    operator: slot.operator,
    value: slot.value,
    confidence: slot.confidence,
    // Graph slot nodes do not carry the originating source_phrase; the trivial
    // projector strips it. Downstream readers that need the phrase must fall
    // back to the atom array (resolveAtomForSlot) rather than this projection.
    source_phrase: `graph_slot(${slot.attribute})`,
  };
}

function extractTierConstraintsFromGraph(
  graph: ConstraintGraph,
  tier: ConstraintTier,
): readonly NormalizedConstraint[] {
  const out: NormalizedConstraint[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== 'slot') continue;
    if (node.sourceTier !== tier) continue;
    out.push(slotToConstraint(node));
  }
  return out;
}

export function extractHardConstraintsFromGraph(
  graph: ConstraintGraph,
): readonly NormalizedConstraint[] {
  return extractTierConstraintsFromGraph(graph, 'hard');
}
