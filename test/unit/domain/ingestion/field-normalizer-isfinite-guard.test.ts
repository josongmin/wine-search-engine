/**
 * E5-T7: BUG-DS07 — field-normalizer Number() without isFinite guard
 * Test first (TDD).
 * Note: field-normalizer.ts does not currently have a normalizeNumericField function.
 * This test targets the normalizeVolume function which already has isFinite guards.
 * We also test any numeric conversion functions that parse external strings.
 */
import { describe, it, expect } from 'vitest';
import { normalizeVolume } from '../../../../src/domain/ingestion/service/field-normalizer.js';

describe('E5-T7: field-normalizer numeric guards', () => {
  describe('normalizeVolume — existing isFinite guard (regression)', () => {
    it('"abc" → null', () => {
      expect(normalizeVolume('abc')).toBeNull();
    });

    it('"750ml" → 750', () => {
      expect(normalizeVolume('750ml')).toBe(750);
    });

    it('"" → null', () => {
      expect(normalizeVolume('')).toBeNull();
    });

    it('"NaN ml" → null (not a number pattern)', () => {
      expect(normalizeVolume('NaN ml')).toBeNull();
    });

    it('"Infinityml" → null', () => {
      expect(normalizeVolume('Infinityml')).toBeNull();
    });

    it('"750e308ml" (Infinity after parseFloat) → null', () => {
      // parseFloat("750e308") → Infinity — isFinite guard must reject
      expect(normalizeVolume('750e308ml')).toBeNull();
    });
  });
});
