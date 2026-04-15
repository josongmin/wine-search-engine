/**
 * ADR-010 Phase 1a: ConstraintGraph schema contract.
 *
 * Locks the graph envelope invariants: schema-version pinned, closed node
 * and edge unions, strict object validation.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import {
  CONSTRAINT_GRAPH_SCHEMA_VERSION,
  ConstraintGraphSchema,
  type ConstraintGraph,
} from '../../src/domain/query/model/constraint-graph.js';

function minimalGraph(): ConstraintGraph {
  return {
    graphSchemaVersion: 'constraint_graph_v1',
    origin: 'deterministic_from_atoms',
    rootNodeId: 'root-and-abc',
    nodes: [{ kind: 'group_and', nodeId: 'root-and-abc', children: [] }],
    edges: [],
    globalBudgets: {},
  };
}

describe('ConstraintGraph schema', () => {
  it('schema version is pinned to constraint_graph_v1', () => {
    expect(CONSTRAINT_GRAPH_SCHEMA_VERSION).toBe('constraint_graph_v1');
  });

  it('accepts a minimal empty trivial graph', () => {
    const parsed = ConstraintGraphSchema.safeParse(minimalGraph());
    expect(parsed.success).toBe(true);
  });

  it('rejects unknown graphSchemaVersion strings', () => {
    const bad = { ...minimalGraph(), graphSchemaVersion: 'constraint_graph_v99' };
    expect(ConstraintGraphSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects unknown origin values', () => {
    const bad = { ...minimalGraph(), origin: 'summoned_from_the_void' };
    expect(ConstraintGraphSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects nodes with an unknown kind', () => {
    const bad = {
      ...minimalGraph(),
      nodes: [{ kind: 'ungrounded_telepathy', nodeId: 'n' }],
    };
    expect(ConstraintGraphSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects edges with an unknown kind', () => {
    const bad = {
      ...minimalGraph(),
      edges: [{ kind: 'entangles', from: 'a', to: 'b' }],
    };
    expect(ConstraintGraphSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts every canonical node kind', () => {
    const g: ConstraintGraph = {
      graphSchemaVersion: 'constraint_graph_v1',
      origin: 'deterministic_from_atoms',
      rootNodeId: 'r',
      nodes: [
        { kind: 'group_and', nodeId: 'r', children: ['sq', 'or', 'xor', 's'] },
        { kind: 'subquery', nodeId: 'sq', purpose: 'appetiser', targetCardinality: 1 },
        { kind: 'group_or', nodeId: 'or', children: [] },
        { kind: 'group_xor', nodeId: 'xor', children: [] },
        {
          kind: 'slot',
          nodeId: 's',
          atomRef: '0',
          attribute: 'wine_type',
          operator: '=',
          value: 'red',
          sourceTier: 'hard',
          sourceKind: 'explicit_utterance',
          confidence: 1,
        },
      ],
      edges: [
        { kind: 'shares_budget', from: 'sq', to: 'sq', resource: 'price_total' },
        { kind: 'complements', from: 'sq', to: 'sq', reason: 'meal_course' },
        { kind: 'depends_on', from: 'sq', to: 'sq' },
      ],
      globalBudgets: { priceTotal: { currency: 'KRW', max: 150_000 } },
    };
    expect(ConstraintGraphSchema.safeParse(g).success).toBe(true);
  });

  it('rejects slot with confidence outside [0, 1]', () => {
    const g: ConstraintGraph = {
      ...minimalGraph(),
      nodes: [
        { kind: 'group_and', nodeId: 'r', children: ['s'] },
        {
          kind: 'slot',
          nodeId: 's',
          atomRef: '0',
          attribute: 'x',
          operator: '=',
          value: 'y',
          sourceTier: 'hard',
          sourceKind: 'explicit_utterance',
          confidence: 1.5,
        },
      ],
      rootNodeId: 'r',
    };
    expect(ConstraintGraphSchema.safeParse(g).success).toBe(false);
  });
});
