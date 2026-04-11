/**
 * E5-T2: BUG-15 — SOFT_CONSTRAINT_ATTRIBUTES SSoT
 * Verifies the SSoT has the previously missing attributes.
 * Also covers STYLE_SENSORY_ATTRIBUTES subset (BUG-15 Fix 2):
 * planner.ts and result-grouper.ts previously inlined ['body','sweetness','acidity','tannin','style'].
 */
import { describe, it, expect } from 'vitest';
import {
  SOFT_CONSTRAINT_ATTRIBUTES,
  STYLE_SENSORY_ATTRIBUTES,
} from '../../../../../src/domain/shared/constants/constraint-attributes.js';

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

  it('does NOT contain bare finish — only finish_length maps to HybridCandidate', () => {
    // 'finish' (bare) was removed because HybridCandidate and LLM_ALLOWED_ATTRIBUTES
    // only expose 'finish_length'. A bare 'finish' key in SOFT_CONSTRAINT_ATTRIBUTES
    // would silently break soft ranking since the attribute would never match a candidate.
    expect(SOFT_CONSTRAINT_ATTRIBUTES.has('finish')).toBe(false);
    expect(SOFT_CONSTRAINT_ATTRIBUTES.has('finish_length')).toBe(true);
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

describe('STYLE_SENSORY_ATTRIBUTES SSoT (BUG-15 Fix 2)', () => {
  it('contains all five style sensory attributes', () => {
    for (const attr of ['body', 'sweetness', 'acidity', 'tannin', 'style']) {
      expect(STYLE_SENSORY_ATTRIBUTES.has(attr)).toBe(true);
    }
  });

  it('is a strict subset of SOFT_CONSTRAINT_ATTRIBUTES', () => {
    for (const attr of STYLE_SENSORY_ATTRIBUTES) {
      expect(SOFT_CONSTRAINT_ATTRIBUTES.has(attr)).toBe(true);
    }
  });

  it('does NOT contain non-style attributes (price_band, occasion, certification)', () => {
    expect(STYLE_SENSORY_ATTRIBUTES.has('price_band')).toBe(false);
    expect(STYLE_SENSORY_ATTRIBUTES.has('occasion')).toBe(false);
    expect(STYLE_SENSORY_ATTRIBUTES.has('certification')).toBe(false);
  });

  it('has exactly 5 members', () => {
    expect(STYLE_SENSORY_ATTRIBUTES.size).toBe(5);
  });
});
