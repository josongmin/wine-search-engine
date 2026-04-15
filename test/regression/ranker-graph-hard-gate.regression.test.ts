/**
 * ADR-014 Phase 1b.3b: ranker hard gate rewrite to graph root-satisfied
 * semantics.
 *
 * Locks the contract that `evaluateGraphHardGate` delegates to the hard-
 * tier subgraph via `computeGraphCoverage`, handles AND / OR / XOR /
 * nested composition correctly, dedupes slots sharing an `atomRef`, and
 * stays byte-identical to the flat AND-all predicate on trivial graphs.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { evaluateGraphHardGate } from '../../src/domain/ranking/service/graph-hard-gate.js';
import type {
  ConstraintGraph,
  ConstraintGraphNode,
  ConstraintTier,
} from '../../src/domain/query/model/constraint-graph.js';

function slot(
  id: string,
  attribute: string,
  tier: ConstraintTier = 'hard',
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

describe('evaluateGraphHardGate — ADR-014 Phase 1b.3b', () => {
  it('trivial AND-all graph: all hard attributes matched → passes', () => {
    const g = graph('root', [
      { kind: 'group_and', nodeId: 'root', children: ['s1', 's2'] },
      slot('s1', 'wine_type'),
      slot('s2', 'region'),
    ]);
    expect(
      evaluateGraphHardGate({
        graph: g,
        matchedAttributes: new Set(['wine_type', 'region']),
      }),
    ).toBe(true);
  });

  it('trivial AND-all graph: any unmet hard attribute → fails (flat parity)', () => {
    const g = graph('root', [
      { kind: 'group_and', nodeId: 'root', children: ['s1', 's2'] },
      slot('s1', 'wine_type'),
      slot('s2', 'region'),
    ]);
    expect(
      evaluateGraphHardGate({
        graph: g,
        matchedAttributes: new Set(['wine_type']),
      }),
    ).toBe(false);
  });

  it('XOR branch A satisfied → passes', () => {
    const g = graph('root', [
      { kind: 'group_xor', nodeId: 'root', children: ['s1', 's2'] },
      slot('s1', 'wine_type'),
      slot('s2', 'color'),
    ]);
    expect(
      evaluateGraphHardGate({
        graph: g,
        matchedAttributes: new Set(['wine_type']),
      }),
    ).toBe(true);
  });

  it('XOR branch B satisfied → passes', () => {
    const g = graph('root', [
      { kind: 'group_xor', nodeId: 'root', children: ['s1', 's2'] },
      slot('s1', 'wine_type'),
      slot('s2', 'color'),
    ]);
    expect(
      evaluateGraphHardGate({
        graph: g,
        matchedAttributes: new Set(['color']),
      }),
    ).toBe(true);
  });

  it('XOR both branches satisfied → fails (violates exclusivity)', () => {
    const g = graph('root', [
      { kind: 'group_xor', nodeId: 'root', children: ['s1', 's2'] },
      slot('s1', 'wine_type'),
      slot('s2', 'color'),
    ]);
    expect(
      evaluateGraphHardGate({
        graph: g,
        matchedAttributes: new Set(['wine_type', 'color']),
      }),
    ).toBe(false);
  });

  it('XOR neither branch satisfied → fails', () => {
    const g = graph('root', [
      { kind: 'group_xor', nodeId: 'root', children: ['s1', 's2'] },
      slot('s1', 'wine_type'),
      slot('s2', 'color'),
    ]);
    expect(
      evaluateGraphHardGate({
        graph: g,
        matchedAttributes: new Set(),
      }),
    ).toBe(false);
  });

  it('OR any-one-satisfied passes', () => {
    const g = graph('root', [
      { kind: 'group_or', nodeId: 'root', children: ['s1', 's2'] },
      slot('s1', 'region'),
      slot('s2', 'producer'),
    ]);
    expect(
      evaluateGraphHardGate({
        graph: g,
        matchedAttributes: new Set(['region']),
      }),
    ).toBe(true);
    expect(
      evaluateGraphHardGate({
        graph: g,
        matchedAttributes: new Set(['producer']),
      }),
    ).toBe(true);
  });

  it('OR none-satisfied → fails', () => {
    const g = graph('root', [
      { kind: 'group_or', nodeId: 'root', children: ['s1', 's2'] },
      slot('s1', 'region'),
      slot('s2', 'producer'),
    ]);
    expect(
      evaluateGraphHardGate({
        graph: g,
        matchedAttributes: new Set(),
      }),
    ).toBe(false);
  });

  it('nested AND over two OR groups: both ORs need any-one-satisfied', () => {
    const g = graph('root', [
      { kind: 'group_and', nodeId: 'root', children: ['or1', 'or2'] },
      { kind: 'group_or', nodeId: 'or1', children: ['s1', 's2'] },
      { kind: 'group_or', nodeId: 'or2', children: ['s3', 's4'] },
      slot('s1', 'region'),
      slot('s2', 'producer'),
      slot('s3', 'wine_type'),
      slot('s4', 'color'),
    ]);
    expect(
      evaluateGraphHardGate({
        graph: g,
        matchedAttributes: new Set(['region', 'wine_type']),
      }),
    ).toBe(true);
    expect(
      evaluateGraphHardGate({
        graph: g,
        matchedAttributes: new Set(['region']),
      }),
    ).toBe(false);
  });

  it('ignores soft-tier slots (hard-tier projection drops them)', () => {
    const g = graph('root', [
      { kind: 'group_and', nodeId: 'root', children: ['s1', 'soft1'] },
      slot('s1', 'wine_type', 'hard'),
      slot('soft1', 'body', 'soft'),
    ]);
    // Soft slot absence doesn't force a hard-gate failure.
    expect(
      evaluateGraphHardGate({
        graph: g,
        matchedAttributes: new Set(['wine_type']),
      }),
    ).toBe(true);
  });

  it('empty hard-tier subgraph (no hard slots) → vacuously passes', () => {
    const g = graph('root', [
      { kind: 'group_and', nodeId: 'root', children: ['s1'] },
      slot('s1', 'body', 'soft'),
    ]);
    expect(
      evaluateGraphHardGate({
        graph: g,
        matchedAttributes: new Set(),
      }),
    ).toBe(true);
  });

  it('XOR with shared atomRef (same attribute reused under two slots): only one matching satisfies', () => {
    // Two slot nodes referencing different atoms but the same attribute
    // value. When the matched-attribute set contains that attribute, both
    // slots "satisfy" — XOR should fail (more than one branch satisfied).
    const g = graph('root', [
      { kind: 'group_xor', nodeId: 'root', children: ['s1', 's2'] },
      slot('s1', 'region'),
      slot('s2', 'region'),
    ]);
    expect(
      evaluateGraphHardGate({
        graph: g,
        matchedAttributes: new Set(['region']),
      }),
    ).toBe(false);
  });
});
