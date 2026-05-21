import { describe, expect, it } from 'vitest';
import {
  expandTwoDigitVintage,
  expandVintageVariants,
} from '../vintage-normalizer.js';

describe('expandTwoDigitVintage — century inference rule', () => {
  it('treats dd <= cc + 5 as current-century primary, previous-century secondary (cc=26)', () => {
    expect(expandTwoDigitVintage(15, { nowYear: 2026 })).toEqual([2015, 1915]);
    expect(expandTwoDigitVintage(20, { nowYear: 2026 })).toEqual([2020, 1920]);
    expect(expandTwoDigitVintage(26, { nowYear: 2026 })).toEqual([2026, 1926]);
    expect(expandTwoDigitVintage(31, { nowYear: 2026 })).toEqual([2031, 1931]);
  });

  it('flips to previous-century primary above the cc+5 buffer (cc=26)', () => {
    // Far-future secondaries beyond nowYear+5 get filtered (see dedicated test).
    expect(expandTwoDigitVintage(50, { nowYear: 2026 })).toEqual([1950]);
    expect(expandTwoDigitVintage(99, { nowYear: 2026 })).toEqual([1999]);
  });

  it('filters candidates outside the commercially-relevant vintage range', () => {
    // Vintages older than 1850 are excluded — 1849 from dd=49, cc=49 (year 2049)
    // shouldn't drop in this case, but very far futures do.
    // Future-year filtering: nowYear=2026, max=2028
    const cands = expandTwoDigitVintage(28, { nowYear: 2026 });
    expect(cands).toContain(2028);
    // 2128 (next-century reading) is excluded — far future not a real vintage
  });

  it('rejects future vintages beyond the documented buffer (nowYear + 5)', () => {
    // dd=32 with nowYear=2026 → 32 > cc+5 → primary previous-century=1932,
    // secondary current-century=2032 which is > 2031 (nowYear+5) → excluded
    expect(expandTwoDigitVintage(32, { nowYear: 2026 })).toEqual([1932]);
  });

  it('rejects pre-1850 candidates', () => {
    // dd=49, cc=49 (year 1949) — current-century reading is 1949, previous would be 1849
    // 1849 < MIN_VINTAGE (1850), so only 1949 should remain
    const cands = expandTwoDigitVintage(49, { nowYear: 1949 });
    expect(cands).toContain(1949);
    expect(cands).not.toContain(1849);
  });

  it('returns empty array for invalid dd (non-integer, negative, >99)', () => {
    expect(expandTwoDigitVintage(-1)).toEqual([]);
    expect(expandTwoDigitVintage(100)).toEqual([]);
    expect(expandTwoDigitVintage(NaN)).toEqual([]);
    expect(expandTwoDigitVintage(1.5)).toEqual([]);
  });

  it('is deterministic — same input → same output', () => {
    const a = expandTwoDigitVintage(15, { nowYear: 2026 });
    const b = expandTwoDigitVintage(15, { nowYear: 2026 });
    expect(a).toEqual(b);
  });
});

describe('expandVintageVariants — query rewriting', () => {
  it('expands a 2-digit token preceded by an English wine alias (primary only)', () => {
    expect(expandVintageVariants('Margaux 15', { nowYear: 2026 })).toEqual(['Margaux 2015']);
  });

  it('handles initialism + 2-digit ("CM 15") — primary current-century only', () => {
    expect(expandVintageVariants('CM 15', { nowYear: 2026 })).toEqual(['CM 2015']);
  });

  it('expands 2-digit token after a Korean alias (Unicode-safe word boundary)', () => {
    expect(expandVintageVariants('샤또마고 15', { nowYear: 2026 })).toEqual(['샤또마고 2015']);
  });

  it('returns empty array when the query already carries a 4-digit vintage (unambiguous)', () => {
    expect(expandVintageVariants('Margaux 2015', { nowYear: 2026 })).toEqual([]);
    expect(expandVintageVariants('Opus One 1985', { nowYear: 2026 })).toEqual([]);
  });

  it('returns empty array for queries without any 2-digit token', () => {
    expect(expandVintageVariants('Opus One', { nowYear: 2026 })).toEqual([]);
    expect(expandVintageVariants('hello world', { nowYear: 2026 })).toEqual([]);
  });

  it('returns empty for empty input', () => {
    expect(expandVintageVariants('', { nowYear: 2026 })).toEqual([]);
  });

  it('only expands the first 2-digit token (multi-vintage out of scope)', () => {
    const variants = expandVintageVariants('Margaux 15 Latour 16', { nowYear: 2026 });
    // The first '15' is expanded; '16' stays untouched in the variants.
    expect(variants.some((v) => v.includes('2015'))).toBe(true);
    expect(variants.every((v) => v.includes('16'))).toBe(true);
  });

  it('detects 2-digit at the very start of a query (primary only)', () => {
    expect(expandVintageVariants('15 Margaux', { nowYear: 2026 })).toEqual(['2015 Margaux']);
  });

  it('is deterministic across repeated calls', () => {
    const a = expandVintageVariants('Margaux 15', { nowYear: 2026 });
    const b = expandVintageVariants('Margaux 15', { nowYear: 2026 });
    expect(a).toEqual(b);
  });
});
