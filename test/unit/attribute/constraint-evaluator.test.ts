import { describe, it, expect } from 'vitest';
import { ConstraintEvaluator } from '../../../src/domain/attribute/service/constraint-evaluator.js';
import type { ConstraintBundle, NormalizedConstraint } from '../../../src/domain/shared/types/index.js';
const evaluator = new ConstraintEvaluator();

function makeConstraint(
  attribute: string,
  operator: NormalizedConstraint['operator'],
  value: NormalizedConstraint['value'],
): NormalizedConstraint {
  return { attribute, operator, value, source_phrase: 'test', confidence: 0.9 };
}

function makeBundle(
  hard: NormalizedConstraint[] = [],
  soft: NormalizedConstraint[] = [],
  inferred: NormalizedConstraint[] = [],
): ConstraintBundle {
  return { hard, soft, inferred };
}

describe('ConstraintEvaluator', () => {
  describe('hard constraints', () => {
    it('body >= 0.7, candidate body = 0.8 → hardPass=true', () => {
      const bundle = makeBundle([makeConstraint('body', '>=', 0.7)]);
      const result = evaluator.evaluate(bundle, { body: 0.8, sweetness: 0.1 });
      expect(result.hardPass).toBe(true);
      expect(result.matched).toContain('body');
    });

    it('body >= 0.7, candidate body = 0.5 → hardPass=false', () => {
      const bundle = makeBundle([makeConstraint('body', '>=', 0.7)]);
      const result = evaluator.evaluate(bundle, { body: 0.5, sweetness: 0.1 });
      expect(result.hardPass).toBe(false);
      expect(result.unmet).toContain('body');
    });

    it('multiple hard constraints, one fails → hardPass=false', () => {
      const bundle = makeBundle([
        makeConstraint('body', '>=', 0.7),
        makeConstraint('sweetness', '<=', 0.2),
      ]);
      // sweetness 0.5 fails the <= 0.2 constraint
      const result = evaluator.evaluate(bundle, { body: 0.8, sweetness: 0.5 });
      expect(result.hardPass).toBe(false);
      expect(result.unmet).toContain('sweetness');
    });

    it('sweetness <= 0.5, candidate sweetness = 0.3 → hardPass=true', () => {
      const bundle = makeBundle([makeConstraint('sweetness', '<=', 0.5)]);
      const result = evaluator.evaluate(bundle, { body: 0.5, sweetness: 0.3 });
      expect(result.hardPass).toBe(true);
      expect(result.matched).toContain('sweetness');
    });
  });

  describe('soft constraints', () => {
    it('body >= 0.7, candidate body = 0.6 → partial score (not 0, not 1)', () => {
      const bundle = makeBundle([], [makeConstraint('body', '>=', 0.7)]);
      const result = evaluator.evaluate(bundle, { body: 0.6, sweetness: 0.1 });
      expect(result.hardPass).toBe(true); // no hard constraints
      expect(result.softScore).toBeGreaterThan(0);
      expect(result.softScore).toBeLessThan(1);
    });

    it('soft constraint satisfied → softScore=1.0', () => {
      const bundle = makeBundle([], [makeConstraint('body', '>=', 0.7)]);
      const result = evaluator.evaluate(bundle, { body: 0.8, sweetness: 0.1 });
      expect(result.softScore).toBe(1.0);
    });

    it('soft constraint with body=0 far from threshold → softScore near 0', () => {
      const bundle = makeBundle([], [makeConstraint('body', '>=', 0.7)]);
      const result = evaluator.evaluate(bundle, { body: 0.0, sweetness: 0.0 });
      // distance = 0.7 - 0.0 = 0.7, penalty = 1 - 0.7*2 = -0.4 → max(0, -0.4) = 0
      expect(result.softScore).toBe(0);
    });
  });

  describe('exclude constraint', () => {
    it('exclude constraint: "gift" excluded, candidate has "gift" occasion → filtered', () => {
      const excludeConstraint = makeConstraint('occasion', 'exclude', 'gift');
      const bundle = makeBundle([excludeConstraint]);
      const result = evaluator.evaluate(bundle, {
        body: 0.5,
        sweetness: 0.1,
        occasion: ['gift', 'dinner'],
      });
      expect(result.hardPass).toBe(false);
      expect(result.unmet).toContain('occasion');

      const excludeFromScalar = makeConstraint('price_band', 'exclude', 'mid');
      const bundleScalar = makeBundle([excludeFromScalar]);
      const result2 = evaluator.evaluate(bundleScalar, { body: 0.5, sweetness: 0.1, priceBand: 'mid' });
      expect(result2.hardPass).toBe(false);
      expect(result2.unmet).toContain('price_band');
    });

    it('exclude constraint: excluded value not present → hardPass=true', () => {
      const excludeConstraint = makeConstraint('price_band', 'exclude', 'high');
      const bundle = makeBundle([excludeConstraint]);
      const result = evaluator.evaluate(bundle, { body: 0.5, sweetness: 0.1, priceBand: 'mid' });
      expect(result.hardPass).toBe(true);
    });
  });

  describe('range constraint', () => {
    it('sweetness range [0.3, 0.6], candidate = 0.5 → matched', () => {
      const bundle = makeBundle([makeConstraint('sweetness', 'range', { min: 0.3, max: 0.6 })]);
      const result = evaluator.evaluate(bundle, { body: 0.5, sweetness: 0.5 });
      expect(result.hardPass).toBe(true);
      expect(result.matched).toContain('sweetness');
    });

    it('sweetness range [0.3, 0.6], candidate = 0.1 → does not match', () => {
      const bundle = makeBundle([makeConstraint('sweetness', 'range', { min: 0.3, max: 0.6 })]);
      const result = evaluator.evaluate(bundle, { body: 0.5, sweetness: 0.1 });
      expect(result.hardPass).toBe(false);
      expect(result.unmet).toContain('sweetness');
    });

    it('sweetness range [0.3, 0.6], candidate = 0.3 (at min boundary) → matched', () => {
      const bundle = makeBundle([makeConstraint('sweetness', 'range', { min: 0.3, max: 0.6 })]);
      const result = evaluator.evaluate(bundle, { body: 0.5, sweetness: 0.3 });
      expect(result.hardPass).toBe(true);
      expect(result.matched).toContain('sweetness');
    });

    it('sweetness range [0.3, 0.6], candidate = 0.8 (above max) → does not match', () => {
      const bundle = makeBundle([makeConstraint('sweetness', 'range', { min: 0.3, max: 0.6 })]);
      const result = evaluator.evaluate(bundle, { body: 0.5, sweetness: 0.8 });
      expect(result.hardPass).toBe(false);
      expect(result.unmet).toContain('sweetness');
    });
  });

  describe('empty constraints', () => {
    it('empty constraints → hardPass=true, softScore=1.0', () => {
      const bundle = makeBundle([], [], []);
      const result = evaluator.evaluate(bundle, { body: 0.5, sweetness: 0.3 });
      expect(result.hardPass).toBe(true);
      expect(result.softScore).toBe(1.0);
    });
  });

  describe('= operator', () => {
    it('style = "red", candidate style = "red" → hardPass=true', () => {
      const bundle = makeBundle([makeConstraint('style', '=', 'red')]);
      const result = evaluator.evaluate(bundle, { body: 0.5, sweetness: 0.1, style: 'red' });
      expect(result.hardPass).toBe(true);
      expect(result.matched).toContain('style');
    });

    it('style = "red", candidate style = "white" → hardPass=false', () => {
      const bundle = makeBundle([makeConstraint('style', '=', 'red')]);
      const result = evaluator.evaluate(bundle, { body: 0.5, sweetness: 0.1, style: 'white' });
      expect(result.hardPass).toBe(false);
      expect(result.unmet).toContain('style');
    });
  });

  describe('in operator', () => {
    it('"in" operator: occasion array contains target → matches', () => {
      const bundle = makeBundle([makeConstraint('occasion', 'in', ['gift'])]);
      const result = evaluator.evaluate(bundle, { body: 0.5, sweetness: 0.1, occasion: ['gift', 'dinner'] });
      expect(result.hardPass).toBe(true);
    });

    it('"in" operator: occasion array does not contain target → fails', () => {
      const bundle = makeBundle([makeConstraint('occasion', 'in', ['party'])]);
      const result = evaluator.evaluate(bundle, { body: 0.5, sweetness: 0.1, occasion: ['gift', 'dinner'] });
      expect(result.hardPass).toBe(false);
    });

    it('canonical gift query matches candidate occasion tag "gifting"', () => {
      const bundle = makeBundle([makeConstraint('occasion', 'in', ['gift'])]);
      const result = evaluator.evaluate(
        bundle,
        { body: 0.5, sweetness: 0.1, occasion: ['gifting', 'special dinner'] },
      );
      expect(result.hardPass).toBe(true);
      expect(result.matched).toContain('occasion');
    });

    it('canonical date_night query matches candidate occasion tag "special dinner"', () => {
      const bundle = makeBundle([makeConstraint('occasion', 'in', ['date_night'])]);
      const result = evaluator.evaluate(
        bundle,
        { body: 0.5, sweetness: 0.1, occasion: ['celebration', 'special dinner'] },
      );
      expect(result.hardPass).toBe(true);
      expect(result.matched).toContain('occasion');
    });
  });

  describe('inferred constraints tracked separately', () => {
    it('inferred constraints appear in inferred array of result', () => {
      const bundle = makeBundle([], [], [makeConstraint('acidity', '>=', 0.5)]);
      const result = evaluator.evaluate(bundle, { body: 0.5, sweetness: 0.1, acidity: 0.7 });
      expect(result.inferred).toContain('acidity');
    });
  });
});
