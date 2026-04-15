/**
 * ADR-013 Phase 1c: BundleSelector shared-budget semantics.
 *
 * Append-only test. Locks:
 *   1. Trivial graph (no subqueries) → empty assignment, no degradation.
 *   2. Hybrid multi-subquery without shared budget → picks per-slot optimum.
 *   3. shares_budget edge honoured — forces the cheaper feasible pair.
 *   4. Pure tie-break determinism at the selector level.
 *   5. BundleRankedResult.computeBundleId deterministic for the same slot set.
 *
 * Never delete this file.
 */
import { describe, expect, it } from 'vitest';
import {
  BundleSelectorImpl,
  type BundleSelectorOptions,
} from '../../src/domain/retrieval/service/bundle-selector.js';
import { computeBundleId } from '../../src/domain/response/model/bundle-ranked-result.js';
import type {
  ConstraintGraph,
  SubqueryNode,
} from '../../src/domain/query/model/constraint-graph.js';
import type { HybridCandidate } from '../../src/domain/retrieval/model/hybrid-candidate.js';

function mkCandidate(id: string, price: number, score: number): HybridCandidate & {
  readonly price: number;
  readonly score: number;
} {
  return {
    entityId: id as never,
    retrievalTraces: [],
    price,
    score,
  } as unknown as HybridCandidate & { readonly price: number; readonly score: number };
}

function mkHybridGraph(subqueryIds: readonly string[], sharedBudget?: {
  readonly rows: readonly [string, string];
  readonly max?: number;
}): ConstraintGraph {
  const subqueries: SubqueryNode[] = subqueryIds.map((id) => ({
    kind: 'subquery',
    nodeId: id,
    purpose: id,
    targetCardinality: 1,
  }));
  return {
    graphSchemaVersion: 'constraint_graph_v1.1',
    origin: 'hybrid',
    rootNodeId: 'root',
    nodes: [
      { kind: 'group_and', nodeId: 'root', children: subqueryIds },
      ...subqueries,
    ],
    edges: sharedBudget !== undefined
      ? [
          {
            kind: 'shares_budget',
            from: sharedBudget.rows[0],
            to: sharedBudget.rows[1],
            resource: 'price_total',
          },
        ]
      : [],
    globalBudgets: sharedBudget?.max !== undefined
      ? { priceTotal: { currency: 'KRW', max: sharedBudget.max } }
      : {},
  };
}

const priceLookup = new Map<string, number>();
const scoreLookup = new Map<string, number>();

const mkOpts = (): BundleSelectorOptions => ({
  scoreFor: ({ candidate }) => scoreLookup.get(String(candidate.entityId)) ?? 0,
  priceFor: ({ candidate }) => priceLookup.get(String(candidate.entityId)) ?? 0,
});

