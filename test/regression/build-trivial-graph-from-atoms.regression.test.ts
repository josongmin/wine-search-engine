/**
 * ADR-010 Phase 1a: deterministic projector invariants.
 *
 * - one `group_and` root node, every atom as a `slot` child
 * - byte-identical output for identical input (across processes)
 * - `slot.atomRef` resolvable back to the source atom
 * - empty edges, empty globalBudgets (Phase 1a scope)
 * - `origin` tagged `deterministic_from_atoms`
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import {
  buildTrivialGraphFromAtoms,
} from '../../src/domain/query/service/build-trivial-graph-from-atoms.js';
import {
  ConstraintGraphSchema,
  graphSlotNodes,
  resolveAtomForSlot,
} from '../../src/domain/query/model/constraint-graph.js';
import {
  liftBundleToAtoms,
} from '../../src/domain/shared/types/constraint-atom.js';
import type { ConstraintBundle } from '../../src/domain/shared/types/constraint-bundle.js';

const BUNDLE: ConstraintBundle = {
  hard: [
    {
      attribute: 'wine_type',
      operator: '=',
      value: 'red',
      source_phrase: 'red',
      confidence: 1,
    },
  ],
  soft: [
    {
      attribute: 'region',
      operator: '=',
      value: 'Bordeaux',
      source_phrase: 'Bordeaux',
      confidence: 0.8,
    },
  ],
  inferred: [],
};

describe('buildTrivialGraphFromAtoms', () => {
  it('returns a schema-valid graph', () => {
    const atoms = liftBundleToAtoms(BUNDLE);
    const graph = buildTrivialGraphFromAtoms(atoms);
    const parsed = ConstraintGraphSchema.safeParse(graph);
    expect(parsed.success).toBe(true);
  });

  it('has exactly one group_and root and one slot node per atom', () => {
    const atoms = liftBundleToAtoms(BUNDLE);
    const graph = buildTrivialGraphFromAtoms(atoms);
    const roots = graph.nodes.filter((n) => n.kind === 'group_and');
    expect(roots).toHaveLength(1);
    expect(roots[0]!.nodeId).toBe(graph.rootNodeId);
    expect(graphSlotNodes(graph)).toHaveLength(atoms.length);
  });

  it('origin is deterministic_from_atoms', () => {
    const graph = buildTrivialGraphFromAtoms(liftBundleToAtoms(BUNDLE));
    expect(graph.origin).toBe('deterministic_from_atoms');
  });

  it('produces byte-identical output for identical input', () => {
    const a = buildTrivialGraphFromAtoms(liftBundleToAtoms(BUNDLE));
    const b = buildTrivialGraphFromAtoms(liftBundleToAtoms(BUNDLE));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('slot.atomRef resolves back to the source atom', () => {
    const atoms = liftBundleToAtoms(BUNDLE);
    const graph = buildTrivialGraphFromAtoms(atoms);
    for (const slot of graphSlotNodes(graph)) {
      const atom = resolveAtomForSlot(slot, atoms);
      expect(atom).toBeDefined();
      expect(atom?.attribute).toBe(slot.attribute);
      expect(atom?.operator).toBe(slot.operator);
      expect(atom?.source_tier).toBe(slot.sourceTier);
    }
  });

  it('Phase 1a graph has no edges and empty globalBudgets', () => {
    const graph = buildTrivialGraphFromAtoms(liftBundleToAtoms(BUNDLE));
    expect(graph.edges).toEqual([]);
    expect(graph.globalBudgets).toEqual({});
  });

  it('handles an empty atom list (edge-case scenarios)', () => {
    const graph = buildTrivialGraphFromAtoms([]);
    expect(ConstraintGraphSchema.safeParse(graph).success).toBe(true);
    expect(graphSlotNodes(graph)).toEqual([]);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]!.kind).toBe('group_and');
  });

  it('different atom order produces different rootNodeId (determinism contract)', () => {
    const atoms = liftBundleToAtoms(BUNDLE);
    const reversed = [...atoms].reverse();
    const a = buildTrivialGraphFromAtoms(atoms);
    const b = buildTrivialGraphFromAtoms(reversed);
    // Different slot order → different rootNodeId fingerprint.
    expect(a.rootNodeId).not.toBe(b.rootNodeId);
    // Slot node IDs themselves are stable regardless of order — they depend
    // on attribute/operator/value, not position. But `atomRef` differs
    // because it is the position.
    const aRefs = graphSlotNodes(a).map((s) => s.atomRef).sort();
    const bRefs = graphSlotNodes(b).map((s) => s.atomRef).sort();
    expect(aRefs).toEqual(bRefs);
  });
});
