import { describe, it, expect } from 'vitest';
import { ConstraintSAT } from '../constraint-sat.js';
import type { ConstraintBundle, NormalizedConstraint } from '../../../shared/types/index.js';

function makeBundle(hard: NormalizedConstraint[]): ConstraintBundle {
  return { hard, soft: [], inferred: [] };
}

function constraint(
  attribute: string,
  operator: NormalizedConstraint['operator'],
  value: NormalizedConstraint['value'],
): NormalizedConstraint {
  return { attribute, operator, value, source_phrase: '', confidence: 1 };
}

describe('ConstraintSAT', () => {
  const sat = new ConstraintSAT();

  it('"dry" + "sweet" on sweetness → contradicted', () => {
    const bundle = makeBundle([
      constraint('sweetness', '=', 'dry'),
      constraint('sweetness', '=', 'sweet'),
    ]);
    const result = sat.check(bundle);
    expect(result.contradicted).toBe(true);
  });

  it('price <= 10000 + price >= 50000 → contradicted', () => {
    const bundle = makeBundle([
      constraint('price', '<=', 10000),
      constraint('price', '>=', 50000),
    ]);
    const result = sat.check(bundle);
    expect(result.contradicted).toBe(true);
  });

  it('color = red + color = white → contradicted', () => {
    const bundle = makeBundle([
      constraint('color', '=', 'red'),
      constraint('color', '=', 'white'),
    ]);
    const result = sat.check(bundle);
    expect(result.contradicted).toBe(true);
  });

  it('different attributes → no contradiction', () => {
    const bundle = makeBundle([
      constraint('color', '=', 'red'),
      constraint('sweetness', '=', 'dry'),
    ]);
    const result = sat.check(bundle);
    expect(result.contradicted).toBe(false);
  });

  it('empty constraints → no contradiction', () => {
    const bundle = makeBundle([]);
    const result = sat.check(bundle);
    expect(result.contradicted).toBe(false);
  });

  // range vs range
  it('vintage range 2000-2010 AND 2015-2020 → contradicted (disjoint)', () => {
    const bundle = makeBundle([
      constraint('vintage', 'range', { min: 2000, max: 2010 }),
      constraint('vintage', 'range', { min: 2015, max: 2020 }),
    ]);
    const result = sat.check(bundle);
    expect(result.contradicted).toBe(true);
  });

  it('vintage range 2000-2015 AND 2010-2020 → not contradicted (overlapping)', () => {
    const bundle = makeBundle([
      constraint('vintage', 'range', { min: 2000, max: 2015 }),
      constraint('vintage', 'range', { min: 2010, max: 2020 }),
    ]);
    const result = sat.check(bundle);
    expect(result.contradicted).toBe(false);
  });

  // symmetric: >= vs range
  it('vintage >= 2021 AND vintage range 2000-2010 → contradicted (>= vs range, b has range)', () => {
    const bundle = makeBundle([
      constraint('vintage', '>=', 2021),
      constraint('vintage', 'range', { min: 2000, max: 2010 }),
    ]);
    const result = sat.check(bundle);
    expect(result.contradicted).toBe(true);
  });

  it('vintage >= 2005 AND vintage range 2000-2010 → not contradicted (>= within range)', () => {
    const bundle = makeBundle([
      constraint('vintage', '>=', 2005),
      constraint('vintage', 'range', { min: 2000, max: 2010 }),
    ]);
    const result = sat.check(bundle);
    expect(result.contradicted).toBe(false);
  });

  // symmetric: <= vs range
  it('vintage <= 1999 AND vintage range 2000-2010 → contradicted (<= vs range, b has range)', () => {
    const bundle = makeBundle([
      constraint('vintage', '<=', 1999),
      constraint('vintage', 'range', { min: 2000, max: 2010 }),
    ]);
    const result = sat.check(bundle);
    expect(result.contradicted).toBe(true);
  });

  it('vintage <= 2008 AND vintage range 2000-2010 → not contradicted (<= within range)', () => {
    const bundle = makeBundle([
      constraint('vintage', '<=', 2008),
      constraint('vintage', 'range', { min: 2000, max: 2010 }),
    ]);
    const result = sat.check(bundle);
    expect(result.contradicted).toBe(false);
  });
});
