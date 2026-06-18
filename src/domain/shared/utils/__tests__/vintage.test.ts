import { describe, it, expect } from 'vitest';
import {
  VINTAGE_YEAR_RAW,
  extractVintageYear,
  extractQueryVintageYear,
  stripVintageYears,
  stripVintageYearsBounded,
  hasVintageYear,
  extractVintageRange,
  extractKoreanVintageAfter,
  extractKoreanVintageBefore,
  isVintageYearToken,
  isTwoDigitVintageToken,
  isPotentialVintageToken,
  canonicalizeVintageToken,
} from '../vintage.js';

// ---------------------------------------------------------------------------
// extractVintageYear
// ---------------------------------------------------------------------------
describe('extractVintageYear', () => {
  it('extracts a standalone 4-digit vintage', () => {
    expect(extractVintageYear('Margaux 2015')).toBe(2015);
  });

  it('extracts the first vintage when multiple exist', () => {
    expect(extractVintageYear('2018 vs 2020')).toBe(2018);
  });

  it('returns null for empty string', () => {
    expect(extractVintageYear('')).toBeNull();
  });

  it('returns null for text without a vintage', () => {
    expect(extractVintageYear('Opus One')).toBeNull();
  });

  it('rejects embedded years (12015 should NOT match 2015)', () => {
    expect(extractVintageYear('code12015end')).toBeNull();
  });

  it('rejects 18xx years (too old for wine catalog)', () => {
    expect(extractVintageYear('1890')).toBeNull();
  });

  it('accepts boundary: 1900 (earliest valid)', () => {
    expect(extractVintageYear('vintage 1900')).toBe(1900);
  });

  it('accepts boundary: 2099 (latest valid)', () => {
    expect(extractVintageYear('year 2099')).toBe(2099);
  });

  it('returns null for 2100 (out of range)', () => {
    expect(extractVintageYear('year 2100')).toBeNull();
  });

  // CLAUDE.md rule 5: Korean input
  it('extracts vintage from Korean text ("2020년산 와인")', () => {
    expect(extractVintageYear('2020년산 와인')).toBe(2020);
  });

  // CLAUDE.md rule 5: accented Latin
  it('extracts vintage from accented Latin ("Château Margaux 2018")', () => {
    expect(extractVintageYear('Château Margaux 2018')).toBe(2018);
  });

  // CLAUDE.md rule 5: emoji
  it('extracts vintage from emoji-laden text ("🍷 2019 best")', () => {
    expect(extractVintageYear('🍷 2019 best')).toBe(2019);
  });
});

describe('extractQueryVintageYear', () => {
  it('extracts a single standalone two-digit shorthand from a lookup query', () => {
    expect(extractQueryVintageYear('오퍼스 원 18', 2026)).toBe(2018);
    expect(extractQueryVintageYear('샤또 라뚜르 09', 2026)).toBe(2009);
  });

  it('rejects bare numeric queries without a lexical wine surface', () => {
    expect(extractQueryVintageYear('18', 2026)).toBeNull();
  });

  it('rejects multiple two-digit candidates in one query', () => {
    expect(extractQueryVintageYear('와인 18 19', 2026)).toBeNull();
  });

  it('still prefers a real four-digit vintage when present', () => {
    expect(extractQueryVintageYear('오퍼스 원 2018', 2026)).toBe(2018);
  });
});

// ---------------------------------------------------------------------------
// stripVintageYears (unbounded — label cleanup)
// ---------------------------------------------------------------------------
describe('stripVintageYears', () => {
  it('strips single vintage from label', () => {
    expect(stripVintageYears('Opus One 2018')).toBe('Opus One ');
  });

  it('strips multiple vintages', () => {
    expect(stripVintageYears('2018 2019 2020')).toBe('  ');
  });

  it('returns empty string for vintage-only input', () => {
    expect(stripVintageYears('2020')).toBe('');
  });

  it('leaves non-vintage text unchanged', () => {
    expect(stripVintageYears('Opus One')).toBe('Opus One');
  });

  it('strips embedded vintage (no boundary check)', () => {
    // unbounded strip intentionally catches sub-string matches for label cleanup
    expect(stripVintageYears('A2020B')).toBe('AB');
  });
});

