import type { NormalizedConstraint, ConstraintBundle } from '../../shared/types/index.js';

export type ContradictionResult =
  | { contradicted: false }
  | { contradicted: true; conflictPairs: Array<[NormalizedConstraint, NormalizedConstraint]> };

/**
 * Detects logically contradictory hard constraints BEFORE retrieval.
 *
 * Runs a lightweight pairwise check over the hard-constraint set to catch
 * contradictions like "price <= 20 AND price >= 50" or "color = red AND color = white".
 * Stateless — safe to instantiate inline without DI.
 */
export class ConstraintSAT {
  check(constraints: ConstraintBundle): ContradictionResult {
    const hard = constraints.hard;
    const conflicts: Array<[NormalizedConstraint, NormalizedConstraint]> = [];
    for (let i = 0; i < hard.length; i++) {
      for (let j = i + 1; j < hard.length; j++) {
        const a = hard[i];
        const b = hard[j];
        if (a && b && this.contradicts(a, b)) {
          conflicts.push([a, b]);
        }
      }
    }
    if (conflicts.length === 0) return { contradicted: false };
    return { contradicted: true, conflictPairs: conflicts };
  }

  private contradicts(a: NormalizedConstraint, b: NormalizedConstraint): boolean {
    if (a.attribute !== b.attribute) return false;
    return this.rangesDisjoint(a, b) || this.enumValuesDisjoint(a, b);
  }

  private rangesDisjoint(a: NormalizedConstraint, b: NormalizedConstraint): boolean {
    if (a.operator === '<=' && b.operator === '>=') return Number(a.value) < Number(b.value);
    if (a.operator === '>=' && b.operator === '<=') return Number(a.value) > Number(b.value);
    if (a.operator === 'range' && b.operator === '>=') {
      const range = a.value as { min: number; max: number };
      return Number(b.value) > range.max;
    }
    if (a.operator === 'range' && b.operator === '<=') {
      const range = a.value as { min: number; max: number };
      return Number(b.value) < range.min;
    }
    // Symmetric: >= vs range, <= vs range
    if (a.operator === '>=' && b.operator === 'range') {
      const range = b.value as { min: number; max: number };
      return Number(a.value) > range.max;
    }
    if (a.operator === '<=' && b.operator === 'range') {
      const range = b.value as { min: number; max: number };
      return Number(a.value) < range.min;
    }
    // range vs range: disjoint when the two intervals do not overlap
    if (a.operator === 'range' && b.operator === 'range') {
      const ra = a.value as { min: number; max: number };
      const rb = b.value as { min: number; max: number };
      return ra.max < rb.min || rb.max < ra.min;
    }
    return false;
  }

  private enumValuesDisjoint(a: NormalizedConstraint, b: NormalizedConstraint): boolean {
    if (a.operator !== '=' || b.operator !== '=') return false;
    const MUTUALLY_EXCLUSIVE: Record<string, string[][]> = {
      sweetness: [['dry', 'brut'], ['sweet', 'demi-sec', 'doux', 'dolce']],
      color: [['red'], ['white'], ['rosé', 'rose']],
    };
    const groups = MUTUALLY_EXCLUSIVE[a.attribute];
    if (!groups) return false;
    const aVal = typeof a.value === 'string' ? a.value : '';
    const bVal = typeof b.value === 'string' ? b.value : '';
    if (aVal === '' || bVal === '') return false;
    const aGroup = groups.findIndex((g) => g.includes(aVal));
    const bGroup = groups.findIndex((g) => g.includes(bVal));
    return aGroup !== -1 && bGroup !== -1 && aGroup !== bGroup;
  }
}
