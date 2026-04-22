import { describe, it, expect } from 'vitest';
import { expandWithOntology } from '../../src/domain/attribute/service/ontology-expansion.js';
import type { ConstraintBundle, NormalizedConstraint } from '../../src/domain/shared/types/constraint-bundle.js';

function hardConstraint(attribute: string, value: string): NormalizedConstraint {
  return {
    attribute,
    operator: '=',
    value,
    source_phrase: `test(${attribute}=${value})`,
    confidence: 0.95,
    mapping_version: 'test',
  };
}

function emptyBundle(hard: NormalizedConstraint[]): ConstraintBundle {
  return { hard, soft: [], inferred: [] };
}

describe('RFC-019 regression: ontology expansion', () => {
  it('region=Bordeaux expands to inferred country=France', () => {
    const bundle = emptyBundle([hardConstraint('region', 'Bordeaux')]);
    const expanded = expandWithOntology(bundle);

    expect(expanded.hard).toEqual(bundle.hard);
    const countryInferred = expanded.inferred.find(
      (c) => c.attribute === 'country' && c.value === 'France',
    );
    expect(countryInferred).toBeDefined();
    // Strengthen: verify operator and that confidence is present
    expect(countryInferred!.operator).toBe('=');
    expect(countryInferred!.confidence).toBeGreaterThan(0);
  });

  it('region=Burgundy expands to inferred country=France', () => {
    const bundle = emptyBundle([hardConstraint('region', 'Burgundy')]);
    const expanded = expandWithOntology(bundle);

    const countryInferred = expanded.inferred.find(
      (c) => c.attribute === 'country' && c.value === 'France',
    );
    expect(countryInferred).toBeDefined();
    // Strengthen: verify operator and that confidence is present
    expect(countryInferred!.operator).toBe('=');
    expect(countryInferred!.confidence).toBeGreaterThan(0);
  });

  it('no expansion for unknown region', () => {
    const bundle = emptyBundle([hardConstraint('region', 'Atlantis')]);
    const expanded = expandWithOntology(bundle);

    expect(expanded.soft).toHaveLength(0);
    expect(expanded.inferred).toHaveLength(0);
  });

  it('preserves hard constraints unchanged', () => {
    const hard = [hardConstraint('region', 'Bordeaux')];
    const bundle = emptyBundle(hard);
    const expanded = expandWithOntology(bundle);

    expect(expanded.hard).toBe(bundle.hard);
  });
});
