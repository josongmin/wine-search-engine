/**
 * ADR-013 Phase 1c: BudgetLedger pre-rank → post-assignment relocation.
 *
 * The P1-C fix: `BudgetLedger.reserve()` (or any equivalent book-keeping)
 * MUST only fire for the candidates that win a subquery slot *after*
 * the solver returns. Unselected candidates must NOT reserve budget.
 *
 * This test locks:
 *   1. `onReserveAssignment` is called exactly once per assignment.
 *   2. `onReserveAssignment` is NEVER called for a non-assigned candidate.
 *   3. `BUNDLE_SELECTOR_BUDGET_UNSELECTED_RESERVED_COUNT` stays at 0
 *      across a successful bundle run.
 *   4. On fail-closed the reserve hook is not called at all.
 *
 * Never delete this file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  executeGraphAware,
  type GraphExecutorDeps,
  type GraphExecutorOptions,
  type SubqueryRetriever,
} from '../../src/application/search/search-usecase-graph-executor.js';
import { BundleSelectorImpl } from '../../src/domain/retrieval/service/bundle-selector.js';
import { globalBundleSelectorCounter } from '../../src/observability/bundle-selector-counters.js';
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

const stubInput = {
  queryPlan: {} as never,
  route: 'hybrid',
  lexicalQueries: [],
  semanticQueries: [],
  hardConstraints: [],
  softConstraints: [],
} as unknown as HybridRetrievalInput;

function hybridGraph(sqCount: number): ConstraintGraph {
  const subqueries: SubqueryNode[] = [];
  for (let i = 0; i < sqCount; i += 1) {
    subqueries.push({
      kind: 'subquery',
      nodeId: `sq_${i}`,
      purpose: `p_${i}`,
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
    edges: [],
    globalBudgets: {},
  };
}

const candidatePool: CandidatePoolPort = {
  execute: async () => [],
  generate: async () => [],
};

// Subquery retriever that returns 3 candidates per subquery — the
// solver picks 1, the other 2 must never invoke onReserveAssignment.
const subqueryRetriever: SubqueryRetriever = {
  retrieve: async (_base, sq) => [
    mkCandidate(`${sq.nodeId}:w1`),
    mkCandidate(`${sq.nodeId}:w2`),
    mkCandidate(`${sq.nodeId}:w3`),
  ],
};

describe('BundleSelector post-assignment budget ledger (ADR-013 P1-C)', () => {
  beforeEach(() => {
    process.env['BUNDLE_SELECTOR_ENABLED'] = 'true';
    globalBundleSelectorCounter.reset();
  });
  afterEach(() => {
    delete process.env['BUNDLE_SELECTOR_ENABLED'];
    globalBundleSelectorCounter.reset();
  });

  it('onReserveAssignment fires exactly once per winning slot (not per candidate in pool)', async () => {
    const reserved: string[] = [];
    const deps: GraphExecutorDeps = {
      candidatePool,
      bundleSelector: new BundleSelectorImpl(),
      subqueryRetriever,
    };
    const opts: GraphExecutorOptions = {
      scoreFor: ({ colIdx }) => (colIdx === 0 ? 10 : 1),
      priceFor: () => 0,
      onReserveAssignment: ({ subqueryId, candidate }) => {
        reserved.push(`${subqueryId}:${String(candidate.entityId)}`);
      },
    };
    const r = await executeGraphAware(stubInput, hybridGraph(3), deps, opts);
    expect(r.mode).toBe('bundle');
    // 3 subqueries, 3 reservations. 9 pool candidates total, but only 3 win.
    expect(reserved).toHaveLength(3);
    // UNSELECTED reserved counter stays at 0.
    expect(
      globalBundleSelectorCounter.snapshot()
        .BUNDLE_SELECTOR_BUDGET_UNSELECTED_RESERVED_COUNT,
    ).toBe(0);
  });

  it('onReserveAssignment is NEVER invoked for non-assigned candidates', async () => {
    const reserved: string[] = [];
    const deps: GraphExecutorDeps = {
      candidatePool,
      bundleSelector: new BundleSelectorImpl(),
      subqueryRetriever,
    };
    const opts: GraphExecutorOptions = {
      scoreFor: ({ colIdx }) => (colIdx === 0 ? 10 : 1),
      priceFor: () => 0,
      onReserveAssignment: ({ subqueryId, candidate }) => {
        reserved.push(`${subqueryId}:${String(candidate.entityId)}`);
      },
    };
    await executeGraphAware(stubInput, hybridGraph(3), deps, opts);
    // Each winning entity ID matches the solver's pick; no "w2"/"w3"
    // reservations must appear unless the scorer preferred them (it doesn't).
    for (const k of reserved) expect(k.endsWith(':w1')).toBe(true);
  });

  it('fail-closed (empty pool) never invokes onReserveAssignment', async () => {
    const reserved: string[] = [];
    const emptyRetriever: SubqueryRetriever = { retrieve: async () => [] };
    const deps: GraphExecutorDeps = {
      candidatePool,
      bundleSelector: new BundleSelectorImpl(),
      subqueryRetriever: emptyRetriever,
    };
    const opts: GraphExecutorOptions = {
      scoreFor: () => 1,
      priceFor: () => 0,
      onReserveAssignment: ({ subqueryId, candidate }) => {
        reserved.push(`${subqueryId}:${String(candidate.entityId)}`);
      },
    };
    const r = await executeGraphAware(stubInput, hybridGraph(2), deps, opts);
    expect(r.mode).toBe('fail_closed');
    expect(reserved).toHaveLength(0);
    expect(
      globalBundleSelectorCounter.snapshot().BUNDLE_SELECTOR_EMPTY_SLOT_POOL_COUNT,
    ).toBe(1);
  });

  it('K>5 fail-closed increments k_exceeds_exact_limit counter and reserves nothing', async () => {
    const reserved: string[] = [];
    const deps: GraphExecutorDeps = {
      candidatePool,
      bundleSelector: new BundleSelectorImpl(),
      subqueryRetriever,
    };
    const opts: GraphExecutorOptions = {
      scoreFor: () => 1,
      priceFor: () => 0,
      onReserveAssignment: ({ subqueryId, candidate }) => {
        reserved.push(`${subqueryId}:${String(candidate.entityId)}`);
      },
    };
    const r = await executeGraphAware(stubInput, hybridGraph(6), deps, opts);
    expect(r.mode).toBe('fail_closed');
    expect(reserved).toHaveLength(0);
    expect(
      globalBundleSelectorCounter.snapshot()
        .BUNDLE_SELECTOR_K_EXCEEDS_EXACT_LIMIT_COUNT,
    ).toBe(1);
  });
});
