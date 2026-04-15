/**
 * ADR-011 Phase 1b.1: graph-aware coverage semantics.
 *
 * Locks AND / OR / XOR group semantics, nested-group composition,
 * coverage-ratio arithmetic, and root-satisfaction rules.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { computeGraphCoverage } from '../../src/domain/query/service/compute-graph-coverage.js';
import type {
  ConstraintGraph,
  ConstraintGraphNode,
} from '../../src/domain/query/model/constraint-graph.js';

function slot(id: string, attribute: string): ConstraintGraphNode {
  return {
    kind: 'slot',
    nodeId: id,
    atomRef: id,
    attribute,
    operator: '=',
    value: 'x',
    sourceTier: 'hard',
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

describe('computeGraphCoverage — AND/OR/XOR semantics', () => {
  it('empty graph reports 100% coverage (nothing required)', () => {
    const g = graph('root', [
      { kind: 'group_and', nodeId: 'root', children: [] },
    ]);
    const r = computeGraphCoverage(g, new Set());
    expect(r.coverageRatio).toBe(1);
    expect(r.rootSatisfied).toBe(true);
    expect(r.matchedAttributes).toEqual([]);
    expect(r.unmetAttributes).toEqual([]);
  });

  it('AND: all children must be satisfied', () => {
    const g = graph('root', [
      { kind: 'group_and', nodeId: 'root', children: ['s1', 's2', 's3'] },
      slot('s1', 'wine_type'),
      slot('s2', 'region'),
      slot('s3', 'price_usd'),
    ]);
    const allMatched = computeGraphCoverage(
      g,
      new Set(['wine_type', 'region', 'price_usd']),
    );
    expect(allMatched.rootSatisfied).toBe(true);
    expect(allMatched.coverageRatio).toBe(1);
    expect([...allMatched.matchedAttributes].sort()).toEqual(
      ['price_usd', 'region', 'wine_type'],
    );

    const partial = computeGraphCoverage(g, new Set(['wine_type']));
    expect(partial.rootSatisfied).toBe(false);
    expect(partial.coverageRatio).toBeCloseTo(1 / 3);
    expect([...partial.matchedAttributes].sort()).toEqual(['wine_type']);
    expect([...partial.unmetAttributes].sort()).toEqual(['price_usd', 'region']);
  });

  it('OR: at least one child satisfies the group — only that slot counts', () => {
    const g = graph('root', [
      { kind: 'group_or', nodeId: 'root', children: ['s1', 's2'] },
      slot('s1', 'region'),
      slot('s2', 'producer'),
    ]);
    const regionMatched = computeGraphCoverage(g, new Set(['region']));
    expect(regionMatched.rootSatisfied).toBe(true);
    expect(regionMatched.coverageRatio).toBe(1);
    expect([...regionMatched.matchedAttributes]).toEqual(['region']);
    // `producer` is not "unmet" — the OR is already satisfied without it.
    expect([...regionMatched.unmetAttributes]).toEqual([]);
  });

  it('OR: no child satisfied → all slots surface as unmet', () => {
    const g = graph('root', [
      { kind: 'group_or', nodeId: 'root', children: ['s1', 's2'] },
      slot('s1', 'region'),
      slot('s2', 'producer'),
    ]);
    const none = computeGraphCoverage(g, new Set());
    expect(none.rootSatisfied).toBe(false);
    expect([...none.unmetAttributes].sort()).toEqual(['producer', 'region']);
    expect(none.coverageRatio).toBe(0);
  });

  it('XOR: exactly one satisfied → group satisfied', () => {
    const g = graph('root', [
      { kind: 'group_xor', nodeId: 'root', children: ['s1', 's2'] },
      slot('s1', 'wine_type_red'),
      slot('s2', 'wine_type_white'),
    ]);
    const red = computeGraphCoverage(g, new Set(['wine_type_red']));
    expect(red.rootSatisfied).toBe(true);
    expect(red.coverageRatio).toBe(1);
    expect([...red.matchedAttributes]).toEqual(['wine_type_red']);
  });

  it('XOR: two satisfied → group NOT satisfied (mutual exclusion breached)', () => {
    const g = graph('root', [
      { kind: 'group_xor', nodeId: 'root', children: ['s1', 's2'] },
      slot('s1', 'wine_type_red'),
      slot('s2', 'wine_type_white'),
    ]);
    const both = computeGraphCoverage(
      g,
      new Set(['wine_type_red', 'wine_type_white']),
    );
    expect(both.rootSatisfied).toBe(false);
  });

  it('XOR: zero satisfied → group NOT satisfied; all slots unmet', () => {
    const g = graph('root', [
      { kind: 'group_xor', nodeId: 'root', children: ['s1', 's2'] },
      slot('s1', 'wine_type_red'),
      slot('s2', 'wine_type_white'),
    ]);
    const none = computeGraphCoverage(g, new Set());
    expect(none.rootSatisfied).toBe(false);
    expect([...none.unmetAttributes].sort()).toEqual(
      ['wine_type_red', 'wine_type_white'],
    );
  });

  it('Nested group_and over group_or: inner OR satisfied, outer AND still needs the second slot', () => {
    const g = graph('root', [
      { kind: 'group_and', nodeId: 'root', children: ['or1', 's3'] },
      { kind: 'group_or', nodeId: 'or1', children: ['s1', 's2'] },
      slot('s1', 'region_bordeaux'),
      slot('s2', 'region_burgundy'),
      slot('s3', 'price_usd'),
    ]);
    const bordeauxOnly = computeGraphCoverage(g, new Set(['region_bordeaux']));
    expect(bordeauxOnly.rootSatisfied).toBe(false);
    // inner OR is satisfied by region_bordeaux; price_usd remains unmet.
    expect([...bordeauxOnly.matchedAttributes].sort()).toEqual(['region_bordeaux']);
    expect([...bordeauxOnly.unmetAttributes]).toEqual(['price_usd']);
    expect(bordeauxOnly.coverageRatio).toBeCloseTo(1 / 2);

    const both = computeGraphCoverage(
      g,
      new Set(['region_burgundy', 'price_usd']),
    );
    expect(both.rootSatisfied).toBe(true);
    expect(both.coverageRatio).toBe(1);
  });

  it('dangling child id is silently skipped (malformed graph tolerant)', () => {
    const g = graph('root', [
      { kind: 'group_and', nodeId: 'root', children: ['s1', 'dangling'] },
      slot('s1', 'wine_type'),
    ]);
    const r = computeGraphCoverage(g, new Set(['wine_type']));
    // The real child is matched; the dangling reference contributes nothing.
    expect(r.rootSatisfied).toBe(true);
    expect(r.matchedAttributes).toEqual(['wine_type']);
    expect(r.unmetAttributes).toEqual([]);
  });

  it('Missing rootNodeId falls back to "trivially covered"', () => {
    const g: ConstraintGraph = {
      graphSchemaVersion: 'constraint_graph_v1',
      origin: 'deterministic_from_atoms',
      rootNodeId: 'nonexistent',
      nodes: [slot('s1', 'wine_type')],
      edges: [],
      globalBudgets: {},
    };
    const r = computeGraphCoverage(g, new Set());
    expect(r.coverageRatio).toBe(1);
    expect(r.rootSatisfied).toBe(true);
  });

  it('matchedAttributes deduplicates on attribute name (not node id)', () => {
    // Two slots with the same attribute (e.g. "region" appearing twice) — the
    // flat attribute response shape must not double-count.
    const g = graph('root', [
      { kind: 'group_and', nodeId: 'root', children: ['s1', 's2'] },
      slot('s1', 'region'),
      slot('s2', 'region'),
    ]);
    const r = computeGraphCoverage(g, new Set(['region']));
    expect(r.matchedAttributes).toEqual(['region']);
    // Both slot nodes are matched (coverage arithmetic is node-based).
    expect(r.matchedNodeIds).toHaveLength(2);
    expect(r.coverageRatio).toBe(1);
  });

  it('single-slot root (not wrapped in a group) is treated as AND-of-one', () => {
    const g: ConstraintGraph = {
      graphSchemaVersion: 'constraint_graph_v1',
      origin: 'deterministic_from_atoms',
      rootNodeId: 's1',
      nodes: [slot('s1', 'wine_type')],
      edges: [],
      globalBudgets: {},
    };
    const matched = computeGraphCoverage(g, new Set(['wine_type']));
    expect(matched.rootSatisfied).toBe(true);
    expect(matched.coverageRatio).toBe(1);

    const unmet = computeGraphCoverage(g, new Set());
    expect(unmet.rootSatisfied).toBe(false);
    expect(unmet.coverageRatio).toBe(0);
    expect(unmet.unmetAttributes).toEqual(['wine_type']);
  });

  it('deterministic: identical input yields byte-identical matched/unmet ordering', () => {
    const g = graph('root', [
      { kind: 'group_and', nodeId: 'root', children: ['s1', 's2', 's3'] },
      slot('s1', 'wine_type'),
      slot('s2', 'region'),
      slot('s3', 'price_usd'),
    ]);
    const a = computeGraphCoverage(g, new Set(['wine_type', 'price_usd']));
    const b = computeGraphCoverage(g, new Set(['wine_type', 'price_usd']));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
