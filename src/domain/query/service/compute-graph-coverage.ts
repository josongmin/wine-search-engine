/**
 * ADR-011 Phase 1b.1: Graph-aware coverage with AND / OR / XOR semantics.
 *
 * Pure function — no I/O, deterministic for identical input.
 *
 * Given a ConstraintGraph and the set of attributes the retrieval pipeline
 * reports as satisfied, compute:
 *  - which *slot nodes* are matched (attribute ∈ satisfiedAttributes)
 *  - which *slot nodes* are required but unmet, under group semantics:
 *      group_and → every child must be satisfied
 *      group_or  → at least one child must be satisfied
 *      group_xor → exactly one child must be satisfied
 *  - the flat `matchedAttributes` / `unmetAttributes` strings downstream
 *    consumers (provenance-closure response shape) still need.
 *  - `coverageRatio` on required slot nodes.
 *  - `rootSatisfied` — whether the root group aggregates to "satisfied".
 *
 * Phase 1b.1 scope: node-kind only. Edges (`shares_budget`, `complements`,
 * `depends_on`) are ignored and folded in by Phase 1b.2.
 */

import type {
  BudgetResource,
  ConstraintGraph,
  ConstraintGraphNode,
  GroupAndNode,
  GroupOrNode,
  GroupXorNode,
  SlotNode,
} from '../model/constraint-graph.js';

export interface GraphCoverageResult {
  /** Flat, unique attribute names from satisfied slot nodes. */
  readonly matchedAttributes: readonly string[];
  /** Flat, unique attribute names from required-but-unmet slot nodes. */
  readonly unmetAttributes: readonly string[];
  /** Slot node IDs matched under group semantics. */
  readonly matchedNodeIds: readonly string[];
  /** Slot node IDs required but unmet under group semantics. */
  readonly unmetNodeIds: readonly string[];
  /**
   * Share of *required* slot nodes that are satisfied.
   *
   * Denominator = matchedNodeIds + unmetNodeIds (the slots that count toward
   * coverage under the current group structure — an OR/XOR group only
   * surfaces the slots needed to satisfy it).
   *
   * Returns 1 for an empty graph (no requirements → trivially covered).
   */
  readonly coverageRatio: number;
  /** Whether the root group is satisfied under its own kind's semantics. */
  readonly rootSatisfied: boolean;
}

export interface GraphCoverageSignals {
  /** Legacy flat attribute-satisfaction surface. */
  readonly satisfiedAttributes: ReadonlySet<string>;
  /**
   * Optional precise node-level satisfaction. When present, slot and
   * subquery nodes prefer this set over attribute-name fallback.
   */
  readonly satisfiedNodeIds?: ReadonlySet<string> | undefined;
  /**
   * Optional budget resources that are known satisfied for this
   * execution. Used to validate `shares_budget` edges after node
   * aggregation succeeds.
   */
  readonly satisfiedBudgetResources?: ReadonlySet<BudgetResource> | undefined;
}

function isGraphCoverageSignals(
  candidate: ReadonlySet<string> | GraphCoverageSignals,
): candidate is GraphCoverageSignals {
  return (
    typeof candidate === 'object'
    && 'satisfiedAttributes' in candidate
  );
}

function indexNodes(
  graph: ConstraintGraph,
): ReadonlyMap<string, ConstraintGraphNode> {
  const byId = new Map<string, ConstraintGraphNode>();
  for (const node of graph.nodes) byId.set(node.nodeId, node);
  return byId;
}

/** Attribute match is the unit primitive — caller supplies the satisfied set. */
function isSlotSatisfied(
  slot: SlotNode,
  signals: GraphCoverageSignals,
): boolean {
  return (
    signals.satisfiedNodeIds?.has(slot.nodeId) === true
    || signals.satisfiedAttributes.has(slot.attribute)
  );
}

function isSubquerySatisfied(
  nodeId: string,
  signals: GraphCoverageSignals,
): boolean {
  return signals.satisfiedNodeIds?.has(nodeId) === true;
}

interface EvalResult {
  /** Did this subtree aggregate to "satisfied"? */
  readonly satisfied: boolean;
  /** Slot IDs matched under this subtree's contribution to coverage. */
  readonly matched: readonly string[];
  /** Slot IDs required-but-unmet under this subtree's contribution. */
  readonly unmet: readonly string[];
}

function evaluateNode(
  node: ConstraintGraphNode,
  nodesById: ReadonlyMap<string, ConstraintGraphNode>,
  signals: GraphCoverageSignals,
): EvalResult {
  switch (node.kind) {
    case 'slot': {
      const ok = isSlotSatisfied(node, signals);
      return {
        satisfied: ok,
        matched: ok ? [node.nodeId] : [],
        unmet: ok ? [] : [node.nodeId],
      };
    }
    case 'subquery':
      return {
        satisfied: isSubquerySatisfied(node.nodeId, signals),
        matched: [],
        unmet: [],
      };
    case 'group_and':
      return evaluateAnd(node, nodesById, signals);
    case 'group_or':
      return evaluateOr(node, nodesById, signals);
    case 'group_xor':
      return evaluateXor(node, nodesById, signals);
  }
}

