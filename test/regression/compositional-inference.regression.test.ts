import { describe, it, expect } from 'vitest';
import { applyCompositionalInference } from '../../src/domain/attribute/service/compositional-inference.js';
import type { ConstraintBundle, NormalizedConstraint } from '../../src/domain/shared/types/constraint-bundle.js';

function eq(attribute: string, value: string): NormalizedConstraint {
  return {
    attribute,
    operator: '=',
    value,
    source_phrase: `test(${attribute}=${value})`,
    confidence: 0.95,
    mapping_version: 'test',
  };
}

function bundle(hard: NormalizedConstraint[], soft: NormalizedConstraint[] = []): ConstraintBundle {
  return { hard, soft, inferred: [] };
}

describe('RFC-019 regression: compositional inference', () => {
  it('Bordeaux + red infers grape_family and tannin', () => {
    const b = bundle([eq('region', 'Bordeaux'), eq('wine_type', 'red')]);
    const result = applyCompositionalInference(b);

    const grapeFamily = result.inferred.find(
      (c) => c.attribute === 'grape_family' && c.operator === 'in',
    );
    expect(grapeFamily).toBeDefined();
    expect(grapeFamily!.value).toEqual(expect.arrayContaining(['Cabernet', 'Merlot']));

    const tannin = result.inferred.find(
      (c) => c.attribute === 'tannin' && c.operator === '>=',
    );
    expect(tannin).toBeDefined();
    // Strengthen: verify the inferred tannin threshold is a positive number
    expect(tannin!.value).toBeTypeOf('number');
    expect(tannin!.value as number).toBeGreaterThan(0);
  });

  it('Burgundy + red infers grape_family Pinot', () => {
    const b = bundle([eq('region', 'Burgundy'), eq('wine_type', 'red')]);
    const result = applyCompositionalInference(b);

    const grapeFamily = result.inferred.find(
      (c) => c.attribute === 'grape_family' && c.operator === 'in',
    );
    expect(grapeFamily).toBeDefined();
    expect(grapeFamily!.value).toEqual(['Pinot']);
  });

  it('Champagne region infers sparkling wine_type and high acidity', () => {
    const b = bundle([eq('region', 'Champagne')]);
    const result = applyCompositionalInference(b);

    const sparkling = result.inferred.find(
      (c) => c.attribute === 'wine_type' && c.value === 'sparkling',
    );
    expect(sparkling).toBeDefined();
    expect(sparkling!.operator).toBe('=');

    const acidity = result.inferred.find(
      (c) => c.attribute === 'acidity' && c.operator === '>=',
    );
    expect(acidity).toBeDefined();
    // Strengthen: verify the inferred acidity threshold is a positive number
    expect(acidity!.value).toBeTypeOf('number');
    expect(acidity!.value as number).toBeGreaterThan(0);
  });

  it('no inference for unrecognized combination', () => {
    const b = bundle([eq('region', 'Atlantis'), eq('wine_type', 'red')]);
    const result = applyCompositionalInference(b);
    expect(result.inferred).toHaveLength(0);
  });

  it('preserves hard and soft constraints unchanged', () => {
    const b = bundle([eq('region', 'Bordeaux'), eq('wine_type', 'red')]);
    const result = applyCompositionalInference(b);
    expect(result.hard).toBe(b.hard);
    expect(result.soft).toBe(b.soft);
  });
});
