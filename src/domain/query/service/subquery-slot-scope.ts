/**
 * ADR-013 Phase 1c: exact subquery slot applicability extraction.
 *
 * The graph model does not attach slots directly to a `subquery` node.
 * Instead, scope is expressed structurally by ancestor groups. For each
 * slot we compute the *minimal descendant-subquery set* among the groups
 * on the root→slot path. That minimal set is the slot's exact
 * applicability set:
 *
 *   - `{sq_a}`   → exclusive to subquery A
 *   - `{sq_a,b}` → shared across subqueries A and B
 *
 * This is purely structural and deterministic — no purpose-label or
 * fallback heuristics.
 */

import type {
  ConstraintGraph,
  ConstraintGraphNode,
} from '../model/constraint-graph.js';

interface Descendants {
  readonly slotIds: ReadonlySet<string>;
  readonly subqueryIds: ReadonlySet<string>;
}

function indexNodes(graph: ConstraintGraph): ReadonlyMap<string, ConstraintGraphNode> {
  const out = new Map<string, ConstraintGraphNode>();
  for (const node of graph.nodes) out.set(node.nodeId, node);
  return out;
}

function cloneSet(values: ReadonlySet<string>): ReadonlySet<string> {
  return new Set(values);
}

function unionSets(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): ReadonlySet<string> {
  const out = new Set<string>(left);
  for (const value of right) out.add(value);
  return out;
}

function collectDescendants(
  nodeId: string,
  byId: ReadonlyMap<string, ConstraintGraphNode>,
  memo: Map<string, Descendants>,
): Descendants {
  const cached = memo.get(nodeId);
  if (cached !== undefined) return cached;

  const node = byId.get(nodeId);
  if (node === undefined) {
    const empty = { slotIds: new Set<string>(), subqueryIds: new Set<string>() };
    memo.set(nodeId, empty);
    return empty;
  }

  if (node.kind === 'slot') {
    const onlySlot = {
      slotIds: new Set([node.nodeId]),
      subqueryIds: new Set<string>(),
    };
    memo.set(nodeId, onlySlot);
    return onlySlot;
  }

  if (node.kind === 'subquery') {
    const onlySubquery = {
      slotIds: new Set<string>(),
      subqueryIds: new Set([node.nodeId]),
    };
    memo.set(nodeId, onlySubquery);
    return onlySubquery;
  }

  const slotIds = new Set<string>();
  const subqueryIds = new Set<string>();
  for (const childId of node.children) {
    const child = collectDescendants(childId, byId, memo);
    for (const slotId of child.slotIds) slotIds.add(slotId);
    for (const subqueryId of child.subqueryIds) subqueryIds.add(subqueryId);
  }
  const result = { slotIds, subqueryIds };
  memo.set(nodeId, result);
  return result;
}

function collectSlotApplicability(
  graph: ConstraintGraph,
): ReadonlyMap<string, ReadonlySet<string>> {
  const byId = indexNodes(graph);
  const memo = new Map<string, Descendants>();
  const out = new Map<string, ReadonlySet<string>>();

  function visit(
    nodeId: string,
    narrowestScope: ReadonlySet<string> | undefined,
  ): void {
    const node = byId.get(nodeId);
    if (node === undefined) return;

    if (node.kind === 'slot') {
      const nextScope = narrowestScope !== undefined
        ? cloneSet(narrowestScope)
        : new Set<string>();
      const previous = out.get(node.nodeId);
      out.set(
        node.nodeId,
        previous !== undefined ? unionSets(previous, nextScope) : nextScope,
      );
      return;
    }

    if (node.kind === 'subquery') return;

    const descendants = collectDescendants(node.nodeId, byId, memo);
    const nextScope = descendants.subqueryIds.size > 0
      && (
        narrowestScope === undefined
        || descendants.subqueryIds.size < narrowestScope.size
      )
      ? descendants.subqueryIds
      : narrowestScope;

    for (const childId of node.children) {
      visit(childId, nextScope);
    }
  }

  visit(graph.rootNodeId, undefined);
  return out;
}

/**
 * Returns the slot ids whose minimal structural scope contains the given
 * subquery. This includes both exclusive slots and shared/global slots
 * that govern multiple subqueries.
 */
export function collectApplicableSlotIdsForSubquery(
  graph: ConstraintGraph,
  subqueryId: string,
): ReadonlySet<string> {
  const applicable = new Set<string>();
  for (const [slotId, scope] of collectSlotApplicability(graph).entries()) {
    if (scope.has(subqueryId)) applicable.add(slotId);
  }
  return applicable;
}
