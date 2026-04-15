/**
 * ADR-015 Axis 2 invariants: deterministic critic decision tree.
 *
 * Locks the executor-internal critic's pure decision logic. Every input
 * combination from the §5 decision table is exercised. The critic must
 * be deterministic — same input → same output across any number of
 * calls — and never call an LLM directly (the LLM seam is in the
 * companion query-rewriter, not here).
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import {
  CRITIC_RETRY_MAX,
  decideRetry,
  type CriticInput,
} from '../../src/domain/retrieval/service/retrieval-critic.js';
import type {
  ConstraintGraph,
  SubqueryNode,
} from '../../src/domain/query/model/constraint-graph.js';
import type { GraphCoverageResult } from '../../src/domain/query/service/compute-graph-coverage.js';

function coverage(over: Partial<GraphCoverageResult>): GraphCoverageResult {
  return {
    matchedAttributes: [],
    unmetAttributes: [],
    matchedNodeIds: [],
    unmetNodeIds: [],
    coverageRatio: 0,
    rootSatisfied: false,
    ...over,
  };
}

function multiSubqueryGraph(): ConstraintGraph {
  const subqueries: SubqueryNode[] = [
    { kind: 'subquery', nodeId: 'sq_a', purpose: 'a', targetCardinality: 1 },
    { kind: 'subquery', nodeId: 'sq_b', purpose: 'b', targetCardinality: 1 },
  ];
  return {
    graphSchemaVersion: 'constraint_graph_v1.1',
    origin: 'hybrid',
    rootNodeId: 'root',
    nodes: [
      { kind: 'group_and', nodeId: 'root', children: ['sq_a', 'sq_b'] },
      ...subqueries,
    ],
    edges: [],
    globalBudgets: {},
  };
}

function singleSubqueryGraph(): ConstraintGraph {
  return {
    graphSchemaVersion: 'constraint_graph_v1',
    origin: 'deterministic_from_atoms',
    rootNodeId: 'root',
    nodes: [
      { kind: 'group_and', nodeId: 'root', children: ['sq_only'] },
      { kind: 'subquery', nodeId: 'sq_only', purpose: 'only', targetCardinality: 1 },
    ],
    edges: [],
    globalBudgets: {},
  };
}

describe('retrieval-critic.decideRetry', () => {
  it('coverage=1 + rootSatisfied → no retry (coverage_satisfied)', () => {
    const decision = decideRetry({
      graph: undefined,
      coverage: coverage({ coverageRatio: 1, rootSatisfied: true }),
      degradationCodes: [],
      retryCount: 0,
    });
    expect(decision.retry).toBe(false);
    if (!decision.retry) {
      expect(decision.reason).toBe('coverage_satisfied');
    }
  });

  it('coverage=0 → retry with relax', () => {
    const decision = decideRetry({
      graph: undefined,
      coverage: coverage({ coverageRatio: 0, rootSatisfied: false }),
      degradationCodes: [],
      retryCount: 0,
    });
    expect(decision.retry).toBe(true);
    if (decision.retry) {
      expect(decision.rewriteType).toBe('relax');
      expect(decision.reason).toBe('coverage_zero_relax');
    }
  });

  it('low coverage + no_matches → retry with expand_synonym', () => {
    const decision = decideRetry({
      graph: undefined,
      coverage: coverage({ coverageRatio: 0.2, rootSatisfied: false }),
      degradationCodes: ['no_matches'],
      retryCount: 0,
    });
    expect(decision.retry).toBe(true);
    if (decision.retry) {
      expect(decision.rewriteType).toBe('expand_synonym');
    }
  });

  it('mid coverage + multi-subquery graph → retry with decompose', () => {
    const decision = decideRetry({
      graph: multiSubqueryGraph(),
      coverage: coverage({ coverageRatio: 0.6, rootSatisfied: false }),
      degradationCodes: [],
      retryCount: 0,
    });
    expect(decision.retry).toBe(true);
    if (decision.retry) {
      expect(decision.rewriteType).toBe('decompose');
    }
  });

  it('mid coverage + single-subquery graph → retry with reformulate (LLM fallback)', () => {
    const decision = decideRetry({
      graph: singleSubqueryGraph(),
      coverage: coverage({ coverageRatio: 0.6, rootSatisfied: false }),
      degradationCodes: [],
      retryCount: 0,
    });
    expect(decision.retry).toBe(true);
    if (decision.retry) {
      expect(decision.rewriteType).toBe('reformulate');
    }
  });

  it('retryCount >= CRITIC_RETRY_MAX → no retry (retry_cap_reached)', () => {
    const decision = decideRetry({
      graph: undefined,
      coverage: coverage({ coverageRatio: 0, rootSatisfied: false }),
      degradationCodes: ['no_matches'],
      retryCount: CRITIC_RETRY_MAX,
    });
    expect(decision.retry).toBe(false);
    if (!decision.retry) {
      expect(decision.reason).toBe('retry_cap_reached');
    }
  });

  it('no signal at all → no retry (no_signal_to_act_on)', () => {
    const decision = decideRetry({
      graph: undefined,
      coverage: undefined,
      degradationCodes: [],
      retryCount: 0,
    });
    expect(decision.retry).toBe(false);
    if (!decision.retry) {
      expect(decision.reason).toBe('no_signal_to_act_on');
    }
  });

  it('is pure: same input → same output across 100 calls', () => {
    const input: CriticInput = {
      graph: multiSubqueryGraph(),
      coverage: coverage({ coverageRatio: 0.5, rootSatisfied: false }),
      degradationCodes: ['sparse_pool'],
      retryCount: 1,
    };
    const first = decideRetry(input);
    for (let i = 0; i < 100; i += 1) {
      expect(decideRetry(input)).toEqual(first);
    }
  });
});
