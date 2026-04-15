/**
 * ADR-013 Phase 1c: BundleSelector.
 *
 * Orchestrates subquery-to-candidate assignment for multi-subquery
 * constraint graphs. Inputs:
 *   - `graph`: a `ConstraintGraph` whose subquery-node count determines K
 *   - `candidatesBySubquery`: one pool per subquery
 *   - `opts.scoreFor`: per-cell score function (higher = better)
 *   - `opts.priceFor`: per-cell price accessor (used to bind
 *     `shares_budget` edges to concrete penalties)
 *
 * Returns an `AssignmentSolution`. See ADR-013 for the carrier
 * contract.
 */

import type {
  ConstraintGraph,
  SubqueryNode,
  SharesBudgetEdge,
  BudgetResource,
} from '../../query/model/constraint-graph.js';
import type { HybridCandidate } from '../model/hybrid-candidate.js';
import {
  classifyGraphPresence,
  recordGraphPathDecision,
} from '../../../observability/graph-path-telemetry.js';
import {
  solveAssignmentExact,
  K_EXACT_LIMIT,
  type AssignmentBudgetConstraint,
  type AssignmentSolverFailReason,
} from './assignment-solver.js';
import { KRW_PER_USD_APPROXIMATE } from '../../shared/constants.js';

/** Upper bound on cost-matrix width per subquery. Online pools are
 *  already bounded by retrieval top-K (O(50-200)); 256 is generous
 *  headroom and prevents accidental DoS via an unbounded pool. */
const BUNDLE_SELECTOR_MAX_POOL = 256;

/** When a shared-budget edge is present but the graph omits an explicit
 *  ceiling, this floor is used so the penalty never grows unbounded.
 *  0 would make the whole assignment infeasible on the first cell. */
const BUDGET_CEILING_WHEN_MISSING = Number.MAX_SAFE_INTEGER;

/**
 * Per-cell scoring functor supplied by the caller. Higher is better.
 * The selector internally converts to cost = -score (ties broken by
 * solver lex rule). Returning `undefined` signals "cell unassignable"
 * — the solver pads with `UNASSIGNABLE_PENALTY`.
 */
export interface BundleCellScorer {
  (input: {
    readonly subquery: SubqueryNode;
    readonly candidate: HybridCandidate;
    readonly rowIdx: number;
    readonly colIdx: number;
  }): number | undefined;
}

/**
 * Per-cell price accessor for shared-budget edges. Returns the price
 * (in the edge's resource unit) that the candidate would consume from
 * the shared budget. Candidates without a defined price count as 0
 * against the budget.
 */
export interface BundleCellPricer {
  (input: {
    readonly subquery: SubqueryNode;
    readonly candidate: HybridCandidate;
    readonly resource: BudgetResource;
  }): number;
}

export interface BundleSelectorOptions {
  readonly scoreFor: BundleCellScorer;
  readonly priceFor: BundleCellPricer;
  /** Optional overrides for shared-budget ceilings when the graph
   *  omits an explicit value (e.g. the user said "shared budget" but
   *  the LLM did not extract a number). */
  readonly budgetCeilingOverrides?: ReadonlyMap<BudgetResource, number>;
}

export interface BundleAssignment {
  readonly subqueryId: string;
  readonly candidate: HybridCandidate;
}

export interface BundleBudgetUsage {
  readonly resource: BudgetResource;
  readonly used: number;
  readonly max: number;
}

export interface AssignmentSolution {
  readonly assignments: readonly BundleAssignment[];
  readonly bundleScore: number;
  readonly budgetUsage: readonly BundleBudgetUsage[];
  readonly degradationReasons: readonly AssignmentSolverFailReason[];
  readonly tieBreakReason: 'unique' | 'lex_smallest' | 'none';
}

export interface BundleSelector {
  chooseAssignment(
    graph: ConstraintGraph,
    candidatesBySubquery: ReadonlyMap<string, readonly HybridCandidate[]>,
    opts: BundleSelectorOptions,
  ): AssignmentSolution;
}

function resolveRowCandidate(
  candidatePools: readonly (readonly HybridCandidate[])[],
  localIndexByRowCol: readonly (readonly (number | undefined)[])[],
  rowIdx: number,
  colIdx: number,
): HybridCandidate | undefined {
  const pool = candidatePools[rowIdx];
  const localIndex = localIndexByRowCol[rowIdx]?.[colIdx];
  if (pool === undefined || localIndex === undefined) return undefined;
  return pool[localIndex];
}

function extractSubqueryNodes(graph: ConstraintGraph): readonly SubqueryNode[] {
  return graph.nodes.filter((n): n is SubqueryNode => n.kind === 'subquery');
}

function extractSharesBudgetEdges(
  graph: ConstraintGraph,
): readonly SharesBudgetEdge[] {
  return graph.edges.filter(
    (e): e is SharesBudgetEdge => e.kind === 'shares_budget',
  );
}

