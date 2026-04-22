/**
 * ADR-013 / ADR-015: graph-executor subquery telemetry invariants.
 *
 * Locks:
 *  - shared-mutable subquery retrievers run sequentially (no CandidatePool
 *    getter race across concurrent calls)
 *  - per-subquery degradation telemetry is aggregated onto the final
 *    GraphExecutionResult instead of reading only the last call's state
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
import type {
  ConstraintGraph,
  SubqueryNode,
} from '../../src/domain/query/model/constraint-graph.js';
import type { HybridCandidate } from '../../src/domain/retrieval/model/hybrid-candidate.js';
import type { HybridRetrievalInput } from '../../src/domain/retrieval/model/retrieval-input.js';
import { createEntityId } from '../../src/domain/shared/types/index.js';
import { makeHybridCandidate } from '../support/hybrid-candidate-test-factory.js';

function mkCandidate(id: string): HybridCandidate {
  return makeHybridCandidate({
    entityId: createEntityId(id),
  });
}

function hybridGraph(): ConstraintGraph {
  const subqueries: SubqueryNode[] = [
    { kind: 'subquery', nodeId: 'sq_red', purpose: 'red', targetCardinality: 1 },
    { kind: 'subquery', nodeId: 'sq_white', purpose: 'white', targetCardinality: 1 },
  ];
  return {
    graphSchemaVersion: 'constraint_graph_v1.1',
    origin: 'hybrid',
    rootNodeId: 'root',
    nodes: [
      { kind: 'group_and', nodeId: 'root', children: subqueries.map((sq) => sq.nodeId) },
      ...subqueries,
    ],
    edges: [],
    globalBudgets: {},
  };
}

const STUB_INPUT = {
  queryPlan: {} as never,
  route: 'hybrid',
  lexicalQueries: [],
  semanticQueries: [],
  hardConstraints: [],
  softConstraints: [],
} as unknown as HybridRetrievalInput;

describe('graph executor subquery telemetry aggregation', () => {
  beforeEach(() => {
    process.env['BUNDLE_SELECTOR_ENABLED'] = 'true';
  });

  afterEach(() => {
    delete process.env['BUNDLE_SELECTOR_ENABLED'];
  });

  it('runs shared-mutable subquery retrievers sequentially and aggregates degradation telemetry', async () => {
    let inFlight = 0;
    let sawConcurrency = false;
    const order: string[] = [];

    const retriever: SubqueryRetriever = {
      stateIsolation: 'shared_mutable',
      retrieve: async (_base, subquery) => {
        order.push(`start:${subquery.nodeId}`);
        inFlight += 1;
        if (inFlight > 1) sawConcurrency = true;
        await Promise.resolve();
        inFlight -= 1;
        order.push(`end:${subquery.nodeId}`);
        return {
          candidates: [mkCandidate(`${subquery.nodeId}:w1`)],
          telemetry: {
            degradationCodes: subquery.nodeId === 'sq_red' ? ['sparse_pool'] : ['no_matches'],
            degradationSignals: [{
              component: 'sparse_bm25',
              severity: 'warning',
              reason: `signal:${subquery.nodeId}`,
              fallbackApplied: 'kept_running',
            }],
          },
        };
      },
    };

    const deps: GraphExecutorDeps = {
      candidatePool: {
        execute: async () => [mkCandidate('unused')],
        generate: async () => [mkCandidate('unused')],
      },
      bundleSelector: new BundleSelectorImpl(),
      subqueryRetriever: retriever,
    };
    const opts: GraphExecutorOptions = {
      scoreFor: () => 1,
      priceFor: () => 0,
    };

    const result = await executeGraphAware(
      STUB_INPUT,
      hybridGraph(),
      deps,
      opts,
    );

    expect(result.mode).toBe('bundle');
    expect(sawConcurrency).toBe(false);
    expect(order).toEqual([
      'start:sq_red',
      'end:sq_red',
      'start:sq_white',
      'end:sq_white',
    ]);
    expect([...(result.retrievalTelemetry?.degradationCodes ?? [])].sort()).toEqual([
      'no_matches',
      'sparse_pool',
    ]);
    expect(result.retrievalTelemetry?.degradationSignals).toHaveLength(2);
  });
});
