/**
 * E5-T2: BUG-15 — SOFT_CONSTRAINT_ATTRIBUTES SSoT
 * Verifies the SSoT has the previously missing attributes.
 */
import { describe, it, expect } from 'vitest';
import { SOFT_CONSTRAINT_ATTRIBUTES } from '../../../../../src/domain/shared/constants/constraint-attributes.js';

describe('SOFT_CONSTRAINT_ATTRIBUTES SSoT', () => {
  it('contains price_band (was missing from planner.ts)', () => {
    expect(SOFT_CONSTRAINT_ATTRIBUTES.has('price_band')).toBe(true);
  });

  it('contains occasion (was missing from planner.ts)', () => {
    expect(SOFT_CONSTRAINT_ATTRIBUTES.has('occasion')).toBe(true);
  });

  it('contains critic_score (was missing from planner.ts)', () => {
    expect(SOFT_CONSTRAINT_ATTRIBUTES.has('critic_score')).toBe(true);
  });

  it('contains fruit_intensity (was missing from planner.ts)', () => {
    expect(SOFT_CONSTRAINT_ATTRIBUTES.has('fruit_intensity')).toBe(true);
  });

  it('contains finish (was missing from planner.ts)', () => {
    expect(SOFT_CONSTRAINT_ATTRIBUTES.has('finish')).toBe(true);
  });

  it('contains all original core attributes', () => {
    const coreAttributes = ['body', 'sweetness', 'acidity', 'tannin', 'style'];
    for (const attr of coreAttributes) {
      expect(SOFT_CONSTRAINT_ATTRIBUTES.has(attr)).toBe(true);
    }
  });

  it('has at least 10 attributes', () => {
    expect(SOFT_CONSTRAINT_ATTRIBUTES.size).toBeGreaterThanOrEqual(10);
  });

  // W2-01: 5 newly added attributes must route to soft (not hard)
  it('contains producer_prestige (W2-01 addition)', () => {
    expect(SOFT_CONSTRAINT_ATTRIBUTES.has('producer_prestige')).toBe(true);
  });

  it('contains finish_length (W2-01 addition)', () => {
    expect(SOFT_CONSTRAINT_ATTRIBUTES.has('finish_length')).toBe(true);
  });

  it('contains drinking_window (W2-01 addition)', () => {
    expect(SOFT_CONSTRAINT_ATTRIBUTES.has('drinking_window')).toBe(true);
  });

  it('contains flavor_profile (W2-01 addition)', () => {
    expect(SOFT_CONSTRAINT_ATTRIBUTES.has('flavor_profile')).toBe(true);
  });

  it('contains certification (W2-01 addition)', () => {
    expect(SOFT_CONSTRAINT_ATTRIBUTES.has('certification')).toBe(true);
  });
});
