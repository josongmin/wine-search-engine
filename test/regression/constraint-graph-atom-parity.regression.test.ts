/**
 * ADR-010 Phase 1a: the trivial graph preserves atom semantics exactly.
 * Slot nodes project atom fields 1:1; no information lost in the
 * atoms → graph projection.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import {
  buildTrivialGraphFromAtoms,
} from '../../src/domain/query/service/build-trivial-graph-from-atoms.js';
import {
  graphSlotNodes,
  resolveAtomForSlot,
} from '../../src/domain/query/model/constraint-graph.js';
import {
  liftBundleToAtoms,
} from '../../src/domain/shared/types/constraint-atom.js';
import type { ConstraintBundle } from '../../src/domain/shared/types/constraint-bundle.js';

const COMPLEX_BUNDLE: ConstraintBundle = {
  hard: [
    { attribute: 'wine_type', operator: '=', value: 'red', source_phrase: 'red', confidence: 1 },
    { attribute: 'price_usd', operator: '<=', value: 100, source_phrase: 'under $100', confidence: 1 },
  ],
  soft: [
    { attribute: 'region', operator: '=', value: 'Bordeaux', source_phrase: 'Bordeaux', confidence: 0.8 },
    { attribute: 'grape_primary', operator: 'in', value: ['Cabernet Sauvignon', 'Merlot'], source_phrase: 'cab or merlot', confidence: 0.7 },
  ],
  inferred: [
    { attribute: 'vintage_year', operator: 'range', value: { min: 2015, max: 2020 }, source_phrase: 'recent', confidence: 0.4 },
  ],
};

describe('atom → slot projection parity', () => {
  const atoms = liftBundleToAtoms(COMPLEX_BUNDLE);
  const graph = buildTrivialGraphFromAtoms(atoms);
  const slots = graphSlotNodes(graph);

  it('slot count equals atom count', () => {
    expect(slots).toHaveLength(atoms.length);
  });

  it('every slot field matches its source atom', () => {
    for (const slot of slots) {
      const atom = resolveAtomForSlot(slot, atoms);
      expect(atom).toBeDefined();
      if (atom === undefined) continue;
      expect(slot.attribute).toBe(atom.attribute);
      expect(slot.operator).toBe(atom.operator);
      expect(slot.sourceTier).toBe(atom.source_tier);
      expect(slot.sourceKind).toBe(atom.source_kind);
      expect(slot.confidence).toBe(atom.confidence);
    }
  });

  it('atom values are preserved across all SlotValue variants (string | number | array | range)', () => {
    const byAttribute = new Map<string, typeof slots[number]>();
    for (const slot of slots) byAttribute.set(slot.attribute, slot);

    expect(byAttribute.get('wine_type')?.value).toBe('red');
    expect(byAttribute.get('price_usd')?.value).toBe(100);
    expect(byAttribute.get('grape_primary')?.value).toEqual(['Cabernet Sauvignon', 'Merlot']);
    expect(byAttribute.get('vintage_year')?.value).toEqual({ min: 2015, max: 2020 });
  });

  it('tier distribution in slots matches atom tiers', () => {
    const tierCounts: Record<string, number> = {};
    for (const slot of slots) {
      tierCounts[slot.sourceTier] = (tierCounts[slot.sourceTier] ?? 0) + 1;
    }
    expect(tierCounts['hard']).toBe(COMPLEX_BUNDLE.hard.length);
    expect(tierCounts['soft']).toBe(COMPLEX_BUNDLE.soft.length);
    expect(tierCounts['inferred']).toBe(COMPLEX_BUNDLE.inferred.length);
  });

  it('root group_and includes every slot as a child', () => {
    const root = graph.nodes.find((n) => n.kind === 'group_and');
    expect(root).toBeDefined();
    if (root?.kind !== 'group_and') return;
    const slotIds = new Set(slots.map((s) => s.nodeId));
    for (const childId of root.children) {
      expect(slotIds.has(childId)).toBe(true);
    }
    expect(root.children).toHaveLength(slots.length);
  });
});
