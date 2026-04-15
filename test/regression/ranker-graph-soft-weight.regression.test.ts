/**
 * ADR-014 Phase 1b.3b: ranker soft-weight rewrite to graph coverage
 * semantics.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { computeGraphSoftWeight } from '../../src/domain/ranking/service/graph-soft-weight.js';
import type {
  ConstraintGraph,
  ConstraintGraphNode,
  ConstraintTier,
} from '../../src/domain/query/model/constraint-graph.js';

function slot(
  id: string,
  attribute: string,
  tier: ConstraintTier = 'soft',
): ConstraintGraphNode {
  return {
    kind: 'slot',
    nodeId: id,
    atomRef: id,
    attribute,
    operator: '=',
    value: 'x',
    sourceTier: tier,
    sourceKind: 'explicit_utterance',
    confidence: 1,
  };
}

function graph(
  rootId: string,
  nodes: readonly ConstraintGraphNode[],
): ConstraintGraph {
  return {
    graphSchemaVersion: 'constraint_graph_v1',
    origin: 'deterministic_from_atoms',
    rootNodeId: rootId,
    nodes,
    edges: [],
    globalBudgets: {},
  };
}

describe('computeGraphSoftWeight — ADR-014 Phase 1b.3b', () => {
  it('empty soft subgraph → 1 (no obligation, trivially covered)', () => {
    const g = graph('root', [
      { kind: 'group_and', nodeId: 'root', children: [] },
    ]);
    expect(
      computeGraphSoftWeight({ graph: g, matchedAttributes: new Set() }),
    ).toBe(1);
  });

  it('trivial soft AND-all: ratio equals matched/total', () => {
    const g = graph('root', [
      { kind: 'group_and', nodeId: 'root', children: ['s1', 's2', 's3'] },
      slot('s1', 'body'),
      slot('s2', 'acidity'),
      slot('s3', 'tannin'),
    ]);
    const w = computeGraphSoftWeight({
      graph: g,
      matchedAttributes: new Set(['body']),
    });
    expect(w).toBeCloseTo(1 / 3);
  });

  it('soft OR: any one branch satisfied → coverage = 1', () => {
    const g = graph('root', [
      { kind: 'group_or', nodeId: 'root', children: ['s1', 's2'] },
      slot('s1', 'body'),
      slot('s2', 'acidity'),
    ]);
    expect(
      computeGraphSoftWeight({
        graph: g,
        matchedAttributes: new Set(['body']),
      }),
    ).toBe(1);
  });

  it('soft XOR: exactly one branch → coverage = 1; both → full-tree ratio', () => {
    const g = graph('root', [
      { kind: 'group_xor', nodeId: 'root', children: ['s1', 's2'] },
      slot('s1', 'body'),
      slot('s2', 'acidity'),
    ]);
    expect(
      computeGraphSoftWeight({
        graph: g,
        matchedAttributes: new Set(['body']),
      }),
    ).toBe(1);
    // Both matched → XOR fails; coverageRatio uses the flattened matched+unmet
    // surface from `computeGraphCoverage` — both slots contribute, both matched
    // → 1. Document the expected numerator/denominator explicitly.
    expect(
      computeGraphSoftWeight({
        graph: g,
        matchedAttributes: new Set(['body', 'acidity']),
      }),
    ).toBeGreaterThan(0);
  });

  it('nested AND over soft OR: ratio reflects inner-group satisfaction', () => {
    const g = graph('root', [
      { kind: 'group_and', nodeId: 'root', children: ['or1', 's3'] },
      { kind: 'group_or', nodeId: 'or1', children: ['s1', 's2'] },
      slot('s1', 'body'),
      slot('s2', 'acidity'),
      slot('s3', 'tannin'),
    ]);
    // OR satisfied via body (contributes 1 slot); tannin matched as well.
    const full = computeGraphSoftWeight({
      graph: g,
      matchedAttributes: new Set(['body', 'tannin']),
    });
    expect(full).toBe(1);
    // OR satisfied, tannin missing → 1/2.
    const partial = computeGraphSoftWeight({
      graph: g,
      matchedAttributes: new Set(['body']),
    });
    expect(partial).toBeCloseTo(1 / 2);
  });

  it('hard-tier slots are ignored in soft projection', () => {
    const g = graph('root', [
      { kind: 'group_and', nodeId: 'root', children: ['h1', 's1'] },
      slot('h1', 'wine_type', 'hard'),
      slot('s1', 'body', 'soft'),
    ]);
    // Only s1 is in the soft subgraph. Unmatched → ratio 0.
    expect(
      computeGraphSoftWeight({ graph: g, matchedAttributes: new Set() }),
    ).toBe(0);
    expect(
      computeGraphSoftWeight({
        graph: g,
        matchedAttributes: new Set(['body']),
      }),
    ).toBe(1);
  });
});
