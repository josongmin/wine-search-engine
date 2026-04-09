/**
 * Unit tests for RFC-020 P1-P3 metric functions.
 *
 * Covers:
 *   - stringMatches (NFKC fold, trim, case)
 *   - rangesOverlap (numeric range intersection)
 *   - constraintMatches (strict, relaxed, type_only modes)
 *   - scoreSemanticConstraintRecall (P1: SCR bucket-wise recall)
 *   - scoreEntityLinkingAccuracy (P2: ELA@1 resolver coverage)
 *   - scoreSlotF1 (P3: entity-level strict/relaxed/type_only F1)
 *   - TIER_WEIGHT_* constants consistency
 */

import { describe, it, expect } from 'vitest';
import {
  constraintMatches,
  scoreSemanticConstraintRecall,
  scoreEntityLinkingAccuracy,
  scoreSlotF1,
  TIER_WEIGHT_HARD,
  TIER_WEIGHT_SOFT,
  TIER_WEIGHT_INFERRED,
} from '../constraint-metrics.js';
import type { ConstraintBundle } from '../../../../src/domain/shared/types/constraint-bundle.js';
import type { ExpectedConstraint, ExpectedEntity } from '../scenario.js';

// ─────────────────────────────────────────────────────────────────────
// Shared tier weight constants
// ─────────────────────────────────────────────────────────────────────

describe('TIER_WEIGHT constants', () => {
  it('weights sum to 1.0', () => {
    expect(TIER_WEIGHT_HARD + TIER_WEIGHT_SOFT + TIER_WEIGHT_INFERRED).toBeCloseTo(1.0, 10);
  });

  it('hard weight is the largest (retrieval correctness)', () => {
    expect(TIER_WEIGHT_HARD).toBeGreaterThan(TIER_WEIGHT_SOFT);
    expect(TIER_WEIGHT_HARD).toBeGreaterThan(TIER_WEIGHT_INFERRED);
  });
});

// ─────────────────────────────────────────────────────────────────────
// constraintMatches
// ─────────────────────────────────────────────────────────────────────

