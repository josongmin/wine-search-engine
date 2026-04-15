import { describe, expect, it } from 'vitest';
import type { ConstraintGraph } from '../../model/constraint-graph.js';
import { collectApplicableSlotIdsForSubquery } from '../subquery-slot-scope.js';

function multiParentGraph(): ConstraintGraph {
  return {
    graphSchemaVersion: 'constraint_graph_v1.1',
    origin: 'hybrid',
    rootNodeId: 'root',
    nodes: [
      { kind: 'group_and', nodeId: 'root', children: ['left_scope', 'right_scope'] },
      { kind: 'group_and', nodeId: 'left_scope', children: ['sq_left', 'slot_shared'] },
      { kind: 'group_and', nodeId: 'right_scope', children: ['sq_right', 'slot_shared'] },
      { kind: 'subquery', nodeId: 'sq_left', purpose: 'left', targetCardinality: 1 },
      { kind: 'subquery', nodeId: 'sq_right', purpose: 'right', targetCardinality: 1 },
      {
        kind: 'slot',
        nodeId: 'slot_shared',
        atomRef: 'slot_shared',
        attribute: 'region',
        operator: '=',
        value: 'Bordeaux',
        sourceTier: 'hard',
        sourceKind: 'explicit_utterance',
        confidence: 1,
      },
    ],
    edges: [],
    globalBudgets: {},
  };
}

describe('subquery slot scope', () => {
  it('unions applicability across multiple parent paths in a DAG', () => {
    const graph = multiParentGraph();

    expect(collectApplicableSlotIdsForSubquery(graph, 'sq_left')).toEqual(
      new Set(['slot_shared']),
    );
    expect(collectApplicableSlotIdsForSubquery(graph, 'sq_right')).toEqual(
      new Set(['slot_shared']),
    );
  });
});