// ---------------------------------------------------------------------------
// stripVintageYearsBounded (query text — preserves embedded digits)
// ---------------------------------------------------------------------------
describe('stripVintageYearsBounded', () => {
  it('strips standalone vintage', () => {
    expect(stripVintageYearsBounded('Margaux 2015 wine').trim()).toBe('Margaux  wine');
  });

  it('does NOT strip embedded vintage (e.g. "A2020B")', () => {
    expect(stripVintageYearsBounded('A2020B')).toBe('A2020B');
  });

  it('does NOT strip embedded in longer number ("12015")', () => {
    expect(stripVintageYearsBounded('code12015end')).toBe('code12015end');
  });

  it('strips when bounded by Korean ("와인 2020 추천")', () => {
    expect(stripVintageYearsBounded('와인 2020 추천')).toBe('와인  추천');
  });
});

// ---------------------------------------------------------------------------
// hasVintageYear
// ---------------------------------------------------------------------------
describe('hasVintageYear', () => {
  it('returns true for text with vintage', () => {
    expect(hasVintageYear('Margaux 2015')).toBe(true);
  });

  it('returns false for no vintage', () => {
    expect(hasVintageYear('Opus One')).toBe(false);
  });

  it('returns false for embedded vintage', () => {
    expect(hasVintageYear('code12015end')).toBe(false);
  });

  it('returns true for Korean query with vintage', () => {
    expect(hasVintageYear('보르도 2018년 추천')).toBe(true);
  });

  it('returns true for "Opus One 2018"', () => {
    expect(hasVintageYear('Opus One 2018')).toBe(true);
  });

  it('returns false for "Opus One" (no vintage)', () => {
    expect(hasVintageYear('Opus One')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractVintageRange
// ---------------------------------------------------------------------------
describe('extractVintageRange', () => {
  it('extracts hyphen range', () => {
    expect(extractVintageRange('2018-2022')).toEqual({ min: 2018, max: 2022 });
  });

  it('extracts tilde range', () => {
    expect(extractVintageRange('2018~2022')).toEqual({ min: 2018, max: 2022 });
  });

  it('extracts en-dash range', () => {
    expect(extractVintageRange('2018–2022')).toEqual({ min: 2018, max: 2022 });
  });

  it('normalizes reversed range', () => {
    expect(extractVintageRange('2022-2018')).toEqual({ min: 2018, max: 2022 });
  });

  it('returns null for no range', () => {
    expect(extractVintageRange('just 2020')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractVintageRange('')).toBeNull();
  });

  it('rejects range embedded in longer number ("12015-2020")', () => {
    expect(extractVintageRange('12015-2020')).toBeNull();
  });

  it('handles Korean context ("2018~2022년 와인")', () => {
    expect(extractVintageRange('2018~2022년 와인')).toEqual({ min: 2018, max: 2022 });
  });
});

// ---------------------------------------------------------------------------
// extractKoreanVintageAfter / Before
// ---------------------------------------------------------------------------
describe('extractKoreanVintageAfter', () => {
  it('extracts "2018년 이후"', () => {
    expect(extractKoreanVintageAfter('좋은 와인 2018년 이후')).toBe(2018);
  });

  it('extracts "2018 이후" (no 년)', () => {
    expect(extractKoreanVintageAfter('2018 이후 추천')).toBe(2018);
  });

  it('returns null for English text', () => {
    expect(extractKoreanVintageAfter('after 2018')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractKoreanVintageAfter('')).toBeNull();
  });

  it('returns null when year is out of vintage range (1800 이후)', () => {
    expect(extractKoreanVintageAfter('1800년 이후')).toBeNull();
  });
});

describe('extractKoreanVintageBefore', () => {
  it('extracts "2020년 이전"', () => {
    expect(extractKoreanVintageBefore('2020년 이전 와인')).toBe(2020);
  });

  it('extracts "2020 이전" (no 년)', () => {
    expect(extractKoreanVintageBefore('2020 이전')).toBe(2020);
  });

  it('returns null for no match', () => {
    expect(extractKoreanVintageBefore('Opus One 2020')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isVintageYearToken
// ---------------------------------------------------------------------------
describe('isVintageYearToken', () => {
  it.each(['1900', '1999', '2000', '2024', '2099'])(
    'accepts valid 4-digit token "%s"',
    (token) => {
      expect(isVintageYearToken(token)).toBe(true);
    },
  );

  it.each(['1899', '2100', '18xx', '20', '', '12015', 'abcd'])(
    'rejects invalid token "%s"',
    (token) => {
      expect(isVintageYearToken(token)).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// isTwoDigitVintageToken
// ---------------------------------------------------------------------------
describe('isTwoDigitVintageToken', () => {
  it.each(['00', '24', '99'])('accepts "%s"', (token) => {
    expect(isTwoDigitVintageToken(token)).toBe(true);
  });

  it.each(['0', '100', '2024', '', 'ab'])('rejects "%s"', (token) => {
    expect(isTwoDigitVintageToken(token)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPotentialVintageToken
// ---------------------------------------------------------------------------
describe('isPotentialVintageToken', () => {
  it('accepts 4-digit vintage', () => {
    expect(isPotentialVintageToken('2020')).toBe(true);
  });

  it('accepts 2-digit shorthand', () => {
    expect(isPotentialVintageToken('20')).toBe(true);
  });

  it('rejects 3-digit number', () => {
    expect(isPotentialVintageToken('202')).toBe(false);
  });

  it('accepts 2-digit "21"', () => {
    expect(isPotentialVintageToken('21')).toBe(true);
  });

  it('accepts 4-digit "2021"', () => {
    expect(isPotentialVintageToken('2021')).toBe(true);
  });

  it('rejects non-numeric "abc"', () => {
    expect(isPotentialVintageToken('abc')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// canonicalizeVintageToken
// ---------------------------------------------------------------------------
describe('canonicalizeVintageToken', () => {
  // Use fixed referenceYear=2026 for deterministic tests
  const REF = 2026;

  it('passes through 4-digit token unchanged', () => {
    expect(canonicalizeVintageToken('2020', REF)).toBe('2020');
  });

  it('passes through non-vintage token unchanged', () => {
    expect(canonicalizeVintageToken('hello', REF)).toBe('hello');
  });

  it('converts recent 2-digit: "24" → "2024"', () => {
    expect(canonicalizeVintageToken('24', REF)).toBe('2024');
  });

  it('converts "21" → "2021" at reference year 2026 (≤ pivot)', () => {
    expect(canonicalizeVintageToken('21', REF)).toBe('2021');
  });

  it('converts "99" → "1999" at reference year 2026 (> pivot)', () => {
    expect(canonicalizeVintageToken('99', REF)).toBe('1999');
  });

  it('converts boundary pivot: "26" → "2026" (current year)', () => {
    expect(canonicalizeVintageToken('26', REF)).toBe('2026');
  });

  it('converts above pivot: "27" → "1927" (previous century)', () => {
    expect(canonicalizeVintageToken('27', REF)).toBe('1927');
  });

  it('converts far above: "98" → "1998"', () => {
    expect(canonicalizeVintageToken('98', REF)).toBe('1998');
  });

  it('converts "00" → "2000"', () => {
    expect(canonicalizeVintageToken('00', REF)).toBe('2000');
  });

  it('returns empty string unchanged', () => {
    expect(canonicalizeVintageToken('', REF)).toBe('');
  });

  it('returns 3-digit token unchanged', () => {
    expect(canonicalizeVintageToken('202', REF)).toBe('202');
  });
});

// ---------------------------------------------------------------------------
// VINTAGE_YEAR_RAW (composability)
// ---------------------------------------------------------------------------
describe('VINTAGE_YEAR_RAW', () => {
  it('compiles into a valid regex', () => {
    const re = new RegExp(VINTAGE_YEAR_RAW);
    expect(re.test('2020')).toBe(true);
    expect(re.test('1899')).toBe(false);
  });
});
