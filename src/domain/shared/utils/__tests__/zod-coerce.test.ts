import { describe, expect, it } from 'vitest';
import { coerceFiniteNumber, coercePositiveInt, coerceNonNegativeInt } from '../zod-coerce.js';
import { z } from 'zod';

// E4-T2: BUG-DS02 — LLM numeric string coercion utility
describe('coerceFiniteNumber', () => {
  it('accepts a numeric string', () => {
    expect(coerceFiniteNumber.parse('3.14')).toBe(3.14);
  });

  it('accepts a plain number', () => {
    expect(coerceFiniteNumber.parse(42)).toBe(42);
  });

  it('rejects a non-numeric string', () => {
    expect(() => coerceFiniteNumber.parse('abc')).toThrow();
  });

  it('rejects NaN from non-numeric string', () => {
    expect(() => coerceFiniteNumber.parse('not-a-number')).toThrow();
  });

  it('rejects Infinity', () => {
    expect(() => coerceFiniteNumber.parse(Infinity)).toThrow();
  });

  // LLMs may emit the string literal "NaN", "-Infinity", or "" — all must reject
  it('rejects the string literal "NaN"', () => {
    expect(() => coerceFiniteNumber.parse('NaN')).toThrow();
  });

  it('rejects "-Infinity"', () => {
    expect(() => coerceFiniteNumber.parse('-Infinity')).toThrow();
  });

  it('rejects the string "Infinity"', () => {
    expect(() => coerceFiniteNumber.parse('Infinity')).toThrow();
  });

  it('rejects empty string ""', () => {
    expect(() => coerceFiniteNumber.parse('')).toThrow();
  });

  it('accepts 0', () => {
    expect(coerceFiniteNumber.parse(0)).toBe(0);
  });

  it('accepts negative number -42.5', () => {
    expect(coerceFiniteNumber.parse(-42.5)).toBe(-42.5);
  });
});

describe('coercePositiveInt', () => {
  it('accepts integer string "10"', () => {
    expect(coercePositiveInt.parse('10')).toBe(10);
  });

  it('accepts plain integer 10', () => {
    expect(coercePositiveInt.parse(10)).toBe(10);
  });

  it('rejects "abc"', () => {
    expect(() => coercePositiveInt.parse('abc')).toThrow();
  });

  it('rejects 0 (must be positive)', () => {
    expect(() => coercePositiveInt.parse(0)).toThrow();
  });

  it('rejects negative integers', () => {
    expect(() => coercePositiveInt.parse(-1)).toThrow();
  });
});

describe('coerceNonNegativeInt', () => {
  it('accepts "0"', () => {
    expect(coerceNonNegativeInt.parse('0')).toBe(0);
  });

  it('accepts 0', () => {
    expect(coerceNonNegativeInt.parse(0)).toBe(0);
  });

  it('accepts "5"', () => {
    expect(coerceNonNegativeInt.parse('5')).toBe(5);
  });

  it('rejects negative', () => {
    expect(() => coerceNonNegativeInt.parse(-1)).toThrow();
  });
});

// E4-T2: LLM tool call schema should not use .strict() — extra fields pass through
describe('agent tool schema (no .strict())', () => {
  const LimitSchema = z.object({
    limit: coercePositiveInt.optional(),
  });

  it('parses {limit: "10"} as limit=10', () => {
    expect(LimitSchema.parse({ limit: '10' })).toEqual({ limit: 10 });
  });

  it('parses {limit: 10} as limit=10', () => {
    expect(LimitSchema.parse({ limit: 10 })).toEqual({ limit: 10 });
  });

  it('fails on {limit: "abc"}', () => {
    expect(() => LimitSchema.parse({ limit: 'abc' })).toThrow();
  });

  it('passes with extra fields (no .strict())', () => {
    // LLMs routinely emit extra fields — .strict() would break this
    const result = LimitSchema.parse({ limit: '10', extra_field: 'ignored' });
    expect(result.limit).toBe(10);
  });
});
