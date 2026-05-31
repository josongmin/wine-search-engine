/**
 * Cascade-router 'easy' (sparse-only) route is graph-gated and prod-unwired.
 *
 * History: a prior change (W4) made the graph-aware path route andDepth===0
 * queries to 'easy' (sparse-only) via a CASCADE_EASY_THRESHOLD constant. That
 * was reverted because:
 *   (a) it dropped dense recall for a whole class of OR-heavy / zero-AND
 *       constraint queries with no offsetting recall justification, and
 *   (b) it was unreachable in production anyway — the sole prod caller
 *       (candidate-pool.ts getDispatchDecision) does NOT pass a ConstraintGraph,
 *       so the graph-aware branch never executes at all.
 *
 * Invariant now asserted (reverse-logic guard — if someone re-introduces the
 * sparse-only easy route on the below-hard graph branch, these expectations
 * break):
 *   - OR-heavy / andDepth=0 graph queries route 'medium' (sparse + dense),
 *     NOT 'easy'. Dense recall is preserved.
 *   - The 'medium' dispatch keeps the dense channel; it does not collapse to a
 *     sparse-only channel set.
 *   - AND-heavy graphs still route 'hard'; the [easy,hard) band stays 'medium'.
 *   - High-confidence anchored_similarity still short-circuits to 'medium'.
 *
 * The 'easy' difficulty itself still exists (getPhases('easy') === ['sparse'])
 * but has no live prod entry point; reaching it requires a future graph-gated
 * caller validated against a recall benchmark.
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

describe('CascadeRouter — below-hard graph route keeps dense recall (no sparse-only easy)', () => {
  it('OR-heavy / no-AND graph (complexity < hard threshold) → medium (sparse + dense), NOT easy', () => {
    // andDepth=0, orBreadth=3 → effectiveComplexity = -0.7*log(4) ≈ -0.97.
    // Pre-revert this returned 'easy'; the conservative route keeps 'medium'
    // so dense recall is not dropped for OR-heavy constraint queries.
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
    expect(router.estimateDifficulty('pure_constraint', 0, 0, 3, graph)).toBe('medium');
  });

  it('OR-heavy dispatch keeps the dense channel (NOT a sparse-only channel set)', () => {
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
    expect(decision.difficulty).toBe('medium');
    expect(decision.channelsToActivate).toContain('sparse_bm25');
    // Dense recall preserved — this is the regression guard.
    expect(decision.channelsToActivate).toContain('dense_semantic');
    // Still below 'hard', so anchor ANN stays off.
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
    // andDepth=2, orBreadth=0 → effectiveComplexity = 2.0, in [1.0, 3.0).
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

  it("'easy' difficulty still maps to the sparse-only phase set (route exists but is prod-unwired)", () => {
    // The difficulty level itself is unchanged; only the graph-aware *entry*
    // to it was removed. getPhases('easy') must stay sparse-only.
    expect(router.getPhases('easy')).toEqual(['sparse']);
  });
});
