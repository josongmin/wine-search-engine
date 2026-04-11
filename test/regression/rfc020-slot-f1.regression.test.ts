/**
 * Regression: RFC-020 Slot F1 — Constraint Extraction Quality Metrics
 *
 * Guards:
 *  SF-1:  Perfect match → F1 = 1.0 (all three modes)
 *  SF-2:  Zero overlap → F1 = 0.0
 *  SF-3:  Partial match — precision/recall/F1 computed correctly
 *  SF-4:  type_only mode ignores value differences
 *  SF-5:  strict mode requires exact operator match
 *  SF-6:  relaxed mode accepts numeric values within 50% range
 *  SF-7:  relaxed mode rejects numeric values outside 50% range
 *  SF-8:  empty extracted → precision = 0, recall = 0
 *  SF-9:  empty expected → precision = 0, recall = 1 (no false negatives, all FP)
 *  SF-10: both empty → F1 = 1.0 (perfect agreement on "no constraints")
 *  SF-11: attribute mismatch → no match regardless of mode
 *  SF-12: duplicate slots — each expected slot matched at most once
 *
 * Append-only. Never delete.
 */

import { describe, expect, it } from 'vitest';
import { scoreSlotF1, type ConstraintSlot } from '../../scripts/eval/metrics.js';

const REGION_BORDEAUX: ConstraintSlot = { attribute: 'region', value: 'Bordeaux' };
const REGION_BURGUNDY: ConstraintSlot = { attribute: 'region', value: 'Burgundy' };
const GRAPE_CAB: ConstraintSlot = { attribute: 'grape', value: 'Cabernet Sauvignon' };
const PRICE_50: ConstraintSlot = { attribute: 'price_max', value: '50', operator: 'lte' };
const PRICE_40: ConstraintSlot = { attribute: 'price_max', value: '40', operator: 'lte' };
const PRICE_100: ConstraintSlot = { attribute: 'price_max', value: '100', operator: 'lte' };

describe('RFC-020: scoreSlotF1', () => {
  it('SF-1: perfect match returns F1=1.0 in all modes', () => {
    const slots = [REGION_BORDEAUX, GRAPE_CAB];
    for (const mode of ['strict', 'relaxed', 'type_only'] as const) {
      const result = scoreSlotF1(slots, slots, mode);
      expect(result.f1).toBeCloseTo(1.0, 5);
      expect(result.precision).toBeCloseTo(1.0, 5);
      expect(result.recall).toBeCloseTo(1.0, 5);
    }
  });

  it('SF-2: zero overlap returns F1=0.0', () => {
    const result = scoreSlotF1([REGION_BORDEAUX], [GRAPE_CAB], 'strict');
    expect(result.f1).toBe(0);
    expect(result.precision).toBe(0);
    expect(result.recall).toBe(0);
  });

  it('SF-3: partial match computes correct P/R/F1', () => {
    // extracted: [region=Bordeaux, grape=Cabernet] — 2 slots
    // expected:  [region=Bordeaux, price<=50]    — 2 slots
    // TP = 1 (region match), FP = 1 (grape not in expected), FN = 1 (price not in extracted)
    const extracted = [REGION_BORDEAUX, GRAPE_CAB];
    const expected = [REGION_BORDEAUX, PRICE_50];
    const result = scoreSlotF1(extracted, expected, 'strict');
    expect(result.precision).toBeCloseTo(0.5, 5);   // 1/2
    expect(result.recall).toBeCloseTo(0.5, 5);       // 1/2
    expect(result.f1).toBeCloseTo(0.5, 5);           // 2*0.5*0.5/(0.5+0.5)
  });

  it('SF-4: type_only mode ignores value differences', () => {
    // Same attribute (region) but different values → still a match in type_only
    const result = scoreSlotF1([REGION_BORDEAUX], [REGION_BURGUNDY], 'type_only');
    expect(result.f1).toBeCloseTo(1.0, 5);
  });

  it('SF-5: strict mode requires matching operator', () => {
    const extracted: ConstraintSlot = { attribute: 'price_max', value: '50', operator: 'lt' };
    const expected: ConstraintSlot = { attribute: 'price_max', value: '50', operator: 'lte' };
    const strict = scoreSlotF1([extracted], [expected], 'strict');
    expect(strict.f1).toBe(0);

    // Same operator → match
    const strict2 = scoreSlotF1([PRICE_50], [PRICE_50], 'strict');
    expect(strict2.f1).toBeCloseTo(1.0, 5);
  });

  it('SF-6: relaxed accepts numeric values within 50% relative distance', () => {
    // 40 vs 50: |40-50|/50 = 0.2 → ≤ 50% → match
    const result = scoreSlotF1([PRICE_40], [PRICE_50], 'relaxed');
    expect(result.f1).toBeCloseTo(1.0, 5);
  });

  it('SF-7: relaxed rejects numeric values outside 50% range', () => {
    // 100 vs 50: |100-50|/50 = 1.0 → > 50% → no match
    const result = scoreSlotF1([PRICE_100], [PRICE_50], 'relaxed');
    expect(result.f1).toBe(0);
  });

  it('SF-8: empty extracted → precision=0, recall=0', () => {
    const result = scoreSlotF1([], [REGION_BORDEAUX], 'strict');
    expect(result.precision).toBe(0);
    expect(result.recall).toBe(0);
    expect(result.f1).toBe(0);
  });

  it('SF-9: empty expected → precision=0, recall=1 (all extracted are false positives)', () => {
    const result = scoreSlotF1([REGION_BORDEAUX], [], 'strict');
    expect(result.precision).toBe(0);
    expect(result.recall).toBe(1);
    expect(result.f1).toBe(0);
  });

  it('SF-10: both empty → F1=1.0 (perfect agreement on no constraints)', () => {
    const result = scoreSlotF1([], [], 'strict');
    expect(result.f1).toBeCloseTo(1.0, 5);
    expect(result.precision).toBeCloseTo(1.0, 5);
    expect(result.recall).toBeCloseTo(1.0, 5);
  });

  it('SF-11: attribute mismatch → no match in any mode', () => {
    for (const mode of ['strict', 'relaxed', 'type_only'] as const) {
      const result = scoreSlotF1([REGION_BORDEAUX], [GRAPE_CAB], mode);
      expect(result.f1).toBe(0);
    }
  });

  it('SF-12: duplicate slots — each expected matched at most once', () => {
    // extracted: [region=Bordeaux, region=Bordeaux] — 2 identical
    // expected:  [region=Bordeaux]                  — 1 slot
    // TP = 1, FP = 1 → precision = 0.5, recall = 1.0, F1 = 2/3
    const extracted = [REGION_BORDEAUX, REGION_BORDEAUX];
    const expected = [REGION_BORDEAUX];
    const result = scoreSlotF1(extracted, expected, 'strict');
    expect(result.precision).toBeCloseTo(0.5, 5);
    expect(result.recall).toBeCloseTo(1.0, 5);
    expect(result.f1).toBeCloseTo(2 / 3, 4);
  });
});
