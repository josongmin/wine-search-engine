/**
 * Cascade-router AND/OR semantics regression.
 *
 * Locks the difficulty estimation behavior when a ConstraintGraph is
 * supplied: the legacy flat `constraintCount` heuristic treated
 *   "red AND Bordeaux AND dry" (3 ANDs — candidates collapse, hard)
 * identically to
 *   "red OR white OR rosé" (3 ORs — candidates expand, easy/medium).
 *
 * With the graph-aware path enabled:
 *   effectiveComplexity = andDepth - LOG_FACTOR * log(1 + orBreadth)
 * AND-heavy queries route 'hard'; OR-heavy queries route 'medium';
 * mixed queries land between.
 *
 * Backward-compat: the legacy count-based fallback is exercised when
 * no graph is supplied.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import {
  CascadeRouter,
  analyzeConstraintGraph,
} from '../../src/domain/retrieval/service/cascade-router.js';
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

describe('CascadeRouter — AND/OR semantics from ConstraintGraph', () => {
  describe('analyzeConstraintGraph', () => {
    it('empty graph (no slots) → andDepth=0, orBreadth=0', () => {
      const graph = makeGraph(
        [{ kind: 'group_and', nodeId: 'root', children: [] }],
        'root',
      );
      const a = analyzeConstraintGraph(graph);
      expect(a.andDepth).toBe(0);
      expect(a.orBreadth).toBe(0);
      expect(a.effectiveComplexity).toBe(0);
    });

    it('3 AND slots → andDepth=3, orBreadth=0', () => {
      const graph = makeGraph(
        [
          { kind: 'group_and', nodeId: 'root', children: ['s1', 's2', 's3'] },
          slot('s1', 'colour'),
          slot('s2', 'region'),
          slot('s3', 'style'),
        ],
        'root',
      );
      const a = analyzeConstraintGraph(graph);
      expect(a.andDepth).toBe(3);
      expect(a.orBreadth).toBe(0);
    });

    it('one OR group with 3 alternatives → andDepth=0, orBreadth=3', () => {
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
      const a = analyzeConstraintGraph(graph);
      expect(a.andDepth).toBe(0);
      expect(a.orBreadth).toBe(3);
    });

    it('mixed: 1 AND + 1 OR(2) → andDepth=1, orBreadth=2', () => {
      const graph = makeGraph(
        [
          { kind: 'group_and', nodeId: 'root', children: ['or1', 's_price'] },
          { kind: 'group_or', nodeId: 'or1', children: ['s1', 's2'] },
          slot('s1', 'variety'),
          slot('s2', 'variety'),
          slot('s_price', 'price'),
        ],
        'root',
      );
      const a = analyzeConstraintGraph(graph);
      expect(a.andDepth).toBe(1);
      expect(a.orBreadth).toBe(2);
    });
  });

  describe('estimateDifficulty (graph-aware path)', () => {
    it('AND 3 ("red AND Bordeaux AND dry") → hard', () => {
      const graph = makeGraph(
        [
          { kind: 'group_and', nodeId: 'root', children: ['s1', 's2', 's3'] },
          slot('s1', 'colour'),
          slot('s2', 'region'),
          slot('s3', 'style'),
        ],
        'root',
      );
      const difficulty = router.estimateDifficulty(
        'pure_constraint',
        0,
        0,
        3,
        graph,
      );
      expect(difficulty).toBe('hard');
    });

    it('OR 3 ("red OR white OR rosé") → medium (or easier than AND-3)', () => {
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
      const difficulty = router.estimateDifficulty(
        'pure_constraint',
        0,
        0,
        3,
        graph,
      );
      // Strict assertion: OR-heavy queries are explicitly NOT 'hard'.
      expect(difficulty).not.toBe('hard');
      expect(['easy', 'medium']).toContain(difficulty);
    });

    it('mixed ("(Cabernet OR Merlot) AND under-50") → medium', () => {
      const graph = makeGraph(
        [
          { kind: 'group_and', nodeId: 'root', children: ['or1', 's_price'] },
          { kind: 'group_or', nodeId: 'or1', children: ['s1', 's2'] },
          slot('s1', 'variety'),
          slot('s2', 'variety'),
          slot('s_price', 'price'),
        ],
        'root',
      );
      const difficulty = router.estimateDifficulty(
        'pure_constraint',
        0,
        0,
        3,
        graph,
      );
      expect(difficulty).toBe('medium');
    });

    it('andDepth=0, orBreadth=0 (empty graph) → not hard', () => {
      const graph = makeGraph(
        [{ kind: 'group_and', nodeId: 'root', children: [] }],
        'root',
      );
      const difficulty = router.estimateDifficulty(
        'pure_constraint',
        0,
        0,
        0,
        graph,
      );
      expect(difficulty).not.toBe('hard');
    });

    it('AND-5 (clearly above threshold) → hard regardless of small OR breadth', () => {
      const graph = makeGraph(
        [
          {
            kind: 'group_and',
            nodeId: 'root',
            children: ['s1', 's2', 's3', 's4', 's5'],
          },
          slot('s1', 'a'),
          slot('s2', 'b'),
          slot('s3', 'c'),
          slot('s4', 'd'),
          slot('s5', 'e'),
        ],
        'root',
      );
      const difficulty = router.estimateDifficulty(
        'pure_constraint',
        0,
        0,
        5,
        graph,
      );
      expect(difficulty).toBe('hard');
    });

    it('AND 3 ranks STRICTLY harder than OR 3 (same flat count)', () => {
      const andGraph = makeGraph(
        [
          { kind: 'group_and', nodeId: 'root', children: ['s1', 's2', 's3'] },
          slot('s1', 'colour'),
          slot('s2', 'region'),
          slot('s3', 'style'),
        ],
        'root',
      );
      const orGraph = makeGraph(
        [
          { kind: 'group_and', nodeId: 'root', children: ['or1'] },
          { kind: 'group_or', nodeId: 'or1', children: ['s1', 's2', 's3'] },
          slot('s1', 'colour'),
          slot('s2', 'colour'),
          slot('s3', 'colour'),
        ],
        'root',
      );
      const andDiff = router.estimateDifficulty(
        'pure_constraint',
        0,
        0,
        3,
        andGraph,
      );
      const orDiff = router.estimateDifficulty(
        'pure_constraint',
        0,
        0,
        3,
        orGraph,
      );
      // Order: easy < medium < hard.
      const rank: Record<'easy' | 'medium' | 'hard', number> = {
        easy: 0,
        medium: 1,
        hard: 2,
      };
      expect(rank[andDiff]).toBeGreaterThan(rank[orDiff]);
    });

    it('exact_entity with strong alias still routes easy (queryClass short-circuit precedence)', () => {
      const andGraph = makeGraph(
        [
          { kind: 'group_and', nodeId: 'root', children: ['s1', 's2', 's3'] },
          slot('s1', 'a'),
          slot('s2', 'b'),
          slot('s3', 'c'),
        ],
        'root',
      );
      // Strong alias hit should still win over a heavy AND graph: a
      // resolved entity collapses the search space regardless of
      // constraint topology.
      const difficulty = router.estimateDifficulty(
        'exact_entity',
        0,
        0.95,
        3,
        andGraph,
      );
      expect(difficulty).toBe('easy');
    });
  });

  describe('estimateDifficulty (legacy count-only fallback)', () => {
    it('no graph + constraintCount=5 + pure_constraint → hard (legacy behavior)', () => {
      expect(
        router.estimateDifficulty('pure_constraint', 0.5, 0.5, 5),
      ).toBe('hard');
    });

    it('no graph + constraintCount=3 + pure_constraint → medium (legacy behavior)', () => {
      expect(
        router.estimateDifficulty('pure_constraint', 0.5, 0.5, 3),
      ).toBe('medium');
    });

    it('no graph + anchored_similarity + constraintCount=1 → medium (legacy)', () => {
      expect(
        router.estimateDifficulty('anchored_similarity', 0.9, 0.5, 1),
      ).toBe('medium');
    });
  });

  describe('getDispatchDecision honors graph signal', () => {
    it('AND-heavy graph drives hard channel set', () => {
      const graph = makeGraph(
        [
          {
            kind: 'group_and',
            nodeId: 'root',
            children: ['s1', 's2', 's3', 's4'],
          },
          slot('s1', 'a'),
          slot('s2', 'b'),
          slot('s3', 'c'),
          slot('s4', 'd'),
        ],
        'root',
      );
      const decision = router.getDispatchDecision(
        'pure_constraint',
        0,
        0,
        4,
        graph,
      );
      expect(decision.difficulty).toBe('hard');
      expect(decision.channelsToActivate).toContain('anchor_similarity');
    });

    it('OR-heavy graph stays at medium channel set (no anchor_similarity)', () => {
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
      const decision = router.getDispatchDecision(
        'pure_constraint',
        0,
        0,
        3,
        graph,
      );
      expect(decision.difficulty).not.toBe('hard');
      expect(decision.channelsToActivate).not.toContain('anchor_similarity');
    });
  });
});
