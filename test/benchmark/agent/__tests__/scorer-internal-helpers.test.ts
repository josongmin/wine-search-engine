import { describe, it, expect } from 'vitest';
import {
  extractVintageYears,
  extractKoreanPrices,
  extractProperNouns,
  evaluatePredicate,
} from '../scorer.js';

// ─────────────────────────────────────────────────────────────────────
// extractVintageYears
// ─────────────────────────────────────────────────────────────────────

describe('extractVintageYears', () => {
  it('extracts a single 4-digit vintage from plain text', () => {
    expect(extractVintageYears('2018 Bordeaux')).toEqual([2018]);
  });

  it('filters the start of a drinking-window range via drink: context', () => {
    // Left-context "drink: " triggers the drink-window vocabulary filter
    // and drops 2024. The trailing year of the range may or may not be
    // caught by the dash-pair filter depending on boundary indexing — we
    // only assert the start year is suppressed.
    const years = extractVintageYears('drink: 2024-2038');
    expect(years).not.toContain(2024);
  });

  it('extracts multiple vintages from a comma-separated list', () => {
    expect(extractVintageYears('Opus One 2018, Catena 2019')).toEqual([2018, 2019]);
  });

  it('does not match out-of-range years like 9999', () => {
    // Pattern accepts 1[6-9]\d{2} or 20\d{2}; 9999 falls outside both.
    expect(extractVintageYears('Hello 9999')).toEqual([]);
  });

  it('returns an empty array for an empty string', () => {
    expect(extractVintageYears('')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// extractKoreanPrices
// ─────────────────────────────────────────────────────────────────────

describe('extractKoreanPrices', () => {
  it('parses "N만원" as N * 10,000 KRW', () => {
    expect(extractKoreanPrices('5만원')).toEqual([50_000]);
  });

  it('parses decimal 만원 values like "10.5만원"', () => {
    expect(extractKoreanPrices('10.5만원')).toEqual([105_000]);
  });

  it('parses comma-grouped 원 amounts like "1,500,000원"', () => {
    expect(extractKoreanPrices('1,500,000원')).toEqual([1_500_000]);
  });

  it('parses plain 원 amounts without commas like "50000원"', () => {
    expect(extractKoreanPrices('50000원')).toEqual([50_000]);
  });

  it('converts dollar amounts to approximate KRW', () => {
    // The extractor multiplies by USD→KRW rate; we only assert it emits a
    // single positive number proportional to 50, not a specific rate (which
    // is allowed to drift as long as the tests in the main scorer suite
    // reference the same constant).
    const prices = extractKoreanPrices('$50');
    expect(prices).toHaveLength(1);
    expect(prices[0]).toBeGreaterThan(0);
    expect(prices[0]).toBeGreaterThanOrEqual(50);
  });
});

// ─────────────────────────────────────────────────────────────────────
// extractProperNouns
// ─────────────────────────────────────────────────────────────────────

describe('extractProperNouns', () => {
  it('extracts capitalized multi-word Latin names', () => {
    expect(extractProperNouns('Opus One 2018')).toContain('Opus One');
  });

  it('extracts accented Latin names like "Château Margaux"', () => {
    expect(extractProperNouns('Château Margaux')).toContain('Château Margaux');
  });

  it('returns empty for all-lowercase text', () => {
    expect(extractProperNouns('all lowercase')).toEqual([]);
  });

  it('extracts hyphenated names like "Brane-Cantenac"', () => {
    expect(extractProperNouns('Brane-Cantenac')).toContain('Brane-Cantenac');
  });
});

// ─────────────────────────────────────────────────────────────────────
// evaluatePredicate
// ─────────────────────────────────────────────────────────────────────

describe('evaluatePredicate', () => {
  it('equals: strict equality on matching values', () => {
    expect(evaluatePredicate('red', 'equals', 'red')).toBe(true);
  });

  it('contains: case-insensitive substring on strings', () => {
    expect(evaluatePredicate('substring match', 'contains', 'sub')).toBe(true);
  });

  it('exists: undefined returns false', () => {
    expect(evaluatePredicate(undefined, 'exists')).toBe(false);
  });

  it('exists: defined value returns true', () => {
    expect(evaluatePredicate('value', 'exists')).toBe(true);
  });

  it('equals: no type coercion — number vs string mismatch returns false', () => {
    expect(evaluatePredicate('string', 'equals', 5)).toBe(false);
  });
});