/**
 * Default concrete selector. Pure — no IO, no observability side-effects;
 * callers wire counters / logging above this boundary.
 */
export class BundleSelectorImpl implements BundleSelector {
  chooseAssignment(
    graph: ConstraintGraph,
    candidatesBySubquery: ReadonlyMap<string, readonly HybridCandidate[]>,
    opts: BundleSelectorOptions,
  ): AssignmentSolution {
    // Wave I2: emit unified graph-path telemetry for the bundle-selector
    // reader. `graph` is non-nullable here (the executor only calls the
    // selector with an engaged hybrid graph), so `graphPresent` is
    // unconditionally true; the origin discriminator still determines
    // which `graph_aware_*` bucket receives the increment.
    recordGraphPathDecision({
      reader: 'bundle_selector',
      outcome: classifyGraphPresence({
        graphPresent: true,
        graphOrigin: graph.origin,
        graphEmitFlagOn: process.env['CONSTRAINT_GRAPH_EMIT'] !== 'false',
      }),
    });

    const subqueries = extractSubqueryNodes(graph);
    const k = subqueries.length;

    if (k === 0) {
      return {
        assignments: [],
        bundleScore: 0,
        budgetUsage: [],
        degradationReasons: [],
        tieBreakReason: 'none',
      };
    }

    if (k > K_EXACT_LIMIT) {
      return {
        assignments: [],
        bundleScore: 0,
        budgetUsage: [],
        degradationReasons: ['bundle_selector_fail_closed:k_exceeds_exact_limit'],
        tieBreakReason: 'none',
      };
    }

    // Build a shared candidate column space keyed by entityId. This
    // preserves the Hungarian distinct-column rule's correctness: a
    // single wine cannot fill two slots, but two different wines that
    // happen to share an index within their respective per-row pools
    // are independent picks.
    const candidatePools: readonly HybridCandidate[][] = subqueries.map((sq) => {
      const pool = candidatesBySubquery.get(sq.nodeId) ?? [];
      // Bound the pool size so the K! enumeration stays predictable.
      return pool.slice(0, BUNDLE_SELECTOR_MAX_POOL);
    });

    // Empty-slot shortcut: any subquery with zero candidates => fail closed.
    for (let r = 0; r < k; r += 1) {
      const pool = candidatePools[r];
      if (pool === undefined || pool.length === 0) {
        return {
          assignments: [],
          bundleScore: 0,
          budgetUsage: [],
          degradationReasons: ['bundle_selector_fail_closed:empty_slot_pool'],
          tieBreakReason: 'none',
        };
      }
    }

    // Unify pools into a shared candidate space indexed by entityId.
    // `sharedColumns[idx]` = candidate at that shared column.
    const columnIndexByEntity = new Map<string, number>();
    const sharedColumns: string[] = [];
    for (const pool of candidatePools) {
      for (const candidate of pool) {
        const key = String(candidate.entityId);
        if (!columnIndexByEntity.has(key)) {
          columnIndexByEntity.set(key, sharedColumns.length);
          sharedColumns.push(key);
        }
      }
    }

    // Track, per (row, sharedCol), the per-row local index so we can
    // resolve assignments back to the correct pool entry after the
    // solver returns. `undefined` means the candidate is not in that
    // row's pool (encoded as UNASSIGNABLE in the cost matrix).
    const localIndexByRowCol: (number | undefined)[][] = [];
    const costMatrix: number[][] = [];

    for (let r = 0; r < k; r += 1) {
      const subquery = subqueries[r];
      const pool = candidatePools[r];
      if (subquery === undefined || pool === undefined) continue;

      const perRowLocal: (number | undefined)[] = [];
      const row: number[] = [];

      // For the row's own pool members, compute the cost. For shared
      // columns that this row cannot fill, cost is POSITIVE_INFINITY
      // (solver treats as UNASSIGNABLE).
      const localIndexByEntity = new Map<string, number>();
      for (let c = 0; c < pool.length; c += 1) {
        const cand = pool[c];
        if (cand !== undefined) localIndexByEntity.set(String(cand.entityId), c);
      }

      for (let col = 0; col < sharedColumns.length; col += 1) {
        const entityKey = sharedColumns[col];
        if (entityKey === undefined) {
          perRowLocal.push(undefined);
          row.push(Number.POSITIVE_INFINITY);
          continue;
        }
        const localIdx = localIndexByEntity.get(entityKey);
        if (localIdx === undefined) {
          perRowLocal.push(undefined);
          row.push(Number.POSITIVE_INFINITY);
          continue;
        }
        const candidate = pool[localIdx];
        if (candidate === undefined) {
          perRowLocal.push(undefined);
          row.push(Number.POSITIVE_INFINITY);
          continue;
        }
        const score = opts.scoreFor({
          subquery,
          candidate,
          rowIdx: r,
          colIdx: localIdx,
        });
        perRowLocal.push(localIdx);
        row.push(
          typeof score === 'number' && Number.isFinite(score)
            ? -score
            : Number.POSITIVE_INFINITY,
        );
      }

      costMatrix.push(row);
      localIndexByRowCol.push(perRowLocal);
    }

    // Build shared-budget constraints (by-resource aggregation over all edges).
    const sharesBudgetEdges = extractSharesBudgetEdges(graph);
    const budgetConstraints: AssignmentBudgetConstraint[] = [];

    if (sharesBudgetEdges.length > 0) {
      // Group by resource: all rows mentioned across all edges for that
      // resource share the same ceiling. In practice a graph has at
      // most one ceiling per resource; this aggregation is defensive.
      const byResource = new Map<BudgetResource, Set<string>>();
      for (const edge of sharesBudgetEdges) {
        const bucket = byResource.get(edge.resource) ?? new Set<string>();
        bucket.add(edge.from);
        bucket.add(edge.to);
        byResource.set(edge.resource, bucket);
      }
      for (const [resource, nodeIds] of byResource.entries()) {
        const rows: number[] = [];
        for (let r = 0; r < k; r += 1) {
          const subquery = subqueries[r];
          if (subquery === undefined) continue;
          if (nodeIds.has(subquery.nodeId)) rows.push(r);
        }
        if (rows.length === 0) continue;
        const ceiling = resolveBudgetCeiling(graph, resource, opts);
        budgetConstraints.push({
          label: `shares_budget:${resource}`,
          rows,
          cellCost: (rowIdx, colIdx) => {
            const subquery = subqueries[rowIdx];
            if (subquery === undefined) return 0;
            const candidate = resolveRowCandidate(
              candidatePools,
              localIndexByRowCol,
              rowIdx,
              colIdx,
            );
            if (candidate === undefined) return 0;
            return opts.priceFor({ subquery, candidate, resource });
          },
          ceiling,
        });
      }
    }

    const solverResult = solveAssignmentExact({
      costMatrix,
      ...(budgetConstraints.length > 0 ? { budgetConstraints } : {}),
    });

    if (!solverResult.solved) {
      return {
        assignments: [],
        bundleScore: 0,
        budgetUsage: [],
        degradationReasons: [solverResult.reason],
        tieBreakReason: 'none',
      };
    }

    const assignments: BundleAssignment[] = [];
    for (let r = 0; r < k; r += 1) {
      const subquery = subqueries[r];
      const col = solverResult.assignedColumns[r];
      if (subquery === undefined || col === undefined) continue;
      const candidate = resolveRowCandidate(
        candidatePools,
        localIndexByRowCol,
        r,
        col,
      );
      if (candidate === undefined) continue;
      assignments.push({ subqueryId: subquery.nodeId, candidate });
    }

    // Bundle score = sum of picked scores (undo cost inversion). The
    // penalty paid is always 0 on success, so we report totalCost
    // directly.
    const bundleScore = -solverResult.totalCost;

    const budgetUsage: BundleBudgetUsage[] = [];
    for (const constraint of budgetConstraints) {
      let used = 0;
      for (const rowIdx of constraint.rows) {
        const col = solverResult.assignedColumns[rowIdx];
        if (col === undefined) continue;
        used += constraint.cellCost(rowIdx, col);
      }
      const resourceMatch = /^shares_budget:(.+)$/.exec(constraint.label);
      const resource = (resourceMatch?.[1] ?? 'price_total') as BudgetResource;
      budgetUsage.push({ resource, used, max: constraint.ceiling });
    }

    return {
      assignments,
      bundleScore,
      budgetUsage,
      degradationReasons: [],
      tieBreakReason: solverResult.tieBreakReason,
    };
  }
}

function resolveBudgetCeiling(
  graph: ConstraintGraph,
  resource: BudgetResource,
  opts: BundleSelectorOptions,
): number {
  const override = opts.budgetCeilingOverrides?.get(resource);
  if (typeof override === 'number' && Number.isFinite(override) && override >= 0) {
    return override;
  }
  if (resource === 'price_total') {
    const price = graph.globalBudgets.priceTotal;
    if (
      price !== undefined
      && typeof price.max === 'number'
      && Number.isFinite(price.max)
      && price.max >= 0
    ) {
      return price.currency === 'KRW'
        ? price.max
        : Math.round(price.max * KRW_PER_USD_APPROXIMATE);
    }
  }
  if (resource === 'count') {
    const count = graph.globalBudgets.candidateCount;
    if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
      return count;
    }
  }
  if (resource === 'time') {
    const walltime = graph.globalBudgets.walltime;
    if (typeof walltime === 'number' && Number.isFinite(walltime) && walltime >= 0) {
      return walltime;
    }
  }
  return BUDGET_CEILING_WHEN_MISSING;
}
