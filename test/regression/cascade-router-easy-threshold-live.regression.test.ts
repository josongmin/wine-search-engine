/**
 * Cascade-router CASCADE_EASY_THRESHOLD live-branch regression.
 *
 * Bug: in the graph-aware path of `estimateDifficulty`, the
 * `effectiveComplexity < CASCADE_EASY_THRESHOLD` branch returned 'medium'
 * in BOTH of its sub-branches AND the fall-through also returned 'medium'.
 * The threshold check therefore produced no distinct outcome — it was a
 * dead branch and `CASCADE_EASY_THRESHOLD` was an unauditable dead constant.
 *
 * Fix: an OR-heavy / no-AND query (effectiveComplexity below the easy
 * threshold) expands the candidate set, so the documented cascade design
 * ("Easy: sparse only") routes it to 'easy'. AND-heavy queries (>= hard
 * threshold) still route 'hard'; queries in the band between easy and hard
 * thresholds still route 'medium'.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { CascadeRouter } from '../../src/domain/retrieval/service/cascade-router.js';
import type {
  ConstraintGraph,
  ConstraintGraphNode,
} from '../../src/domain/query/model/constraint-graph.js';

const router = new CascadeRouter();

function makeGraph(nodes: readonly ConstraintGraphNode[], rootId: string): ConstraintGraph {
  return {
    graphSchemaVersion: 'constraint_graph_v1',
    origin: 'deterministic_from_atoms',
    rootNodeId: rootId,
    nodes,
    edges: [],
    globalBudgets: {},
  };
}

function slot(nodeId: string, attribute: string): ConstraintGraphNode {
  return {
    kind: 'slot',
    nodeId,
    atomRef: '0',
    attribute,
    operator: '=',
    value: 'x',
    sourceTier: 'hard',
    sourceKind: 'explicit_utterance',
    confidence: 1,
  };
}

describe('CascadeRouter — CASCADE_EASY_THRESHOLD drives an "easy" outcome', () => {
  it('OR-heavy / no-AND graph (complexity < easy threshold) → easy (sparse only)', () => {
    // andDepth=0, orBreadth=3 → effectiveComplexity = -0.7*log(4) ≈ -0.97 < 1.0
    const graph = makeGraph(
      [
        { kind: 'group_and', nodeId: 'root', children: ['or1'] },
        { kind: 'group_or', nodeId: 'or1', children: ['s1', 's2', 's3'] },
        slot('s1', 'colour'),
        slot('s2', 'colour'),
        slot('s3', 'colour'),
      ],
      'root',
    );
    expect(router.estimateDifficulty('pure_constraint', 0, 0, 3, graph)).toBe('easy');
  });

  it('easy outcome dispatches sparse-only channel set (no dense/anchor)', () => {
    const graph = makeGraph(
      [
        { kind: 'group_and', nodeId: 'root', children: ['or1'] },
        { kind: 'group_or', nodeId: 'or1', children: ['s1', 's2', 's3'] },
        slot('s1', 'colour'),
        slot('s2', 'colour'),
        slot('s3', 'colour'),
      ],
      'root',
    );
    const decision = router.getDispatchDecision('pure_constraint', 0, 0, 3, graph);
    expect(decision.difficulty).toBe('easy');
    expect(decision.channelsToActivate).toContain('sparse_bm25');
    expect(decision.channelsToActivate).not.toContain('dense_semantic');
    expect(decision.channelsToActivate).not.toContain('anchor_similarity');
  });

  it('adjacent: AND-3 (>= hard threshold) still routes hard', () => {
    const graph = makeGraph(
      [
        { kind: 'group_and', nodeId: 'root', children: ['s1', 's2', 's3'] },
        slot('s1', 'a'),
        slot('s2', 'b'),
        slot('s3', 'c'),
      ],
      'root',
    );
    expect(router.estimateDifficulty('pure_constraint', 0, 0, 3, graph)).toBe('hard');
  });

  it('adjacent: complexity in the [easy, hard) band → medium', () => {
    // andDepth=2, orBreadth=0 → effectiveComplexity = 2.0, which is
    // >= CASCADE_EASY_THRESHOLD (1.0) and < CASCADE_HARD_THRESHOLD (3.0).
    const graph = makeGraph(
      [
        { kind: 'group_and', nodeId: 'root', children: ['s1', 's2'] },
        slot('s1', 'a'),
        slot('s2', 'b'),
      ],
      'root',
    );
    expect(router.estimateDifficulty('pure_constraint', 0, 0, 2, graph)).toBe('medium');
  });

  it('adjacent: anchored_similarity high-confidence still short-circuits to medium', () => {
    const graph = makeGraph(
      [
        { kind: 'group_and', nodeId: 'root', children: ['or1'] },
        { kind: 'group_or', nodeId: 'or1', children: ['s1', 's2', 's3'] },
        slot('s1', 'colour'),
        slot('s2', 'colour'),
        slot('s3', 'colour'),
      ],
      'root',
    );
    expect(router.estimateDifficulty('anchored_similarity', 0.9, 0, 3, graph)).toBe('medium');
  });
});