describe('constraintMatches', () => {
  // ── String matching ──
  it('matches case-insensitive string values', () => {
    const actual = { attribute: 'region', operator: '=' as const, value: 'Bordeaux' };
    const expected: ExpectedConstraint = { attribute: 'region', operator: '=', value: 'bordeaux' };
    expect(constraintMatches(actual, expected, 'strict')).toBe(true);
  });

  it('matches NFKC-normalized strings (accented Latin)', () => {
    // ñ can be composed differently — NFKC should normalize both forms
    const actual = { attribute: 'region', operator: '=' as const, value: 'Côtes du Rhône' };
    const expected: ExpectedConstraint = { attribute: 'region', operator: '=', value: 'côtes du rhône' };
    expect(constraintMatches(actual, expected, 'strict')).toBe(true);
  });

  it('matches Korean values', () => {
    const actual = { attribute: 'region', operator: '=' as const, value: '보르도' };
    const expected: ExpectedConstraint = { attribute: 'region', operator: '=', value: '보르도' };
    expect(constraintMatches(actual, expected, 'strict')).toBe(true);
  });

  it('matches country canonical equivalents (USA vs United States)', () => {
    const actual = { attribute: 'country', operator: '=' as const, value: 'USA' };
    const expected: ExpectedConstraint = { attribute: 'country', operator: '=', value: 'United States' };
    expect(constraintMatches(actual, expected, 'strict')).toBe(true);
  });

  it('rejects mismatched string values', () => {
    const actual = { attribute: 'region', operator: '=' as const, value: 'Bordeaux' };
    const expected: ExpectedConstraint = { attribute: 'region', operator: '=', value: 'Burgundy' };
    expect(constraintMatches(actual, expected, 'strict')).toBe(false);
  });

  it('rejects mismatched attribute', () => {
    const actual = { attribute: 'grape', operator: '=' as const, value: 'Merlot' };
    const expected: ExpectedConstraint = { attribute: 'region', operator: '=', value: 'Merlot' };
    expect(constraintMatches(actual, expected, 'strict')).toBe(false);
  });

  // ── Numeric matching ──
  it('matches equal numbers within tolerance', () => {
    const actual = { attribute: 'vintage', operator: '=' as const, value: 2018 };
    const expected: ExpectedConstraint = { attribute: 'vintage', operator: '=', value: 2018 };
    expect(constraintMatches(actual, expected, 'strict')).toBe(true);
  });

  it('matches numbers within 0.1% tolerance', () => {
    // 50 ± 0.05 → 49.96 should match
    const actual = { attribute: 'price', operator: '=' as const, value: 49.96 };
    const expected: ExpectedConstraint = { attribute: 'price', operator: '=', value: 50 };
    expect(constraintMatches(actual, expected, 'strict')).toBe(true);
  });

  it('rejects numbers outside tolerance', () => {
    const actual = { attribute: 'price', operator: '=' as const, value: 55 };
    const expected: ExpectedConstraint = { attribute: 'price', operator: '=', value: 50 };
    expect(constraintMatches(actual, expected, 'strict')).toBe(false);
  });

  // ── Range matching ──
  it('matches overlapping ranges', () => {
    const actual = { attribute: 'price', operator: 'range' as const, value: { min: 20, max: 60 } };
    const expected: ExpectedConstraint = { attribute: 'price', operator: 'range', value: { min: 30, max: 50 } };
    expect(constraintMatches(actual, expected, 'strict')).toBe(true);
  });

  it('rejects non-overlapping ranges', () => {
    const actual = { attribute: 'price', operator: 'range' as const, value: { min: 100, max: 200 } };
    const expected: ExpectedConstraint = { attribute: 'price', operator: 'range', value: { min: 30, max: 50 } };
    expect(constraintMatches(actual, expected, 'strict')).toBe(false);
  });

  it('matches range touching at boundary (min === max)', () => {
    const actual = { attribute: 'price', operator: 'range' as const, value: { min: 30, max: 50 } };
    const expected: ExpectedConstraint = { attribute: 'price', operator: 'range', value: { min: 50, max: 70 } };
    expect(constraintMatches(actual, expected, 'strict')).toBe(true);
  });

  // ── Operator modes ──
  it('strict mode rejects different operators', () => {
    const actual = { attribute: 'price', operator: 'range' as const, value: { min: 0, max: 50 } };
    const expected: ExpectedConstraint = { attribute: 'price', operator: '<=', value: 50 };
    expect(constraintMatches(actual, expected, 'strict')).toBe(false);
  });

  it('relaxed mode allows range ↔ single-bound operator flex', () => {
    const actual = { attribute: 'price', operator: 'range' as const, value: { min: 0, max: 50 } };
    const expected: ExpectedConstraint = { attribute: 'price', operator: '<=', value: 50 };
    expect(constraintMatches(actual, expected, 'relaxed')).toBe(true);
  });

  it('type_only mode matches on attribute alone', () => {
    const actual = { attribute: 'grape', operator: '=' as const, value: 'Merlot' };
    const expected: ExpectedConstraint = { attribute: 'grape', operator: '=', value: 'Cabernet Sauvignon' };
    expect(constraintMatches(actual, expected, 'type_only')).toBe(true);
  });

  // ── Array matching ──
  it('matches array subset inclusion', () => {
    const actual = { attribute: 'grape', operator: 'in' as const, value: ['merlot', 'cabernet sauvignon', 'syrah'] };
    const expected: ExpectedConstraint = { attribute: 'grape', operator: 'in', value: ['Merlot', 'Syrah'] };
    expect(constraintMatches(actual, expected, 'strict')).toBe(true);
  });

  it('rejects array when expected element missing', () => {
    const actual = { attribute: 'grape', operator: 'in' as const, value: ['merlot'] };
    const expected: ExpectedConstraint = { attribute: 'grape', operator: 'in', value: ['Merlot', 'Syrah'] };
    expect(constraintMatches(actual, expected, 'strict')).toBe(false);
  });

  it('handles array with padded strings (trim consistency)', () => {
    const actual = { attribute: 'grape', operator: 'in' as const, value: ['  merlot  '] };
    const expected: ExpectedConstraint = { attribute: 'grape', operator: 'in', value: ['Merlot'] };
    expect(constraintMatches(actual, expected, 'strict')).toBe(true);
  });

  // ── Empty / edge cases ──
  it('returns false for mismatched types (string vs number)', () => {
    const actual = { attribute: 'vintage', operator: '=' as const, value: '2018' };
    const expected: ExpectedConstraint = { attribute: 'vintage', operator: '=', value: 2018 };
    expect(constraintMatches(actual, expected, 'strict')).toBe(false);
  });

  it('handles single string vs array (same operator)', () => {
    const actual = { attribute: 'grape', operator: 'in' as const, value: ['cabernet sauvignon'] };
    const expected: ExpectedConstraint = { attribute: 'grape', operator: 'in', value: ['Cabernet Sauvignon'] };
    expect(constraintMatches(actual, expected, 'strict')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// P1: Semantic Constraint Recall (SCR)
// ─────────────────────────────────────────────────────────────────────

describe('scoreSemanticConstraintRecall', () => {
  const emptyBundle: ConstraintBundle = { hard: [], soft: [], inferred: [] };

  it('returns all-null when no expected constraints', () => {
    const result = scoreSemanticConstraintRecall(emptyBundle, {});
    expect(result.scrHard).toBeNull();
    expect(result.scrSoft).toBeNull();
    expect(result.scrInferred).toBeNull();
    expect(result.scrOverall).toBeNull();
    expect(result.missedConstraints).toEqual([]);
  });

  it('returns all-null when expected buckets are empty arrays', () => {
    const result = scoreSemanticConstraintRecall(emptyBundle, { hard: [], soft: [], inferred: [] });
    expect(result.scrOverall).toBeNull();
  });

  it('scores perfect recall when all hard constraints matched', () => {
    const bundle: ConstraintBundle = {
      hard: [
        { attribute: 'region', operator: '=', value: 'Bordeaux' },
        { attribute: 'grape', operator: '=', value: 'Merlot' },
      ],
      soft: [],
      inferred: [],
    };
    const expected = {
      hard: [
        { attribute: 'region', operator: '=' as const, value: 'bordeaux' },
        { attribute: 'grape', operator: '=' as const, value: 'merlot' },
      ],
    };
    const result = scoreSemanticConstraintRecall(bundle, expected, 'relaxed');
    expect(result.scrHard).toBe(1);
    expect(result.scrOverall).toBe(1);
    expect(result.missedConstraints).toHaveLength(0);
  });

  it('scores partial recall with missed constraints tracked', () => {
    const bundle: ConstraintBundle = {
      hard: [{ attribute: 'region', operator: '=', value: 'Bordeaux' }],
      soft: [],
      inferred: [],
    };
    const expected = {
      hard: [
        { attribute: 'region', operator: '=' as const, value: 'Bordeaux' },
        { attribute: 'grape', operator: '=' as const, value: 'Merlot' },
      ],
    };
    const result = scoreSemanticConstraintRecall(bundle, expected, 'relaxed');
    expect(result.scrHard).toBe(0.5);
    expect(result.missedConstraints).toHaveLength(1);
    expect(result.missedConstraints[0]!.attribute).toBe('grape');
  });

  it('computes weighted overall across hard+soft buckets', () => {
    const bundle: ConstraintBundle = {
      hard: [{ attribute: 'region', operator: '=', value: 'Bordeaux' }],
      soft: [{ attribute: 'body', operator: '>=', value: 0.7 }],
      inferred: [],
    };
    const expected = {
      hard: [{ attribute: 'region', operator: '=' as const, value: 'Bordeaux' }],
      soft: [
        { attribute: 'body', operator: '>=' as const, value: 0.7 },
        { attribute: 'style', operator: '=' as const, value: 'bold' },
      ],
    };
    const result = scoreSemanticConstraintRecall(bundle, expected, 'relaxed');
    expect(result.scrHard).toBe(1);
    expect(result.scrSoft).toBe(0.5);
    // overall = (1*0.6 + 0.5*0.2) / (0.6+0.2) = 0.7/0.8 = 0.875
    expect(result.scrOverall).toBeCloseTo(0.875, 5);
  });

  it('only-hard scenario: overall equals hard', () => {
    const bundle: ConstraintBundle = {
      hard: [{ attribute: 'grape', operator: '=', value: 'Merlot' }],
      soft: [],
      inferred: [],
    };
    const expected = {
      hard: [{ attribute: 'grape', operator: '=' as const, value: 'Merlot' }],
    };
    const result = scoreSemanticConstraintRecall(bundle, expected, 'relaxed');
    expect(result.scrHard).toBe(1);
    expect(result.scrSoft).toBeNull();
    expect(result.scrInferred).toBeNull();
    expect(result.scrOverall).toBe(1);
  });

  it('only-inferred scenario: overall equals inferred', () => {
    const bundle: ConstraintBundle = {
      hard: [],
      soft: [],
      inferred: [{ attribute: 'body', operator: '>=', value: 0.5 }],
    };
    const expected = {
      inferred: [{ attribute: 'body', operator: '>=' as const, value: 0.5 }],
    };
    const result = scoreSemanticConstraintRecall(bundle, expected, 'relaxed');
    expect(result.scrHard).toBeNull();
    expect(result.scrInferred).toBe(1);
    expect(result.scrOverall).toBe(1);
  });

  it('zero recall when no constraints extracted', () => {
    const result = scoreSemanticConstraintRecall(emptyBundle, {
      hard: [{ attribute: 'grape', operator: '=', value: 'Merlot' }],
    }, 'relaxed');
    expect(result.scrHard).toBe(0);
    expect(result.scrOverall).toBe(0);
    expect(result.missedConstraints).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// P2: Entity Linking Accuracy (ELA@1)
// ─────────────────────────────────────────────────────────────────────

describe('scoreEntityLinkingAccuracy', () => {
  it('returns all-null when no expected entities', () => {
    const result = scoreEntityLinkingAccuracy(undefined);
    expect(result.ela1).toBeNull();
    expect(result.precision).toBeNull();
    expect(result.recall).toBeNull();
    expect(result.f1).toBeNull();
    expect(result.linkErrors).toHaveLength(0);
  });

  it('returns all-null for empty expected array', () => {
    const result = scoreEntityLinkingAccuracy([]);
    expect(result.ela1).toBeNull();
  });

  it('resolves known wine type correctly', () => {
    const expected: ExpectedEntity[] = [
      { surface: 'red', canonical: 'red', type: 'wine_type' },
    ];
    const result = scoreEntityLinkingAccuracy(expected);
    expect(result.ela1).toBe(1);
    expect(result.precision).toBe(1);
    expect(result.linkErrors).toHaveLength(0);
  });

  it('resolves Korean region alias', () => {
    const expected: ExpectedEntity[] = [
      { surface: '보르도', canonical: 'Bordeaux', type: 'region' },
    ];
    const result = scoreEntityLinkingAccuracy(expected);
    expect(result.ela1).toBe(1);
  });

  it('reports unresolvable entity as error', () => {
    const expected: ExpectedEntity[] = [
      { surface: 'xyznonexistent', canonical: 'XYZ', type: 'region' },
    ];
    const result = scoreEntityLinkingAccuracy(expected);
    expect(result.ela1).toBe(0);
    expect(result.linkErrors).toHaveLength(1);
    expect(result.linkErrors[0]!.actualCanonical).toBeNull();
  });

  it('computes F1 for mixed success/failure', () => {
    const expected: ExpectedEntity[] = [
      { surface: 'red', canonical: 'red', type: 'wine_type' },
      { surface: 'xyznonexistent', canonical: 'XYZ', type: 'region' },
    ];
    const result = scoreEntityLinkingAccuracy(expected);
    expect(result.recall).toBe(0.5);
    expect(result.ela1).toBe(0.5);
    expect(result.linkErrors).toHaveLength(1);
  });

  it('handles accented Latin surface forms', () => {
    // "côtes du rhône" → should resolve if in the registry (depends on ontology)
    const expected: ExpectedEntity[] = [
      { surface: 'bordeaux', canonical: 'Bordeaux', type: 'region' },
    ];
    const result = scoreEntityLinkingAccuracy(expected);
    expect(result.ela1).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// P3: Slot F1
// ─────────────────────────────────────────────────────────────────────

describe('scoreSlotF1', () => {
  const emptyBundle: ConstraintBundle = { hard: [], soft: [], inferred: [] };

  it('returns all-null when no expected constraints', () => {
    const result = scoreSlotF1(emptyBundle, {});
    expect(result.strict).toBeNull();
    expect(result.relaxed).toBeNull();
    expect(result.typeOnly).toBeNull();
  });

  it('perfect strict F1 when extraction matches exactly', () => {
    const bundle: ConstraintBundle = {
      hard: [
        { attribute: 'region', operator: '=', value: 'Bordeaux' },
        { attribute: 'grape', operator: '=', value: 'Merlot' },
      ],
      soft: [],
      inferred: [],
    };
    const expected = {
      hard: [
        { attribute: 'region', operator: '=' as const, value: 'Bordeaux' },
        { attribute: 'grape', operator: '=' as const, value: 'Merlot' },
      ],
    };
    const result = scoreSlotF1(bundle, expected);
    expect(result.strict).toBeCloseTo(1.0, 5);
    expect(result.relaxed).toBeCloseTo(1.0, 5);
    expect(result.typeOnly).toBeCloseTo(1.0, 5);
  });

  it('F1=0 when nothing extracted but constraints expected', () => {
    const expected = {
      hard: [{ attribute: 'region', operator: '=' as const, value: 'Bordeaux' }],
    };
    const result = scoreSlotF1(emptyBundle, expected);
    expect(result.strict).toBe(0);
    expect(result.relaxed).toBe(0);
    expect(result.typeOnly).toBe(0);
  });

  it('computes partial F1 with extra extracted (FP) and missed (FN)', () => {
    const bundle: ConstraintBundle = {
      hard: [
        { attribute: 'region', operator: '=', value: 'Bordeaux' },
        { attribute: 'vintage', operator: '=', value: 2020 }, // FP
      ],
      soft: [],
      inferred: [],
    };
    const expected = {
      hard: [
        { attribute: 'region', operator: '=' as const, value: 'Bordeaux' },
        { attribute: 'grape', operator: '=' as const, value: 'Merlot' }, // FN
      ],
    };
    const result = scoreSlotF1(bundle, expected);
    // TP=1, FP=1, FN=1 → P=0.5, R=0.5, F1=0.5
    expect(result.strict).toBeCloseTo(0.5, 5);
  });

  it('relaxed F1 higher than strict when operator flexes', () => {
    const bundle: ConstraintBundle = {
      hard: [{ attribute: 'price', operator: 'range', value: { min: 0, max: 50 } }],
      soft: [],
      inferred: [],
    };
    const expected = {
      hard: [{ attribute: 'price', operator: '<=' as const, value: 50 }],
    };
    const result = scoreSlotF1(bundle, expected);
    expect(result.strict).toBe(0);       // operator mismatch
    expect(result.relaxed).toBeGreaterThan(0); // operator flexes
  });

  it('type_only F1 highest when attribute matches but value differs', () => {
    const bundle: ConstraintBundle = {
      hard: [{ attribute: 'grape', operator: '=', value: 'Merlot' }],
      soft: [],
      inferred: [],
    };
    const expected = {
      hard: [{ attribute: 'grape', operator: '=' as const, value: 'Cabernet Sauvignon' }],
    };
    const result = scoreSlotF1(bundle, expected);
    expect(result.strict).toBe(0);
    expect(result.relaxed).toBe(0);
    expect(result.typeOnly).toBeCloseTo(1.0, 5);
  });

  it('flattens across hard+soft+inferred for F1 computation', () => {
    const bundle: ConstraintBundle = {
      hard: [{ attribute: 'region', operator: '=', value: 'Bordeaux' }],
      soft: [{ attribute: 'body', operator: '>=', value: 0.7 }],
      inferred: [{ attribute: 'price', operator: 'range', value: { min: 20, max: 50 } }],
    };
    const expected = {
      hard: [{ attribute: 'region', operator: '=' as const, value: 'Bordeaux' }],
      soft: [{ attribute: 'body', operator: '>=' as const, value: 0.7 }],
      inferred: [{ attribute: 'price', operator: 'range' as const, value: { min: 20, max: 50 } }],
    };
    const result = scoreSlotF1(bundle, expected);
    // All 3 match → TP=3, FP=0, FN=0 → F1=1.0
    expect(result.strict).toBeCloseTo(1.0, 5);
  });
});
