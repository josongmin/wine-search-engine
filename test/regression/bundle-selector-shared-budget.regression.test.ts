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
import { createEntityId } from '../../src/domain/shared/types/index.js';
import { makeHybridCandidate } from '../support/hybrid-candidate-test-factory.js';

function mkCandidate(id: string, price: number, score: number): HybridCandidate & {
  readonly price: number;
  readonly score: number;
} {
  return {
    ...makeHybridCandidate({
      entityId: createEntityId(id),
    }),
    price,
    score,
  };
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

function mkHybridGraphWithSubqueries(
  subqueries: readonly {
    readonly nodeId: string;
    readonly purpose?: string;
    readonly obligation?: SubqueryNode['obligation'];
  }[],
  sharedBudget?: {
    readonly rows: readonly [string, string];
    readonly max?: number;
  },
): ConstraintGraph {
  return {
    graphSchemaVersion: 'constraint_graph_v1.1',
    origin: 'hybrid',
    rootNodeId: 'root',
    nodes: [
      { kind: 'group_and', nodeId: 'root', children: subqueries.map((s) => s.nodeId) },
      ...subqueries.map((subquery) => ({
        kind: 'subquery' as const,
        nodeId: subquery.nodeId,
        purpose: subquery.purpose ?? subquery.nodeId,
        targetCardinality: 1,
        ...(subquery.obligation !== undefined ? { obligation: subquery.obligation } : {}),
      })),
    ],
    edges: sharedBudget !== undefined
      ? [
          {
            kind: 'shares_budget' as const,
            from: sharedBudget.rows[0],
            to: sharedBudget.rows[1],
            resource: 'price_total' as const,
          },
        ]
      : [],
    globalBudgets: sharedBudget?.max !== undefined
      ? { priceTotal: { currency: 'KRW' as const, max: sharedBudget.max } }
      : {},
  };
}

function mkHybridGraphWithOptional(
  subqueries: readonly Array<{ readonly id: string; readonly obligation?: 'required' | 'optional' }>,
): ConstraintGraph {
  const nodes: SubqueryNode[] = subqueries.map(({ id, obligation }) => ({
    kind: 'subquery',
    nodeId: id,
    purpose: id,
    targetCardinality: 1,
    ...(obligation !== undefined ? { obligation } : {}),
  }));
  return {
    graphSchemaVersion: 'constraint_graph_v1.1',
    origin: 'hybrid',
    rootNodeId: 'root',
    nodes: [
      { kind: 'group_and', nodeId: 'root', children: subqueries.map((sq) => sq.id) },
      ...nodes,
    ],
    edges: [],
    globalBudgets: {},
  };
}

function mkHybridGraphWithTopology(
  nodes: ConstraintGraph['nodes'],
  rootNodeId = 'root',
): ConstraintGraph {
  return {
    graphSchemaVersion: 'constraint_graph_v1.1',
    origin: 'hybrid',
    rootNodeId,
    nodes,
    edges: [],
    globalBudgets: {},
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

  it('prunes an optional empty row instead of fail-closing the surviving required bundle', () => {
    scoreLookup.clear();
    priceLookup.clear();
    scoreLookup.set('main:m1', 0.95);
    scoreLookup.set('main:m2', 0.5);
    const selector = new BundleSelectorImpl();
    const graph = mkHybridGraphWithSubqueries([
      { nodeId: 'main', obligation: 'required' },
      { nodeId: 'dessert', obligation: 'optional' },
    ]);
    const pools = new Map<string, readonly HybridCandidate[]>([
      ['main', [mkCandidate('main:m1', 0, 0.95), mkCandidate('main:m2', 0, 0.5)]],
      ['dessert', []],
    ]);

    const r = selector.chooseAssignment(graph, pools, mkOpts());

    expect(r.assignments.map((assignment) => assignment.subqueryId)).toEqual(['main']);
    expect(r.assignments.map((assignment) => String(assignment.candidate.entityId))).toEqual([
      'main:m1',
    ]);
    expect(r.degradationReasons).not.toContain('bundle_selector_fail_closed:empty_slot_pool');
    expect(r.degradationReasons).not.toContain('bundle_selector_fail_closed:budget_infeasible');
    expect(r.degradationReasons).not.toContain('bundle_selector_fail_closed:k_exceeds_exact_limit');
  });

  it('prunes optional rows before exact-limit gating so five required rows still solve', () => {
    scoreLookup.clear();
    priceLookup.clear();
    const selector = new BundleSelectorImpl();
    const graph = mkHybridGraphWithSubqueries([
      { nodeId: 'course-1', obligation: 'required' },
      { nodeId: 'course-2', obligation: 'required' },
      { nodeId: 'course-3', obligation: 'required' },
      { nodeId: 'course-4', obligation: 'required' },
      { nodeId: 'course-5', obligation: 'required' },
      { nodeId: 'optional-dessert', obligation: 'optional' },
    ]);
    const pools = new Map<string, readonly HybridCandidate[]>([
      ['course-1', [mkCandidate('course-1:best', 0, 0.91)]],
      ['course-2', [mkCandidate('course-2:best', 0, 0.92)]],
      ['course-3', [mkCandidate('course-3:best', 0, 0.93)]],
      ['course-4', [mkCandidate('course-4:best', 0, 0.94)]],
      ['course-5', [mkCandidate('course-5:best', 0, 0.95)]],
      ['optional-dessert', []],
    ]);

    const r = selector.chooseAssignment(graph, pools, mkOpts());

    expect(r.assignments.map((assignment) => assignment.subqueryId)).toEqual([
      'course-1',
      'course-2',
      'course-3',
      'course-4',
      'course-5',
    ]);
    expect(r.assignments.map((assignment) => String(assignment.candidate.entityId))).toEqual([
      'course-1:best',
      'course-2:best',
      'course-3:best',
      'course-4:best',
      'course-5:best',
    ]);
    expect(r.degradationReasons).not.toContain('bundle_selector_fail_closed:k_exceeds_exact_limit');
    expect(r.degradationReasons).not.toContain('bundle_selector_fail_closed:empty_slot_pool');
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
        mkCandidate('shared', 0, 0),
        mkCandidate('other', 0, 0),
      ]],
      ['row2', [
        mkCandidate('shared', 0, 0),
        mkCandidate('other', 0, 0),
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

  it('prunes optional empty subquery pools instead of fail-closing empty_slot_pool', () => {
    scoreLookup.clear();
    priceLookup.clear();
    scoreLookup.set('required:w1', 0.9);
    const selector = new BundleSelectorImpl();
    const graph = mkHybridGraphWithOptional([
      { id: 'required', obligation: 'required' },
      { id: 'optional', obligation: 'optional' },
    ]);
    const pools = new Map<string, readonly HybridCandidate[]>([
      ['required', [mkCandidate('required:w1', 0, 0.9)]],
      ['optional', []],
    ]);

    const r = selector.chooseAssignment(graph, pools, mkOpts());

    expect(r.degradationReasons).toEqual([]);
    expect(r.assignments.map((a) => `${a.subqueryId}:${String(a.candidate.entityId)}`)).toEqual([
      'required:required:w1',
    ]);
  });

  it('applies K_EXACT_LIMIT after optional empty subqueries are pruned', () => {
    scoreLookup.clear();
    priceLookup.clear();
    const selector = new BundleSelectorImpl();
    const graph = mkHybridGraphWithOptional([
      { id: 'sq0', obligation: 'required' },
      { id: 'sq1', obligation: 'required' },
      { id: 'sq2', obligation: 'required' },
      { id: 'sq3', obligation: 'required' },
      { id: 'sq4', obligation: 'required' },
      { id: 'sq5', obligation: 'optional' },
    ]);
    for (const id of ['sq0', 'sq1', 'sq2', 'sq3', 'sq4']) {
      scoreLookup.set(`${id}:w1`, 1);
    }
    const pools = new Map<string, readonly HybridCandidate[]>([
      ['sq0', [mkCandidate('sq0:w1', 0, 1)]],
      ['sq1', [mkCandidate('sq1:w1', 0, 1)]],
      ['sq2', [mkCandidate('sq2:w1', 0, 1)]],
      ['sq3', [mkCandidate('sq3:w1', 0, 1)]],
      ['sq4', [mkCandidate('sq4:w1', 0, 1)]],
      ['sq5', []],
    ]);

    const r = selector.chooseAssignment(graph, pools, mkOpts());

    expect(r.degradationReasons).toEqual([]);
    expect(r.assignments).toHaveLength(5);
    expect(r.assignments.map((a) => a.subqueryId)).not.toContain('sq5');
  });

  it('honours group_or by keeping the surviving satisfiable optional branch', () => {
    scoreLookup.clear();
    priceLookup.clear();
    scoreLookup.set('main:w1', 1.0);
    scoreLookup.set('cheese:w1', 0.8);
    const selector = new BundleSelectorImpl();
    const graph = mkHybridGraphWithTopology([
      { kind: 'group_and', nodeId: 'root', children: ['main', 'pairing_choice'] },
      { kind: 'subquery', nodeId: 'main', purpose: 'main', targetCardinality: 1, obligation: 'required' },
      { kind: 'group_or', nodeId: 'pairing_choice', children: ['dessert', 'cheese'] },
      { kind: 'subquery', nodeId: 'dessert', purpose: 'dessert', targetCardinality: 1, obligation: 'optional' },
      { kind: 'subquery', nodeId: 'cheese', purpose: 'cheese', targetCardinality: 1, obligation: 'optional' },
    ]);
    const pools = new Map<string, readonly HybridCandidate[]>([
      ['main', [mkCandidate('main:w1', 0, 1.0)]],
      ['dessert', []],
      ['cheese', [mkCandidate('cheese:w1', 0, 0.8)]],
    ]);

    const r = selector.chooseAssignment(graph, pools, mkOpts());

    expect(r.degradationReasons).toEqual([]);
    expect(r.assignments.map((a) => `${a.subqueryId}:${String(a.candidate.entityId)}`)).toEqual([
      'main:main:w1',
      'cheese:cheese:w1',
    ]);
  });

  it('honours group_xor by selecting exactly one optional branch', () => {
    scoreLookup.clear();
    priceLookup.clear();
    scoreLookup.set('main:w1', 1.0);
    scoreLookup.set('red:w1', 0.7);
    scoreLookup.set('white:w1', 0.9);
    const selector = new BundleSelectorImpl();
    const graph = mkHybridGraphWithTopology([
      { kind: 'group_and', nodeId: 'root', children: ['main', 'style_choice'] },
      { kind: 'subquery', nodeId: 'main', purpose: 'main', targetCardinality: 1, obligation: 'required' },
      { kind: 'group_xor', nodeId: 'style_choice', children: ['red', 'white'] },
      { kind: 'subquery', nodeId: 'red', purpose: 'red', targetCardinality: 1, obligation: 'optional' },
      { kind: 'subquery', nodeId: 'white', purpose: 'white', targetCardinality: 1, obligation: 'optional' },
    ]);
    const pools = new Map<string, readonly HybridCandidate[]>([
      ['main', [mkCandidate('main:w1', 0, 1.0)]],
      ['red', [mkCandidate('red:w1', 0, 0.7)]],
      ['white', [mkCandidate('white:w1', 0, 0.9)]],
    ]);

    const r = selector.chooseAssignment(graph, pools, mkOpts());

    expect(r.degradationReasons).toEqual([]);
    expect(r.assignments.map((a) => `${a.subqueryId}:${String(a.candidate.entityId)}`)).toEqual([
      'main:main:w1',
      'white:white:w1',
    ]);
  });

  it('surfaces group_obligation_unsatisfied when an OR branch cannot be satisfied by any optional pool', () => {
    scoreLookup.clear();
    priceLookup.clear();
    scoreLookup.set('main:w1', 1.0);
    const selector = new BundleSelectorImpl();
    const graph = mkHybridGraphWithTopology([
      { kind: 'group_and', nodeId: 'root', children: ['main', 'pairing_choice'] },
      { kind: 'subquery', nodeId: 'main', purpose: 'main', targetCardinality: 1, obligation: 'required' },
      { kind: 'group_or', nodeId: 'pairing_choice', children: ['dessert', 'cheese'] },
      { kind: 'subquery', nodeId: 'dessert', purpose: 'dessert', targetCardinality: 1, obligation: 'optional' },
      { kind: 'subquery', nodeId: 'cheese', purpose: 'cheese', targetCardinality: 1, obligation: 'optional' },
    ]);
    const pools = new Map<string, readonly HybridCandidate[]>([
      ['main', [mkCandidate('main:w1', 0, 1.0)]],
      ['dessert', []],
      ['cheese', []],
    ]);

    const r = selector.chooseAssignment(graph, pools, mkOpts());

    expect(r.assignments).toEqual([]);
    expect(r.degradationReasons).toEqual([
      'bundle_selector_fail_closed:group_obligation_unsatisfied',
    ]);
  });

  it('honours nested group_xor over multi-row branches via authoritative graph validation', () => {
    scoreLookup.clear();
    priceLookup.clear();
    scoreLookup.set('left-a:w1', 0.95);
    scoreLookup.set('left-b:w1', 0.9);
    scoreLookup.set('right:w1', 0.4);
    const selector = new BundleSelectorImpl();
    const graph = mkHybridGraphWithTopology([
      { kind: 'group_xor', nodeId: 'root', children: ['left_bundle', 'right'] },
      { kind: 'group_and', nodeId: 'left_bundle', children: ['left-a', 'left-b'] },
      { kind: 'subquery', nodeId: 'left-a', purpose: 'left-a', targetCardinality: 1, obligation: 'optional' },
      { kind: 'subquery', nodeId: 'left-b', purpose: 'left-b', targetCardinality: 1, obligation: 'optional' },
      { kind: 'subquery', nodeId: 'right', purpose: 'right', targetCardinality: 1, obligation: 'optional' },
    ]);
    const pools = new Map<string, readonly HybridCandidate[]>([
      ['left-a', [mkCandidate('left-a:w1', 0, 0.95)]],
      ['left-b', [mkCandidate('left-b:w1', 0, 0.9)]],
      ['right', [mkCandidate('right:w1', 0, 0.4)]],
    ]);

    const r = selector.chooseAssignment(graph, pools, mkOpts());

    expect(r.degradationReasons).toEqual([]);
    expect(r.assignments.map((a) => `${a.subqueryId}:${String(a.candidate.entityId)}`)).toEqual([
      'left-a:left-a:w1',
      'left-b:left-b:w1',
    ]);
  });

  it('honours nested group_or containing a group_xor branch when the fallback OR branch is unavailable', () => {
    scoreLookup.clear();
    priceLookup.clear();
    scoreLookup.set('main:w1', 1.0);
    scoreLookup.set('red:w1', 0.92);
    scoreLookup.set('white:w1', 0.8);
    const selector = new BundleSelectorImpl();
    const graph = mkHybridGraphWithTopology([
      { kind: 'group_and', nodeId: 'root', children: ['main', 'pairing_or'] },
      { kind: 'subquery', nodeId: 'main', purpose: 'main', targetCardinality: 1, obligation: 'required' },
      { kind: 'group_or', nodeId: 'pairing_or', children: ['style_xor', 'rose'] },
      { kind: 'group_xor', nodeId: 'style_xor', children: ['red', 'white'] },
      { kind: 'subquery', nodeId: 'red', purpose: 'red', targetCardinality: 1, obligation: 'optional' },
      { kind: 'subquery', nodeId: 'white', purpose: 'white', targetCardinality: 1, obligation: 'optional' },
      { kind: 'subquery', nodeId: 'rose', purpose: 'rose', targetCardinality: 1, obligation: 'optional' },
    ]);
    const pools = new Map<string, readonly HybridCandidate[]>([
      ['main', [mkCandidate('main:w1', 0, 1.0)]],
      ['red', [mkCandidate('red:w1', 0, 0.92)]],
      ['white', [mkCandidate('white:w1', 0, 0.8)]],
      ['rose', []],
    ]);

    const r = selector.chooseAssignment(graph, pools, mkOpts());

    expect(r.degradationReasons).toEqual([]);
    expect(r.assignments.map((a) => `${a.subqueryId}:${String(a.candidate.entityId)}`)).toEqual([
      'main:main:w1',
      'red:red:w1',
    ]);
  });

  it('does not select a dependent optional branch when its depends_on target is unavailable', () => {
    scoreLookup.clear();
    priceLookup.clear();
    scoreLookup.set('main:w1', 1.0);
    scoreLookup.set('dessert:w1', 0.95);
    const selector = new BundleSelectorImpl();
    const graph = {
      ...mkHybridGraphWithTopology([
        { kind: 'group_and', nodeId: 'root', children: ['main', 'dessert', 'cheese'] },
        { kind: 'subquery', nodeId: 'main', purpose: 'main', targetCardinality: 1, obligation: 'required' },
        { kind: 'subquery', nodeId: 'dessert', purpose: 'dessert', targetCardinality: 1, obligation: 'optional' },
        { kind: 'subquery', nodeId: 'cheese', purpose: 'cheese', targetCardinality: 1, obligation: 'optional' },
      ]),
      edges: [{ kind: 'depends_on' as const, from: 'dessert', to: 'cheese' }],
    };
    const pools = new Map<string, readonly HybridCandidate[]>([
      ['main', [mkCandidate('main:w1', 0, 1.0)]],
      ['dessert', [mkCandidate('dessert:w1', 0, 0.95)]],
      ['cheese', []],
    ]);

    const r = selector.chooseAssignment(graph, pools, mkOpts());

    expect(r.degradationReasons).toEqual([]);
    expect(r.assignments.map((a) => `${a.subqueryId}:${String(a.candidate.entityId)}`)).toEqual([
      'main:main:w1',
    ]);
  });

  it('selects a dependent branch together with its depends_on target when both are satisfiable', () => {
    scoreLookup.clear();
    priceLookup.clear();
    scoreLookup.set('main:w1', 1.0);
    scoreLookup.set('dessert:w1', 0.95);
    scoreLookup.set('cheese:w1', 0.9);
    const selector = new BundleSelectorImpl();
    const graph = {
      ...mkHybridGraphWithTopology([
        { kind: 'group_and', nodeId: 'root', children: ['main', 'dessert', 'cheese'] },
        { kind: 'subquery', nodeId: 'main', purpose: 'main', targetCardinality: 1, obligation: 'required' },
        { kind: 'subquery', nodeId: 'dessert', purpose: 'dessert', targetCardinality: 1, obligation: 'optional' },
        { kind: 'subquery', nodeId: 'cheese', purpose: 'cheese', targetCardinality: 1, obligation: 'optional' },
      ]),
      edges: [{ kind: 'depends_on' as const, from: 'dessert', to: 'cheese' }],
    };
    const pools = new Map<string, readonly HybridCandidate[]>([
      ['main', [mkCandidate('main:w1', 0, 1.0)]],
      ['dessert', [mkCandidate('dessert:w1', 0, 0.95)]],
      ['cheese', [mkCandidate('cheese:w1', 0, 0.9)]],
    ]);

    const r = selector.chooseAssignment(graph, pools, mkOpts());

    expect(r.degradationReasons).toEqual([]);
    expect(r.assignments.map((a) => `${a.subqueryId}:${String(a.candidate.entityId)}`)).toEqual([
      'main:main:w1',
      'dessert:dessert:w1',
      'cheese:cheese:w1',
    ]);
  });

  it('prefers a complement-satisfied bundle over a slightly higher-scoring incomplete optional branch', () => {
    scoreLookup.clear();
    priceLookup.clear();
    scoreLookup.set('main:w1', 1.0);
    scoreLookup.set('dessert:w1', 0.65);
    scoreLookup.set('cheese:w1', 0.6);
    scoreLookup.set('solo:w1', 0.95);
    const selector = new BundleSelectorImpl();
    const graph = {
      ...mkHybridGraphWithTopology([
        { kind: 'group_and', nodeId: 'root', children: ['main', 'choice'] },
        { kind: 'subquery', nodeId: 'main', purpose: 'main', targetCardinality: 1, obligation: 'required' },
        { kind: 'group_xor', nodeId: 'choice', children: ['pair_bundle', 'solo'] },
        { kind: 'group_and', nodeId: 'pair_bundle', children: ['dessert', 'cheese'] },
        { kind: 'subquery', nodeId: 'dessert', purpose: 'dessert', targetCardinality: 1, obligation: 'optional' },
        { kind: 'subquery', nodeId: 'cheese', purpose: 'cheese', targetCardinality: 1, obligation: 'optional' },
        { kind: 'subquery', nodeId: 'solo', purpose: 'solo', targetCardinality: 1, obligation: 'optional' },
      ]),
      edges: [{ kind: 'complements' as const, from: 'dessert', to: 'cheese', reason: 'pairing' }],
    };
    const pools = new Map<string, readonly HybridCandidate[]>([
      ['main', [mkCandidate('main:w1', 0, 1.0)]],
      ['dessert', [mkCandidate('dessert:w1', 0, 0.65)]],
      ['cheese', [mkCandidate('cheese:w1', 0, 0.6)]],
      ['solo', [mkCandidate('solo:w1', 0, 0.95)]],
    ]);

    const r = selector.chooseAssignment(graph, pools, mkOpts());

    expect(r.degradationReasons).toEqual([]);
    expect(r.assignments.map((a) => `${a.subqueryId}:${String(a.candidate.entityId)}`)).toEqual([
      'main:main:w1',
      'dessert:dessert:w1',
      'cheese:cheese:w1',
    ]);
  });
});
