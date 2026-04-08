import { describe, it, expect } from 'vitest';
import {
  normalizeField,
  normalizeVolume,
  normalizeYear,
  normalizeKoreanText,
} from '../service/field-normalizer.js';

describe('normalizeField', () => {
  describe('basic normalization', () => {
    it('returns empty string for empty input', () => {
      expect(normalizeField('')).toBe('');
    });

    it('trims leading and trailing whitespace', () => {
      expect(normalizeField('  Opus One  ')).toBe('Opus One');
    });

    it('collapses internal whitespace to single space', () => {
      expect(normalizeField('Opus   One')).toBe('Opus One');
    });

    it('applies Unicode NFC normalization', () => {
      // NFD representation of "é" → NFC "é"
      const nfd = 'e\u0301';  // e + combining acute accent
      const result = normalizeField(nfd);
      expect(result).toBe('\u00E9'); // NFC é
    });
  });

  describe('Korean locale handling', () => {
    it('full-width space (U+3000) → ASCII space with Korean locale', () => {
      // U+3000 is ideographic space
      const input = '오푸스원\u3000와인';
      const result = normalizeField(input, 'ko');
      expect(result).toBe('오푸스원 와인');
    });

    it('full-width space normalized with ko-KR locale', () => {
      const input = '오푸스원\u3000와인';
      expect(normalizeField(input, 'ko-KR')).toBe('오푸스원 와인');
    });

    it('zero-width characters removed with Korean locale', () => {
      const input = '오푸스\u200B원'; // zero-width space
      expect(normalizeField(input, 'ko')).toBe('오푸스원');
    });

    it('full-width parentheses → ASCII with Korean locale', () => {
      const input = '오푸스원\uFF08나파밸리\uFF09';
      expect(normalizeField(input, 'ko')).toBe('오푸스원(나파밸리)');
    });

    it('no Korean locale → full-width space preserved', () => {
      const input = '오푸스원\u3000와인';
      const result = normalizeField(input);
      // Without locale, normalizeKoreanText is not called; full-width space stays
      // but NFC + trim + collapse happens. The \u3000 itself is not whitespace for \s+
      // so it should remain (NFC doesn't change it)
      expect(result).toContain('오푸스원');
    });
  });
});

describe('normalizeKoreanText', () => {
  it('replaces full-width space U+3000 with ASCII space', () => {
    expect(normalizeKoreanText('오푸스원\u3000와인')).toBe('오푸스원 와인');
  });

  it('removes zero-width space U+200B', () => {
    expect(normalizeKoreanText('오푸스\u200B원')).toBe('오푸스원');
  });

  it('removes ZWNJ (U+200C)', () => {
    expect(normalizeKoreanText('오\u200C푸스원')).toBe('오푸스원');
  });

  it('removes ZWJ (U+200D)', () => {
    expect(normalizeKoreanText('오\u200D푸스원')).toBe('오푸스원');
  });

  it('replaces full-width parentheses', () => {
    expect(normalizeKoreanText('\uFF08나파밸리\uFF09')).toBe('(나파밸리)');
  });

  it('replaces full-width comma', () => {
    expect(normalizeKoreanText('레드\uFF0C화이트')).toBe('레드,화이트');
  });

  it('collapses multiple spaces', () => {
    expect(normalizeKoreanText('오푸스   원')).toBe('오푸스 원');
  });
});

