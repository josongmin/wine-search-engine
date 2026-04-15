/**
 * ADR-012 Phase 1b.2: deterministic merge of LLM-emitted topology onto
 * the Phase-1a trivial graph.
 *
 * Invariants:
 *  - **Disjoint node-id namespaces**. Trivial slot ids start with
 *    `slot-`; topology nodes start with `topology/`. Any violation →
 *    return `null` (fail-closed, caller keeps trivial).
 *  - **Slot nodes are anchored**. Merge cannot rewrite or drop trivial
 *    slot nodes; topology can only reference them.
 *  - **Root reassignment**. Topology designates a new `rootNodeId`
 *    (typically a topology group wrapping slots). The original trivial
 *    root may become an interior group or be dropped if superseded.
 *  - **Idempotent**. `merge(trivial, merge(trivial, t)) ===
 *    merge(trivial, t)` byte-for-byte.
 *  - **Origin**: result is always `origin: 'hybrid'`.
 *  - **Schema version**: result bumps to v1.1 (topology carries replay
 *    metadata).
 */

import {
  CONSTRAINT_GRAPH_SCHEMA_VERSION_V1_1,
  type ConstraintGraph,
  type ConstraintGraphNode,
} from '../model/constraint-graph.js';

const SLOT_NODE_ID_PREFIX = 'slot-';
const TOPOLOGY_NODE_ID_PREFIX = 'topology/';
/** Legacy trivial-root prefix produced by `buildTrivialGraphFromAtoms`. */
const TRIVIAL_ROOT_ID_PREFIX = 'root-and-';

function isSlotId(id: string): boolean {
  return id.startsWith(SLOT_NODE_ID_PREFIX);
}

function isTopologyId(id: string): boolean {
  return id.startsWith(TOPOLOGY_NODE_ID_PREFIX);
}

function isTrivialRootId(id: string): boolean {
  return id.startsWith(TRIVIAL_ROOT_ID_PREFIX);
}

/**
 * Merges an LLM-sourced topology graph with the trivial graph produced
 * by `buildTrivialGraphFromAtoms`. Returns `null` on any invariant
 * violation — caller is expected to treat `null` as "keep trivial".
 */
export function mergeTopologyIntoTrivial(
  trivial: ConstraintGraph,
  topology: ConstraintGraph,
): ConstraintGraph | null {
  // Invariant: trivial must be the deterministic projection we expect.
  if (trivial.origin !== 'deterministic_from_atoms') return null;

  const trivialSlotNodes = trivial.nodes.filter((n) => n.kind === 'slot');
  const slotIds = new Set(trivialSlotNodes.map((n) => n.nodeId));
  for (const id of slotIds) {
    if (!isSlotId(id)) {
      // Trivial projector's slot prefix drift — refuse to merge.
      return null;
    }
  }

  // Every topology node must live in the topology namespace.
  const topologyNodeIds = new Set<string>();
  for (const node of topology.nodes) {
    if (!isTopologyId(node.nodeId)) return null;
    if (topologyNodeIds.has(node.nodeId)) return null;
    topologyNodeIds.add(node.nodeId);
  }

  // No topology id may collide with a slot id.
  for (const id of topologyNodeIds) {
    if (slotIds.has(id)) return null;
  }

  // All child references must resolve into either slot ids or topology ids.
  for (const node of topology.nodes) {
    if (node.kind === 'group_and' || node.kind === 'group_or' || node.kind === 'group_xor') {
      for (const childId of node.children) {
        if (!slotIds.has(childId) && !topologyNodeIds.has(childId)) {
          return null;
        }
      }
    }
  }

  // Edges must reference topology nodes on both ends.
  for (const edge of topology.edges) {
    if (!topologyNodeIds.has(edge.from) || !topologyNodeIds.has(edge.to)) {
      return null;
    }
  }

  // Root must be a topology node (user-facing semantics: topology owns
  // the root; the trivial root is demoted to an interior helper or dropped).
  if (!topologyNodeIds.has(topology.rootNodeId)) return null;

  // Drop the trivial's `root-and-*` wrapper; its AND semantics are
  // subsumed by whichever topology group now sits at the root.
  const preservedTrivialNodes: ConstraintGraphNode[] = trivial.nodes.filter(
    (n) => !isTrivialRootId(n.nodeId),
  );

  const mergedNodes: ConstraintGraphNode[] = [
    ...topology.nodes,
    ...preservedTrivialNodes,
  ];

  return {
    graphSchemaVersion: CONSTRAINT_GRAPH_SCHEMA_VERSION_V1_1,
    origin: 'hybrid',
    rootNodeId: topology.rootNodeId,
    nodes: mergedNodes,
    edges: topology.edges,
    globalBudgets: topology.globalBudgets,
    ...(topology.promptVersion !== undefined ? { promptVersion: topology.promptVersion } : {}),
    ...(topology.generatedAt !== undefined ? { generatedAt: topology.generatedAt } : {}),
    ...(topology.llmModel !== undefined ? { llmModel: topology.llmModel } : {}),
  };
}