function evaluateChildren(
  group: GroupAndNode | GroupOrNode | GroupXorNode,
  nodesById: ReadonlyMap<string, ConstraintGraphNode>,
  signals: GraphCoverageSignals,
): readonly EvalResult[] {
  const out: EvalResult[] = [];
  for (const childId of group.children) {
    const child = nodesById.get(childId);
    if (child === undefined) continue; // dangling references are silently skipped
    out.push(evaluateNode(child, nodesById, signals));
  }
  return out;
}

function evaluateAnd(
  group: GroupAndNode,
  nodesById: ReadonlyMap<string, ConstraintGraphNode>,
  signals: GraphCoverageSignals,
): EvalResult {
  const children = evaluateChildren(group, nodesById, signals);
  // AND: every child contributes to matched/unmet. Satisfied iff every child satisfied.
  const matched: string[] = [];
  const unmet: string[] = [];
  let allOk = true;
  for (const c of children) {
    matched.push(...c.matched);
    unmet.push(...c.unmet);
    if (!c.satisfied) allOk = false;
  }
  // Vacuously true for an empty AND (matches classical logic).
  const satisfied = children.length === 0 ? true : allOk;
  return { satisfied, matched, unmet };
}

function evaluateOr(
  group: GroupOrNode,
  nodesById: ReadonlyMap<string, ConstraintGraphNode>,
  signals: GraphCoverageSignals,
): EvalResult {
  const children = evaluateChildren(group, nodesById, signals);
  // OR: at least one child satisfied → group satisfied.
  //   - If any child is satisfied, only its matched slots count; other children
  //     (matched or not) do not add to unmet.
  //   - If none satisfied, every child's unmet slots surface so the caller
  //     sees what's missing.
  const anySat = children.find((c) => c.satisfied);
  if (anySat !== undefined) {
    return { satisfied: true, matched: [...anySat.matched], unmet: [] };
  }
  const matched: string[] = [];
  const unmet: string[] = [];
  for (const c of children) {
    matched.push(...c.matched);
    unmet.push(...c.unmet);
  }
  // Vacuously false for an empty OR — there is no child to satisfy it.
  const satisfied = children.length === 0 ? false : false;
  return { satisfied, matched, unmet };
}

function evaluateXor(
  group: GroupXorNode,
  nodesById: ReadonlyMap<string, ConstraintGraphNode>,
  signals: GraphCoverageSignals,
): EvalResult {
  const children = evaluateChildren(group, nodesById, signals);
  // XOR: exactly one satisfied. "Too many" matches is a group failure —
  // the user's disjunction picked more than one mutually exclusive option.
  const satisfiedChildren = children.filter((c) => c.satisfied);
  if (satisfiedChildren.length === 1) {
    const only = satisfiedChildren[0]!;
    return { satisfied: true, matched: [...only.matched], unmet: [] };
  }
  const matched: string[] = [];
  const unmet: string[] = [];
  for (const c of children) {
    matched.push(...c.matched);
    unmet.push(...c.unmet);
  }
  return { satisfied: false, matched, unmet };
}

function uniqueAttributesFromSlots(
  nodeIds: readonly string[],
  nodesById: ReadonlyMap<string, ConstraintGraphNode>,
): readonly string[] {
  const seen = new Set<string>();
  for (const id of nodeIds) {
    const node = nodesById.get(id);
    if (node?.kind === 'slot') seen.add(node.attribute);
  }
  return [...seen];
}

export function computeGraphCoverage(
  graph: ConstraintGraph,
  satisfied:
    | ReadonlySet<string>
    | GraphCoverageSignals,
): GraphCoverageResult {
  const signals = isGraphCoverageSignals(satisfied)
    ? satisfied
    : { satisfiedAttributes: satisfied };
  const nodesById = indexNodes(graph);
  const root = nodesById.get(graph.rootNodeId);
  if (root === undefined) {
    // Malformed graph — treat as empty. Schema validation should prevent this.
    return {
      matchedAttributes: [],
      unmetAttributes: [],
      matchedNodeIds: [],
      unmetNodeIds: [],
      coverageRatio: 1,
      rootSatisfied: true,
    };
  }
  const rootEval = evaluateNode(root, nodesById, signals);
  const matchedNodeIds = rootEval.matched;
  const unmetNodeIds = rootEval.unmet;
  const denom = matchedNodeIds.length + unmetNodeIds.length;
  const coverageRatio = denom === 0 ? 1 : matchedNodeIds.length / denom;
  let rootSatisfied = rootEval.satisfied;

  if (rootSatisfied && graph.edges.length > 0) {
    for (const edge of graph.edges) {
      if (edge.kind !== 'shares_budget') continue;
      const fromSatisfied = signals.satisfiedNodeIds?.has(edge.from) === true;
      const toSatisfied = signals.satisfiedNodeIds?.has(edge.to) === true;
      if (!fromSatisfied || !toSatisfied) continue;
      if (signals.satisfiedBudgetResources?.has(edge.resource) === true) continue;
      rootSatisfied = false;
      break;
    }
  }

  return {
    matchedAttributes: uniqueAttributesFromSlots(matchedNodeIds, nodesById),
    unmetAttributes: uniqueAttributesFromSlots(unmetNodeIds, nodesById),
    matchedNodeIds,
    unmetNodeIds,
    coverageRatio,
    rootSatisfied,
  };
}