describe('BundleSelector shared-budget semantics (ADR-013)', () => {
  it('empty subquery set → empty assignment, no degradation', () => {
    const selector = new BundleSelectorImpl();
    const graph: ConstraintGraph = {
      graphSchemaVersion: 'constraint_graph_v1',
      origin: 'deterministic_from_atoms',
      rootNodeId: 'root',
      nodes: [{ kind: 'group_and', nodeId: 'root', children: [] }],
      edges: [],
      globalBudgets: {},
    };
    const r = selector.chooseAssignment(graph, new Map(), mkOpts());
    expect(r.assignments).toEqual([]);
    expect(r.degradationReasons).toEqual([]);
  });

  it('multi-subquery without shared budget picks the per-slot optimum', () => {
    scoreLookup.clear();
    priceLookup.clear();
    scoreLookup.set('appetiser:a1', 0.9);
    scoreLookup.set('appetiser:a2', 0.3);
    scoreLookup.set('main:m1', 0.95);
    scoreLookup.set('main:m2', 0.4);
    const selector = new BundleSelectorImpl();
    const graph = mkHybridGraph(['appetiser', 'main']);
    const pools = new Map<string, readonly HybridCandidate[]>([
      ['appetiser', [mkCandidate('appetiser:a1', 0, 0.9), mkCandidate('appetiser:a2', 0, 0.3)]],
      ['main', [mkCandidate('main:m1', 0, 0.95), mkCandidate('main:m2', 0, 0.4)]],
    ]);
    const r = selector.chooseAssignment(graph, pools, mkOpts());
    expect(r.assignments.map((a) => String(a.candidate.entityId))).toEqual([
      'appetiser:a1',
      'main:m1',
    ]);
    expect(r.degradationReasons).toEqual([]);
  });

  it('shares_budget edge forces a feasible pair under the ceiling', () => {
    scoreLookup.clear();
    priceLookup.clear();
    // Preferred pair (a1, m1) is expensive (total 200k > 120k ceiling)
    // — infeasible. All other distinct pairs are feasible and tied in
    // score; lex-smallest tie-break picks (a1, m2).
    scoreLookup.set('a1', 0.9);
    scoreLookup.set('a2', 0.5);
    scoreLookup.set('m1', 0.9);
    scoreLookup.set('m2', 0.5);
    priceLookup.set('a1', 100_000);
    priceLookup.set('a2', 50_000);
    priceLookup.set('m1', 100_000);
    priceLookup.set('m2', 50_000);
    const selector = new BundleSelectorImpl();
    const graph = mkHybridGraph(['appetiser', 'main'], {
      rows: ['appetiser', 'main'],
      max: 120_000,
    });
    const pools = new Map<string, readonly HybridCandidate[]>([
      ['appetiser', [mkCandidate('a1', 100_000, 0.9), mkCandidate('a2', 50_000, 0.5)]],
      ['main', [mkCandidate('m1', 100_000, 0.9), mkCandidate('m2', 50_000, 0.5)]],
    ]);
    const r = selector.chooseAssignment(graph, pools, mkOpts());
    expect(r.degradationReasons).toEqual([]);
    // Feasible perms under 120k: (a1,m2)=150k INFEASIBLE,
    //   (a2,m1)=150k INFEASIBLE, (a2,m2)=100k FEASIBLE.
    // Only (a2,m2) stays under the ceiling.
    expect(r.assignments.map((a) => String(a.candidate.entityId))).toEqual(['a2', 'm2']);
    expect(r.budgetUsage).toHaveLength(1);
    expect(r.budgetUsage[0]?.used).toBe(100_000);
    expect(r.budgetUsage[0]?.max).toBe(120_000);
  });

  it('shares_budget infeasible → fail-closed with budget_infeasible', () => {
    scoreLookup.clear();
    priceLookup.clear();
    scoreLookup.set('a1', 0.9);
    scoreLookup.set('m1', 0.9);
    priceLookup.set('a1', 500_000);
    priceLookup.set('m1', 500_000);
    const selector = new BundleSelectorImpl();
    const graph = mkHybridGraph(['appetiser', 'main'], {
      rows: ['appetiser', 'main'],
      max: 150_000,
    });
    const pools = new Map<string, readonly HybridCandidate[]>([
      ['appetiser', [mkCandidate('a1', 500_000, 0.9)]],
      ['main', [mkCandidate('m1', 500_000, 0.9)]],
    ]);
    const r = selector.chooseAssignment(graph, pools, mkOpts());
    expect(r.assignments).toEqual([]);
    expect(r.degradationReasons).toEqual([
      'bundle_selector_fail_closed:budget_infeasible',
    ]);
  });

  it('preserves row-local candidate scoring when the same entity appears in multiple slot pools', () => {
    scoreLookup.clear();
    priceLookup.clear();
    scoreLookup.set('row1:shared', 0.1);
    scoreLookup.set('row1:other', 0.9);
    scoreLookup.set('row2:shared', 0.95);
    scoreLookup.set('row2:other', 0.2);
    const selector = new BundleSelectorImpl();
    const graph = mkHybridGraph(['row1', 'row2']);
    const pools = new Map<string, readonly HybridCandidate[]>([
      ['row1', [
        mkCandidate('shared', 0, 0) as HybridCandidate & { readonly scoreKey?: string },
        mkCandidate('other', 0, 0) as HybridCandidate & { readonly scoreKey?: string },
      ]],
      ['row2', [
        mkCandidate('shared', 0, 0) as HybridCandidate & { readonly scoreKey?: string },
        mkCandidate('other', 0, 0) as HybridCandidate & { readonly scoreKey?: string },
      ]],
    ]);
    const opts: BundleSelectorOptions = {
      scoreFor: ({ subquery, candidate }) => {
        return scoreLookup.get(`${subquery.nodeId}:${String(candidate.entityId)}`) ?? 0;
      },
      priceFor: ({ candidate }) => priceLookup.get(String(candidate.entityId)) ?? 0,
    };

    const r = selector.chooseAssignment(graph, pools, opts);

    expect(r.degradationReasons).toEqual([]);
    expect(r.assignments.map((a) => `${a.subqueryId}:${String(a.candidate.entityId)}`)).toEqual([
      'row1:other',
      'row2:shared',
    ]);
  });

  it('computeBundleId is deterministic and order-independent', () => {
    const id1 = computeBundleId(['main', 'appetiser', 'dessert']);
    const id2 = computeBundleId(['dessert', 'main', 'appetiser']);
    const id3 = computeBundleId(['appetiser', 'dessert', 'main']);
    expect(id1).toBe(id2);
    expect(id2).toBe(id3);
    expect(id1).toBe('bundle:appetiser|dessert|main');
  });
});
