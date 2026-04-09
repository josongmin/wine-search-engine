import type { NormalizedConstraint, ConstraintBundle } from '../../shared/types/index.js';
import { WINE_TYPE_EXCLUSIVITY_GROUPS } from '../model/wine-type-patterns.js';

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
    const numVal = (c: NormalizedConstraint): number | undefined => {
      const n = typeof c.value === 'number' ? c.value : Number(c.value);
      return Number.isFinite(n) ? n : undefined;
    };
    const rangeVal = (c: NormalizedConstraint): { min: number; max: number } | undefined => {
      const v: unknown = c.value;
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
      const r = v as Record<string, unknown>;
      if (typeof r['min'] !== 'number' || typeof r['max'] !== 'number') return undefined;
      return { min: r['min'], max: r['max'] };
    };

    if (a.operator === '<=' && b.operator === '>=') {
      const av = numVal(a), bv = numVal(b);
      return av !== undefined && bv !== undefined && av < bv;
    }
    if (a.operator === '>=' && b.operator === '<=') {
      const av = numVal(a), bv = numVal(b);
      return av !== undefined && bv !== undefined && av > bv;
    }
    if (a.operator === 'range' && b.operator === '>=') {
      const range = rangeVal(a), bv = numVal(b);
      return range !== undefined && bv !== undefined && bv > range.max;
    }
    if (a.operator === 'range' && b.operator === '<=') {
      const range = rangeVal(a), bv = numVal(b);
      return range !== undefined && bv !== undefined && bv < range.min;
    }
    if (a.operator === '>=' && b.operator === 'range') {
      const av = numVal(a), range = rangeVal(b);
      return av !== undefined && range !== undefined && av > range.max;
    }
    if (a.operator === '<=' && b.operator === 'range') {
      const av = numVal(a), range = rangeVal(b);
      return av !== undefined && range !== undefined && av < range.min;
    }
    if (a.operator === 'range' && b.operator === 'range') {
      const ra = rangeVal(a), rb = rangeVal(b);
      return ra !== undefined && rb !== undefined && (ra.max < rb.min || rb.max < ra.min);
    }
    return false;
  }

  private enumValuesDisjoint(a: NormalizedConstraint, b: NormalizedConstraint): boolean {
    if (a.operator !== '=' || b.operator !== '=') return false;
    const MUTUALLY_EXCLUSIVE: Record<string, readonly (readonly string[])[]> = {
      sweetness: [['dry', 'brut'], ['sweet', 'demi-sec', 'doux', 'dolce']],
      color: [['red'], ['white'], ['rosé', 'rose']],
      wine_type: WINE_TYPE_EXCLUSIVITY_GROUPS,
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
