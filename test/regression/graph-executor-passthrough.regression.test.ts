/**
 * ADR-013 Phase 1c: graph-aware executor passthrough invariants.
 *
 * Append-only test. Locks:
 *   1. Flag off → always pass-through, byte-identical to candidatePool.execute.
 *   2. Graph undefined → pass-through.
 *   3. Graph origin='deterministic_from_atoms' → pass-through.
 *   4. Hybrid graph with 0 or 1 subquery nodes → pass-through.
 *   5. Non-trivial graph with >1 subquery nodes + flag on → bundle engaged.
 *
 * Never delete this file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  executeGraphAware,
  shouldEngageBundlePath,
  type GraphExecutorDeps,
  type GraphExecutorOptions,
} from '../../src/application/search/search-usecase-graph-executor.js';
import {
  BundleSelectorImpl,
} from '../../src/domain/retrieval/service/bundle-selector.js';
import type {
  ConstraintGraph,
  SubqueryNode,
} from '../../src/domain/query/model/constraint-graph.js';
import type { HybridCandidate } from '../../src/domain/retrieval/model/hybrid-candidate.js';
import type { HybridRetrievalInput } from '../../src/domain/retrieval/model/retrieval-input.js';
import type { CandidatePoolPort } from '../../src/application/search/port/search-pipeline-deps.port.js';

function mkCandidate(id: string): HybridCandidate {
  return {
    entityId: id as never,
    retrievalTraces: [],
  } as unknown as HybridCandidate;
}

const STUB_POOL_OUTPUT: readonly HybridCandidate[] = [
  mkCandidate('c-root-1'),
  mkCandidate('c-root-2'),
];

const stubCandidatePool: CandidatePoolPort = {
  execute: async () => STUB_POOL_OUTPUT,
  generate: async () => STUB_POOL_OUTPUT,
};

const stubInput = {
  queryPlan: {} as never,
  route: 'hybrid',
  lexicalQueries: [],
  semanticQueries: [],
  hardConstraints: [],
  softConstraints: [],
} as unknown as HybridRetrievalInput;

function trivialGraph(): ConstraintGraph {
  return {
    graphSchemaVersion: 'constraint_graph_v1',
    origin: 'deterministic_from_atoms',
    rootNodeId: 'root',
    nodes: [{ kind: 'group_and', nodeId: 'root', children: [] }],
    edges: [],
    globalBudgets: {},
  };
}

function hybridGraph(subqueryCount: number, withSharedBudget = false): ConstraintGraph {
  const subqueries: SubqueryNode[] = [];
  for (let i = 0; i < subqueryCount; i += 1) {
    subqueries.push({
      kind: 'subquery',
      nodeId: `sq_${i}`,
      purpose: `purpose_${i}`,
      targetCardinality: 1,
    });
  }
  return {
    graphSchemaVersion: 'constraint_graph_v1.1',
    origin: 'hybrid',
    rootNodeId: 'root',
    nodes: [
      { kind: 'group_and', nodeId: 'root', children: subqueries.map((s) => s.nodeId) },
      ...subqueries,
    ],
    edges: withSharedBudget && subqueries.length >= 2
      ? [
          {
            kind: 'shares_budget',
            from: subqueries[0]!.nodeId,
            to: subqueries[1]!.nodeId,
            resource: 'price_total',
          },
        ]
      : [],
    globalBudgets: withSharedBudget
      ? { priceTotal: { currency: 'KRW', max: 150_000 } }
      : {},
  };
}

function plannerEmittedGraph(subqueryCount: number): ConstraintGraph {
  const graph = hybridGraph(subqueryCount);
  return {
    ...graph,
    origin: 'planner_emitted',
    graphSchemaVersion: 'constraint_graph_v1.1',
  };
}

const deps: GraphExecutorDeps = {
  candidatePool: stubCandidatePool,
  bundleSelector: new BundleSelectorImpl(),
};

const baseOpts: GraphExecutorOptions = {
  scoreFor: () => 1,
  priceFor: () => 0,
};

describe('executeGraphAware passthrough (ADR-013)', () => {
  beforeEach(() => {
    process.env['BUNDLE_SELECTOR_ENABLED'] = 'false';
  });
  afterEach(() => {
    delete process.env['BUNDLE_SELECTOR_ENABLED'];
  });

  it('flag off → pass-through byte-identical to candidatePool.execute', async () => {
    const r = await executeGraphAware(stubInput, hybridGraph(3), deps, baseOpts);
    expect(r.mode).toBe('passthrough');
    expect(r.candidates).toBe(STUB_POOL_OUTPUT);
  });

  it('flag on, graph undefined → pass-through', async () => {
    process.env['BUNDLE_SELECTOR_ENABLED'] = 'true';
    const r = await executeGraphAware(stubInput, undefined, deps, baseOpts);
    expect(r.mode).toBe('passthrough');
    expect(r.candidates).toBe(STUB_POOL_OUTPUT);
  });

  it('flag on, trivial graph → pass-through', async () => {
    process.env['BUNDLE_SELECTOR_ENABLED'] = 'true';
    const r = await executeGraphAware(stubInput, trivialGraph(), deps, baseOpts);
    expect(r.mode).toBe('passthrough');
  });

  it('flag on, hybrid graph with 1 subquery → pass-through', async () => {
    process.env['BUNDLE_SELECTOR_ENABLED'] = 'true';
    const r = await executeGraphAware(stubInput, hybridGraph(1), deps, baseOpts);
    expect(r.mode).toBe('passthrough');
  });

  it('flag on, hybrid graph with 2 subqueries → bundle engaged', async () => {
    process.env['BUNDLE_SELECTOR_ENABLED'] = 'true';
    const r = await executeGraphAware(stubInput, hybridGraph(2), deps, baseOpts);
    expect(r.mode).toBe('bundle');
    expect(r.candidates.length).toBe(2);
    expect(r.assignmentSolution?.assignments.length).toBe(2);
  });

  it('flag on, planner_emitted graph with 2 subqueries → bundle engaged', async () => {
    process.env['BUNDLE_SELECTOR_ENABLED'] = 'true';
    const graph = plannerEmittedGraph(2);
    expect(shouldEngageBundlePath(graph)).toBe(true);
    const r = await executeGraphAware(stubInput, graph, deps, baseOpts);
    expect(r.mode).toBe('bundle');
    expect(r.assignmentSolution?.assignments.length).toBe(2);
  });

  it('shouldEngageBundlePath predicate agrees with executor engagement rule', () => {
    process.env['BUNDLE_SELECTOR_ENABLED'] = 'true';
    expect(shouldEngageBundlePath(undefined)).toBe(false);
    expect(shouldEngageBundlePath(trivialGraph())).toBe(false);
    expect(shouldEngageBundlePath(hybridGraph(1))).toBe(false);
    expect(shouldEngageBundlePath(hybridGraph(2))).toBe(true);
    expect(shouldEngageBundlePath(hybridGraph(5))).toBe(true);
    process.env['BUNDLE_SELECTOR_ENABLED'] = 'false';
    expect(shouldEngageBundlePath(hybridGraph(2))).toBe(false);
  });
});