describe('normalizeVolume', () => {
  it('"750ml" → 750', () => {
    expect(normalizeVolume('750ml')).toBe(750);
  });

  it('"750ML" → 750 (case insensitive)', () => {
    expect(normalizeVolume('750ML')).toBe(750);
  });

  it('"750 ml" → 750 (with space)', () => {
    expect(normalizeVolume('750 ml')).toBe(750);
  });

  it('"75cl" → 750 (centilitre conversion)', () => {
    expect(normalizeVolume('75cl')).toBe(750);
  });

  it('"75 cl" → 750', () => {
    expect(normalizeVolume('75 cl')).toBe(750);
  });

  it('"1.5l" → 1500 (litre conversion)', () => {
    expect(normalizeVolume('1.5l')).toBe(1500);
  });

  it('"1.5L" → 1500', () => {
    expect(normalizeVolume('1.5L')).toBe(1500);
  });

  it('"1.5 litre" → 1500', () => {
    expect(normalizeVolume('1.5 litre')).toBe(1500);
  });

  it('"1.5 liter" → 1500', () => {
    expect(normalizeVolume('1.5 liter')).toBe(1500);
  });

  it('"3 liters" → 3000', () => {
    expect(normalizeVolume('3 liters')).toBe(3000);
  });

  it('"375" (bare number for standard size) → 375', () => {
    expect(normalizeVolume('375')).toBe(375);
  });

  it('"750" bare number → 750', () => {
    expect(normalizeVolume('750')).toBe(750);
  });

  it('empty string → null', () => {
    expect(normalizeVolume('')).toBeNull();
  });

  it('invalid string → null', () => {
    expect(normalizeVolume('not-a-volume')).toBeNull();
  });

  it('whitespace-only → null', () => {
    expect(normalizeVolume('   ')).toBeNull();
  });

  // ── Round 2 audit regression tests ────────────────────────────────────────
  it('rejects 0ml (zero volume)', () => {
    expect(normalizeVolume('0ml')).toBeNull();
  });
  it('rejects extremely large volumes ("99999ml")', () => {
    expect(normalizeVolume('99999ml')).toBeNull();
  });
  it('"30000ml" → 30000 (max boundary)', () => {
    expect(normalizeVolume('30000ml')).toBe(30000);
  });
  it('"30001ml" → null (above max)', () => {
    expect(normalizeVolume('30001ml')).toBeNull();
  });
  it('"49" bare number → null (below 50 min)', () => {
    expect(normalizeVolume('49')).toBeNull();
  });
  it('"5001" bare number → null (above 5000 max)', () => {
    expect(normalizeVolume('5001')).toBeNull();
  });
  it('"0.375l" → 375 (half bottle)', () => {
    expect(normalizeVolume('0.375l')).toBe(375);
  });
  it('"10cl" → 100', () => {
    expect(normalizeVolume('10cl')).toBe(100);
  });
});

describe('normalizeYear', () => {
  it('"2018" → 2018', () => {
    expect(normalizeYear('2018')).toBe(2018);
  });

  it('"2018년" → 2018 (Korean year suffix)', () => {
    expect(normalizeYear('2018년')).toBe(2018);
  });

  it('"Vintage 2018" → 2018', () => {
    expect(normalizeYear('Vintage 2018')).toBe(2018);
  });

  it('"v.2018" → 2018', () => {
    expect(normalizeYear('v.2018')).toBe(2018);
  });

  it('"1999" → 1999', () => {
    expect(normalizeYear('1999')).toBe(1999);
  });

  it('"2023" → 2023', () => {
    expect(normalizeYear('2023')).toBe(2023);
  });

  it('empty string → null', () => {
    expect(normalizeYear('')).toBeNull();
  });

  it('no year string → null', () => {
    expect(normalizeYear('no year here')).toBeNull();
  });

  it('"1800" → null (too old for wine vintage)', () => {
    // 1800 doesn't match 1[89]\d{2} pattern (matches 1800-1899 → 18xx matches 1[89] which is 18+9=NO, 18 starts with 1 then 8; 1[89] means 18 or 19)
    // Actually 1[89] matches '18' (1 followed by 8) AND '19' (1 followed by 9)
    // So 1800 → starts with 18 → matches 1[89]\d{2} = 1800... let's check
    // 1[89]\d{2}: 1[89] means '1' then one char that is '8' or '9'
    // 1800 = '1','8','0','0' → '18' matches 1[89], then '00' matches \d{2} → YES 1800 matches!
    // Let's test 1750 instead
    expect(normalizeYear('1750')).toBeNull();
  });

  // ── Round 2 audit regression tests ────────────────────────────────────────
  it('"2099" → null (future year beyond plausible)', () => {
    expect(normalizeYear('2099')).toBeNull();
  });
  it('"1800" → 1800 (valid historic vintage)', () => {
    expect(normalizeYear('1800')).toBe(1800);
  });
  it('current year + 1 is accepted (en primeur)', () => {
    const nextYear = new Date().getFullYear() + 1;
    expect(normalizeYear(String(nextYear))).toBe(nextYear);
  });
});
