/**
 * ADR-014 Phase 1b.3b: graph-native hard gate predicate for the ranker.
 *
 * When the compiled query ships a `ConstraintGraph`, the hard gate is
 * defined as "the hard-tier subgraph is `rootSatisfied`" rather than the
 * pre-PR5 flat AND-all over `constraints.hard`. Under AND-only (the
 * Phase-1a trivial graph) the two semantics coincide byte-identically;
 * under OR / XOR the graph semantics is the single correct answer.
 *
 * This module is a pure delegating helper — the composition rules all
 * live in {@link computeGraphCoverage} (ADR-011 Phase 1b.1) so the XOR /
 * OR / AND vocabulary cannot drift across readers.
 *
 * Attribute-level satisfaction is still the unit primitive: the caller
 * supplies the set of attribute names the candidate actually matches.
 */

import type { ConstraintGraph } from '../../query/model/constraint-graph.js';
import { computeGraphCoverage } from '../../query/service/compute-graph-coverage.js';
import { projectHardTierSubgraph } from '../../query/service/graph-tier-projection.js';

interface GraphHardGateInput {
  readonly graph: ConstraintGraph;
  readonly matchedAttributes: ReadonlySet<string>;
}

/**
 * Returns true when the hard-tier subgraph of {@link GraphHardGateInput.graph}
 * is `rootSatisfied` given the candidate-supplied `matchedAttributes`.
 *
 * - Trivial AND-all graph → equivalent to the pre-PR5 flat predicate.
 * - OR group → any satisfied branch passes; other branches do not
 *   surface as "unmet" toward the gate.
 * - XOR group → exactly one satisfied branch passes; zero or >=2 fail.
 * - Nested groups compose recursively.
 */
export function evaluateGraphHardGate(input: GraphHardGateInput): boolean {
  const hardSubgraph = projectHardTierSubgraph(input.graph);
  const coverage = computeGraphCoverage(hardSubgraph, input.matchedAttributes);
  return coverage.rootSatisfied;
}
