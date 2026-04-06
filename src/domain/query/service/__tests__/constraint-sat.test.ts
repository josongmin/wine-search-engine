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
});
