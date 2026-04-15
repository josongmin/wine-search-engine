/**
 * ADR-014 Phase 1b.3b: tier-scoped subgraph projections for ranker
 * consumers.
 *
 * `computeGraphCoverage` (ADR-011 Phase 1b.1) treats every slot in a
 * graph uniformly. The ranker's hard / soft / inferred evaluations each
 * need to restrict attention to slots of a particular `sourceTier`:
 *
 * - Hard gate → only `sourceTier === 'hard'` slots contribute.
 * - Soft weight → only `sourceTier === 'soft'` slots contribute.
 * - Inferred boost → only `sourceTier === 'inferred'` slots contribute.
 *
 * We implement this by projecting the full graph into a tier-scoped
 * subgraph, keeping the group topology (AND / OR / XOR nesting) intact
 * but dropping slot children of other tiers from each group's child
 * list.  Groups whose children all drop out remain in the tree but
 * evaluate vacuously (empty AND → satisfied; empty OR → unsatisfied),
 * matching classical logic.
 *
 * The projection is a pure function and is memoisation-safe (deep
 * readonly result, deterministic for identical input).
 */

import type {
  ConstraintGraph,
  ConstraintGraphNode,
  GroupAndNode,
  GroupOrNode,
  GroupXorNode,
} from '../model/constraint-graph.js';
import type { ConstraintTier } from '../../shared/types/constraint-atom.js';

function isGroup(
  node: ConstraintGraphNode,
): node is GroupAndNode | GroupOrNode | GroupXorNode {
  return (
    node.kind === 'group_and' ||
    node.kind === 'group_or' ||
    node.kind === 'group_xor'
  );
}

function projectForTier(
  graph: ConstraintGraph,
  tier: ConstraintTier,
): ConstraintGraph {
  const nodesById = new Map<string, ConstraintGraphNode>();
  for (const node of graph.nodes) nodesById.set(node.nodeId, node);

  const projected = new Map<string, ConstraintGraphNode>();

  const visit = (nodeId: string): void => {
    if (projected.has(nodeId)) return;
    const node = nodesById.get(nodeId);
    if (node === undefined) return;

    switch (node.kind) {
      case 'slot': {
        if (node.sourceTier === tier) {
          projected.set(node.nodeId, node);
        }
        return;
      }
      case 'subquery': {
        // Subquery nodes are passthrough for coverage purposes — include
        // them so group children references remain valid. They contribute
        // nothing to satisfaction math.
        projected.set(node.nodeId, node);
        return;
      }
      case 'group_and':
      case 'group_or':
      case 'group_xor': {
        const keptChildren: string[] = [];
        for (const childId of node.children) {
          visit(childId);
          const child = nodesById.get(childId);
          if (child === undefined) continue;
          if (child.kind === 'slot') {
            if (child.sourceTier === tier) keptChildren.push(childId);
            continue;
          }
          if (isGroup(child)) {
            // Keep the group iff at least one descendant survived.
            if (projected.has(childId)) keptChildren.push(childId);
            continue;
          }
          // Subquery child — keep reference.
          keptChildren.push(childId);
        }
        const projectedGroup: ConstraintGraphNode = {
          ...node,
          children: keptChildren,
        };
        // Retain the root even if every child dropped — keeping it lets
        // `computeGraphCoverage` evaluate the empty-AND → true /
        // empty-OR → false rule deterministically.
        if (keptChildren.length > 0 || node.nodeId === graph.rootNodeId) {
          projected.set(node.nodeId, projectedGroup);
        }
        return;
      }
    }
  };

  visit(graph.rootNodeId);

  // Ensure every group's children list only references nodes that
  // survived projection — callers of `computeGraphCoverage` silently
  // skip dangling references but explicit pruning keeps the projected
  // graph self-describing.
  const cleanNodes: ConstraintGraphNode[] = [];
  for (const node of projected.values()) {
    if (isGroup(node)) {
      const cleanChildren = node.children.filter((id) => projected.has(id));
      cleanNodes.push({ ...node, children: cleanChildren });
    } else {
      cleanNodes.push(node);
    }
  }

  return {
    graphSchemaVersion: graph.graphSchemaVersion,
    origin: graph.origin,
    rootNodeId: graph.rootNodeId,
    nodes: cleanNodes,
    // Edges ignored by Phase 1b.1 coverage; retained for callers that
    // may consume the projection downstream.
    edges: graph.edges,
    globalBudgets: graph.globalBudgets,
  };
}

export function projectHardTierSubgraph(graph: ConstraintGraph): ConstraintGraph {
  return projectForTier(graph, 'hard');
}

export function projectSoftTierSubgraph(graph: ConstraintGraph): ConstraintGraph {
  return projectForTier(graph, 'soft');
}
