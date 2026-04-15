import type {
  ConstraintGraph,
  ConstraintGraphNode,
  GroupAndNode,
  GroupOrNode,
  GroupXorNode,
  SlotNode,
} from '../model/constraint-graph.js';
import { collectApplicableSlotIdsForSubquery } from './subquery-slot-scope.js';

type GroupNode = GroupAndNode | GroupOrNode | GroupXorNode;

function indexNodes(
  graph: ConstraintGraph,
): ReadonlyMap<string, ConstraintGraphNode> {
  const out = new Map<string, ConstraintGraphNode>();
  for (const node of graph.nodes) out.set(node.nodeId, node);
  return out;
}

function indexParents(
  graph: ConstraintGraph,
): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    if (
      node.kind !== 'group_and'
      && node.kind !== 'group_or'
      && node.kind !== 'group_xor'
    ) {
      continue;
    }
    for (const childId of node.children) {
      const parents = out.get(childId) ?? new Set<string>();
      parents.add(node.nodeId);
      out.set(childId, parents);
    }
  }
  return out;
}

function isGroupNode(node: ConstraintGraphNode): node is GroupNode {
  return (
    node.kind === 'group_and'
    || node.kind === 'group_or'
    || node.kind === 'group_xor'
  );
}

function isSlotNode(node: ConstraintGraphNode): node is SlotNode {
  return node.kind === 'slot';
}

function retainAncestors(
  nodeId: string,
  parentsByChild: ReadonlyMap<string, ReadonlySet<string>>,
  retainedNodeIds: Set<string>,
): void {
  if (retainedNodeIds.has(nodeId)) return;
  retainedNodeIds.add(nodeId);
  const parents = parentsByChild.get(nodeId);
  if (parents === undefined) return;
  for (const parentId of parents) {
    retainAncestors(parentId, parentsByChild, retainedNodeIds);
  }
}

function pruneNodeChildren(
  node: ConstraintGraphNode,
  retainedNodeIds: ReadonlySet<string>,
): ConstraintGraphNode {
  if (!isGroupNode(node)) return node;
  return {
    ...node,
    children: node.children.filter((childId) => retainedNodeIds.has(childId)),
  };
}

/**
 * Exact subquery-scoped projection that preserves the original group kinds
 * (AND / OR / XOR) instead of flattening retained slots into a synthetic
 * AND root.
 */
export function projectConstraintGraphForSubquery(
  graph: ConstraintGraph,
  subqueryId: string,
): ConstraintGraph | undefined {
  const applicableSlotIds = collectApplicableSlotIdsForSubquery(graph, subqueryId);
  if (applicableSlotIds.size === 0) return undefined;

  const parentsByChild = indexParents(graph);
  const retainedNodeIds = new Set<string>();
  for (const slotId of applicableSlotIds) {
    retainAncestors(slotId, parentsByChild, retainedNodeIds);
  }

  const nodes = graph.nodes
    .filter((node) => retainedNodeIds.has(node.nodeId))
    .map((node) => pruneNodeChildren(node, retainedNodeIds));

  if (!retainedNodeIds.has(graph.rootNodeId) || nodes.length === 0) {
    return undefined;
  }

  return {
    graphSchemaVersion: graph.graphSchemaVersion,
    origin: graph.origin,
    rootNodeId: graph.rootNodeId,
    nodes,
    edges: graph.edges.filter(
      (edge) =>
        retainedNodeIds.has(edge.from) && retainedNodeIds.has(edge.to),
    ),
    globalBudgets: graph.globalBudgets,
    ...(graph.promptVersion !== undefined
      ? { promptVersion: graph.promptVersion }
      : {}),
    ...(graph.generatedAt !== undefined
      ? { generatedAt: graph.generatedAt }
      : {}),
    ...(graph.llmModel !== undefined ? { llmModel: graph.llmModel } : {}),
  };
}

function intersectSets(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const value of left) {
    if (right.has(value)) out.add(value);
  }
  return out;
}

function collectMandatorySlotIdsForNode(
  nodeId: string,
  nodesById: ReadonlyMap<string, ConstraintGraphNode>,
  memo: Map<string, ReadonlySet<string>>,
): ReadonlySet<string> {
  const cached = memo.get(nodeId);
  if (cached !== undefined) return cached;

  const node = nodesById.get(nodeId);
  if (node === undefined) {
    const empty = new Set<string>();
    memo.set(nodeId, empty);
    return empty;
  }

  if (isSlotNode(node)) {
    const only = new Set([node.nodeId]);
    memo.set(nodeId, only);
    return only;
  }

  if (!isGroupNode(node)) {
    const empty = new Set<string>();
    memo.set(nodeId, empty);
    return empty;
  }

  const childSets = node.children.map((childId) =>
    collectMandatorySlotIdsForNode(childId, nodesById, memo),
  );

  let mandatory: ReadonlySet<string>;
  if (node.kind === 'group_and') {
    const union = new Set<string>();
    for (const childSet of childSets) {
      for (const slotId of childSet) union.add(slotId);
    }
    mandatory = union;
  } else if (childSets.length === 0) {
    mandatory = new Set<string>();
  } else {
    let current = new Set<string>(childSets[0]);
    for (let i = 1; i < childSets.length; i += 1) {
      current = new Set(intersectSets(current, childSets[i] ?? new Set()));
    }
    mandatory = current;
  }

  memo.set(nodeId, mandatory);
  return mandatory;
}

/**
 * Slot ids entailed by the projected graph: every satisfying assignment of the
 * graph must satisfy these slots.
 */
export function collectConjunctivelyRequiredSlotIds(
  graph: ConstraintGraph,
): ReadonlySet<string> {
  return collectMandatorySlotIdsForNode(
    graph.rootNodeId,
    indexNodes(graph),
    new Map(),
  );
}
