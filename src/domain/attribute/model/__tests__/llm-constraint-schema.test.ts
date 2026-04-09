import { describe, it, expect } from 'vitest';
import {
  LlmConstraintItemSchema,
  LlmConstraintResponseSchema,
} from '../llm-constraint-schema.js';

const VALID_BASE = {
  phrase: 'test',
  attribute: 'body',
  operator: '=' as const,
  value: 'medium',
  confidence: 0.8,
};

// ─────────────────────────────────────────────────────────────────────
// z.number().finite() on value field
// ─────────────────────────────────────────────────────────────────────

describe('LlmConstraintItemSchema — value .finite()', () => {
  it('accepts finite number value', () => {
    expect(LlmConstraintItemSchema.safeParse({ ...VALID_BASE, value: 42 }).success).toBe(true);
  });

  it('accepts zero', () => {
    expect(LlmConstraintItemSchema.safeParse({ ...VALID_BASE, value: 0 }).success).toBe(true);
  });

  it('rejects NaN', () => {
    expect(LlmConstraintItemSchema.safeParse({ ...VALID_BASE, value: Number.NaN }).success).toBe(false);
  });

  it('rejects Infinity', () => {
    expect(LlmConstraintItemSchema.safeParse({ ...VALID_BASE, value: Number.POSITIVE_INFINITY }).success).toBe(false);
  });

  it('rejects -Infinity', () => {
    expect(LlmConstraintItemSchema.safeParse({ ...VALID_BASE, value: Number.NEGATIVE_INFINITY }).success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// z.number().finite() on range min/max
// ─────────────────────────────────────────────────────────────────────

describe('LlmConstraintItemSchema — range .finite()', () => {
  it('accepts valid range', () => {
    expect(LlmConstraintItemSchema.safeParse({
      ...VALID_BASE, operator: 'range', value: { min: 10, max: 50 },
    }).success).toBe(true);
  });

  it('rejects NaN min', () => {
    expect(LlmConstraintItemSchema.safeParse({
      ...VALID_BASE, operator: 'range', value: { min: Number.NaN, max: 50 },
    }).success).toBe(false);
  });

  it('rejects Infinity max', () => {
    expect(LlmConstraintItemSchema.safeParse({
      ...VALID_BASE, operator: 'range', value: { min: 10, max: Number.POSITIVE_INFINITY },
    }).success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// .max(50) on array value
// ─────────────────────────────────────────────────────────────────────

describe('LlmConstraintItemSchema — array .max(50)', () => {
  it('accepts array at max (50)', () => {
    expect(LlmConstraintItemSchema.safeParse({
      ...VALID_BASE, operator: 'in', value: Array.from({ length: 50 }, (_, i) => `v${i}`),
    }).success).toBe(true);
  });

  it('rejects array at max+1 (51)', () => {
    expect(LlmConstraintItemSchema.safeParse({
      ...VALID_BASE, operator: 'in', value: Array.from({ length: 51 }, (_, i) => `v${i}`),
    }).success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// .max(30) on response array
// ─────────────────────────────────────────────────────────────────────

describe('LlmConstraintResponseSchema — .max(30)', () => {
  it('accepts array at max (30)', () => {
    const items = Array.from({ length: 30 }, () => VALID_BASE);
    expect(LlmConstraintResponseSchema.safeParse(items).success).toBe(true);
  });

  it('rejects array at max+1 (31)', () => {
    const items = Array.from({ length: 31 }, () => VALID_BASE);
    expect(LlmConstraintResponseSchema.safeParse(items).success).toBe(false);
  });

  it('accepts empty array', () => {
    expect(LlmConstraintResponseSchema.safeParse([]).success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// confidence [0, 1]
// ─────────────────────────────────────────────────────────────────────

describe('LlmConstraintItemSchema — confidence bounds', () => {
  it('accepts 0', () => {
    expect(LlmConstraintItemSchema.safeParse({ ...VALID_BASE, confidence: 0 }).success).toBe(true);
  });

  it('accepts 1', () => {
    expect(LlmConstraintItemSchema.safeParse({ ...VALID_BASE, confidence: 1 }).success).toBe(true);
  });

  it('rejects -0.1', () => {
    expect(LlmConstraintItemSchema.safeParse({ ...VALID_BASE, confidence: -0.1 }).success).toBe(false);
  });

  it('rejects 1.1', () => {
    expect(LlmConstraintItemSchema.safeParse({ ...VALID_BASE, confidence: 1.1 }).success).toBe(false);
  });

  it('rejects NaN', () => {
    expect(LlmConstraintItemSchema.safeParse({ ...VALID_BASE, confidence: Number.NaN }).success).toBe(false);
  });

  it('rejects Infinity', () => {
    expect(LlmConstraintItemSchema.safeParse({ ...VALID_BASE, confidence: Number.POSITIVE_INFINITY }).success).toBe(false);
  });

  it('rejects -Infinity', () => {
    expect(LlmConstraintItemSchema.safeParse({ ...VALID_BASE, confidence: Number.NEGATIVE_INFINITY }).success).toBe(false);
  });
});
