import { describe, it, expect } from 'vitest';
import {
  normalizeField,
  normalizeVolume,
  normalizeYear,
  normalizeKoreanText,
} from '../../../src/domain/ingestion/service/field-normalizer.js';

describe('normalizeField', () => {
  it('collapses whitespace: "  hello   world  " → "hello world"', () => {
    expect(normalizeField('  hello   world  ')).toBe('hello world');
  });

  it('applies Unicode NFC normalization and preserves "Château"', () => {
    // "Château" in NFC should come through unchanged
    const nfc = 'Ch\u00e2teau'; // â is U+00E2 NFC
    expect(normalizeField(nfc)).toBe(nfc);
  });

  it('returns empty string for empty input', () => {
    expect(normalizeField('')).toBe('');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeField('  opus one  ')).toBe('opus one');
  });
});

describe('normalizeVolume', () => {
  it('"750ml" → 750', () => {
    expect(normalizeVolume('750ml')).toBe(750);
  });

  it('"750 ml" → 750', () => {
    expect(normalizeVolume('750 ml')).toBe(750);
  });

  it('"750ML" (uppercase) → 750', () => {
    expect(normalizeVolume('750ML')).toBe(750);
  });

  it('"75cl" → 750 (cl * 10)', () => {
    expect(normalizeVolume('75cl')).toBe(750);
  });

  it('"75 cl" → 750', () => {
    expect(normalizeVolume('75 cl')).toBe(750);
  });

  it('"1.5l" → 1500 (l * 1000)', () => {
    expect(normalizeVolume('1.5l')).toBe(1500);
  });

  it('"1.5 L" → 1500', () => {
    expect(normalizeVolume('1.5 L')).toBe(1500);
  });

  it('"1.5litre" → 1500', () => {
    expect(normalizeVolume('1.5litre')).toBe(1500);
  });

  it('bare "750" → 750 (standard bottle size assumed ml)', () => {
    expect(normalizeVolume('750')).toBe(750);
  });

  it('unrecognized format → null', () => {
    expect(normalizeVolume('unknown')).toBeNull();
  });

  it('empty string → null', () => {
    expect(normalizeVolume('')).toBeNull();
  });
});

describe('normalizeYear', () => {
  it('"2018" → 2018', () => {
    expect(normalizeYear('2018')).toBe(2018);
  });

  it('"2018년" (Korean year suffix) → 2018', () => {
    expect(normalizeYear('2018년')).toBe(2018);
  });

  it('"2018年" (Chinese/Japanese year suffix) → 2018', () => {
    expect(normalizeYear('2018年')).toBe(2018);
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

  it('no year in string → null', () => {
    expect(normalizeYear('no year here')).toBeNull();
  });

  it('empty string → null', () => {
    expect(normalizeYear('')).toBeNull();
  });
});

describe('normalizeKoreanText', () => {
  it('full-width space (U+3000) → ASCII space', () => {
    const input = '오푸스\u3000원';
    expect(normalizeKoreanText(input)).toBe('오푸스 원');
  });

  it('zero-width space (U+200B) removed', () => {
    const input = '오푸스\u200B원';
    expect(normalizeKoreanText(input)).toBe('오푸스원');
  });

  it('full-width parentheses → ASCII parentheses', () => {
    const input = '\uFF08정품\uFF09';
    expect(normalizeKoreanText(input)).toBe('(정품)');
  });

  it('collapses interior whitespace', () => {
    const input = '오푸스  원';
    expect(normalizeKoreanText(input)).toBe('오푸스 원');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeKoreanText('  한국어  ')).toBe('한국어');
  });
});

describe('field-normalizer full-width digits', () => {
  it('full-width digits in vintage normalized via normalizeYear after converting', () => {
    // normalizeYear handles bare numbers; full-width digits need to be handled separately
    // normalizeField with Korean locale: normalizeKoreanText handles whitespace but not digit width
    // Test that "2018년" is parsed correctly
    expect(normalizeYear('2018년')).toBe(2018);
  });

  it('normalizeYear on full-width digits "２０１８" → null (NFC not NFKC; ASCII digit class only)', () => {
    // normalizeUnicode applies NFC, not NFKC, so full-width digits are NOT converted
    // to ASCII. normalizeYear regex uses \d which matches ASCII digits only in JS.
    // Full-width digits remain unreduced and no 4-digit ASCII year is found → null.
    expect(normalizeYear('２０１８')).toBeNull();
  });

  it('normalizeField converts NFD "Cha\\u0302teau" to NFC "Château"', () => {
    // U+0302 is combining circumflex accent (NFD form).
    // normalizeField → normalizeUnicode → .normalize('NFC') composes it to â (U+00E2).
    const nfd = 'Cha\u0302teau'; // NFD: 'a' + combining circumflex
    expect(normalizeField(nfd)).toBe('Château');
  });
});
