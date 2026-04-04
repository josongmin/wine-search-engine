import { describe, it, expect } from 'vitest';
import { AttributeInferrer } from '../../../src/domain/attribute/service/attribute-inferrer.js';

const inferrer = new AttributeInferrer();

describe('AttributeInferrer', () => {
  describe('grape-based inference', () => {
    it('Cabernet Sauvignon grape → body >= 0.7 inferred', () => {
      const attrs = inferrer.infer(['Cabernet Sauvignon']);
      const body = attrs.find((a) => a.attribute === 'body');
      expect(body).toBeDefined();
      expect(body!.value).toBeGreaterThanOrEqual(0.7);
      expect(body!.inferenceSource).toContain('cabernet_sauvignon');
    });

    it('Cabernet Sauvignon → also infers tannin', () => {
      const attrs = inferrer.infer(['Cabernet Sauvignon']);
      const tannin = attrs.find((a) => a.attribute === 'tannin');
      expect(tannin).toBeDefined();
      expect(tannin!.value).toBeGreaterThanOrEqual(0.7);
    });

    it('Riesling grape → acidity inferred', () => {
      const attrs = inferrer.infer(['Riesling']);
      const acidity = attrs.find((a) => a.attribute === 'acidity');
      expect(acidity).toBeDefined();
      expect(acidity!.value).toBeGreaterThanOrEqual(0.7);
    });

    it('Riesling grape → body inferred (light-bodied)', () => {
      const attrs = inferrer.infer(['Riesling']);
      const body = attrs.find((a) => a.attribute === 'body');
      expect(body).toBeDefined();
      expect(body!.value).toBeLessThanOrEqual(0.5);
    });
  });

  describe('region-based inference', () => {
    it('Sauternes region → sweetness 0.9 inferred', () => {
      const attrs = inferrer.infer(undefined, 'sauternes');
      const sweetness = attrs.find((a) => a.attribute === 'sweetness');
      expect(sweetness).toBeDefined();
      expect(sweetness!.value).toBe(0.9);
      expect(sweetness!.inferenceSource).toContain('sauternes');
    });

    it('Sauternes region rule has higher confidence for sweetness than grape-based inference', () => {
      // When Riesling (grape) and Sauternes (region) both infer sweetness,
      // Sauternes has confidence=0.95; Riesling has no direct sweetness rule
      // → region rule wins for sweetness
      const attrs = inferrer.infer(undefined, 'sauternes');
      const sweetness = attrs.find((a) => a.attribute === 'sweetness');
      expect(sweetness!.inferenceConfidence).toBeGreaterThanOrEqual(0.9);
    });
  });

  describe('style-based inference', () => {
    it('sparkling style → acidity inferred', () => {
      const attrs = inferrer.infer(undefined, undefined, 'sparkling');
      const acidity = attrs.find((a) => a.attribute === 'acidity');
      expect(acidity).toBeDefined();
      expect(acidity!.value).toBe(0.7);
      expect(acidity!.inferenceSource).toContain('style_rule:sparkling');
    });

    it('Champagne region → acidity inferred (region rule)', () => {
      const attrs = inferrer.infer(undefined, 'champagne');
      const acidity = attrs.find((a) => a.attribute === 'acidity');
      expect(acidity).toBeDefined();
    });
  });

  describe('region overrides grape rules', () => {
    it('Riesling grape in Alsace region → sweetness inference from region override', () => {
      const attrs = inferrer.infer(['Riesling'], 'alsace');
      const sweetness = attrs.find((a) => a.attribute === 'sweetness');
      // Riesling+Alsace region override adds sweetness=0.2
      expect(sweetness).toBeDefined();
      expect(sweetness!.inferenceSource).toContain('alsace');
    });

    it('Riesling grape in Mosel region → sweetness=0.5', () => {
      const attrs = inferrer.infer(['Riesling'], 'mosel');
      const sweetness = attrs.find((a) => a.attribute === 'sweetness');
      expect(sweetness).toBeDefined();
      expect(sweetness!.value).toBe(0.5);
    });
  });

  describe('multiple grapes: highest-confidence inference wins', () => {
    it('Cabernet Sauvignon + Merlot → body inferred (Cab Sauv has higher confidence)', () => {
      const attrs = inferrer.infer(['Cabernet Sauvignon', 'Merlot']);
      const body = attrs.find((a) => a.attribute === 'body');
      expect(body).toBeDefined();
      // Cabernet Sauvignon body=0.8 at confidence=0.9, Merlot body=0.65 at 0.85
      // Cabernet has higher confidence → wins
      expect(body!.inferenceSource).toContain('cabernet_sauvignon');
    });
  });

  describe('no inputs → empty result', () => {
    it('no grapes, no region, no style → returns empty array', () => {
      const attrs = inferrer.infer();
      expect(attrs).toHaveLength(0);
    });
  });

  describe('deduplication', () => {
    it('each attribute appears only once even when multiple sources infer it', () => {
      // Riesling + Champagne region both infer acidity
      const attrs = inferrer.infer(['Riesling'], 'champagne');
      const acidityEntries = attrs.filter((a) => a.attribute === 'acidity');
      expect(acidityEntries).toHaveLength(1);
    });
  });
});
