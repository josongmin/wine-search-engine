import { describe, it, expect } from 'vitest';
import {
  normalizeUnicode,
  stripAccents,
  normalizeHomoglyphs,
} from '../../../src/domain/shared/utils/unicode-normalize.js';

describe('normalizeUnicode', () => {
  it('produces NFC form for "Château"', () => {
    // The input may be in NFC or NFD; the output should be NFC
    const input = 'Cha\u0302teau'; // NFD form with combining circumflex
    const result = normalizeUnicode(input);
    // NFC: composed circumflex on 'a' (distinct from stripAccents)
    expect(result).toBe('Ch\u00e2teau');
  });

  it('preserves NFC-encoded "Château" after normalization', () => {
    const input = 'Ch\u00e2teau'; // NFC: â is U+00E2
    const result = normalizeUnicode(input);
    expect(result).toBe('Ch\u00e2teau');
  });

  it('collapses interior whitespace runs to a single space', () => {
    const result = normalizeUnicode('a  b\t\nc');
    expect(result).toBe('a b c');
  });

  it('trims leading and trailing whitespace', () => {
    const result = normalizeUnicode('  hello  ');
    expect(result).toBe('hello');
  });

  it('replaces Cyrillic А (U+0410) with Latin A', () => {
    const cyrillicA = '\u0410'; // Cyrillic А
    const result = normalizeUnicode(cyrillicA + 'BC');
    expect(result).toBe('ABC');
  });

  it('replaces Cyrillic о (U+043E) with Latin o', () => {
    const input = 'h\u043Eme'; // Cyrillic о embedded
    const result = normalizeUnicode(input);
    expect(result).toBe('home');
  });

  it('handles empty string', () => {
    expect(normalizeUnicode('')).toBe('');
  });
});

describe('stripAccents', () => {
  it('strips accent from "Château" → "Chateau"', () => {
    const result = stripAccents('Ch\u00e2teau');
    expect(result).toBe('Chateau');
  });

  it('strips é → e', () => {
    expect(stripAccents('\u00e9')).toBe('e');
  });

  it('strips ü → u', () => {
    expect(stripAccents('\u00fc')).toBe('u');
  });

  it('strips ñ → n', () => {
    expect(stripAccents('\u00f1')).toBe('n');
  });

  it('leaves plain ASCII unchanged', () => {
    expect(stripAccents('hello world')).toBe('hello world');
  });

  it('strips multiple accents in a string', () => {
    // "résumé"
    const result = stripAccents('r\u00e9sum\u00e9');
    expect(result).toBe('resume');
  });

  it('preserves Korean characters (no combining marks)', () => {
    const korean = '오푸스원';
    expect(stripAccents(korean)).toBe(korean);
  });
});

describe('normalizeHomoglyphs', () => {
  it('replaces Cyrillic А (U+0410) with Latin A', () => {
    expect(normalizeHomoglyphs('\u0410')).toBe('A');
  });

  it('replaces Cyrillic В (U+0412) with Latin B', () => {
    expect(normalizeHomoglyphs('\u0412')).toBe('B');
  });

  it('replaces Cyrillic С (U+0421) with Latin C', () => {
    expect(normalizeHomoglyphs('\u0421')).toBe('C');
  });

  it('replaces Cyrillic е (U+0435) with Latin e', () => {
    expect(normalizeHomoglyphs('\u0435')).toBe('e');
  });

  it('replaces multiple Cyrillic lookalikes in a string', () => {
    // Cyrillic А, В, С → Latin A, B, C
    const result = normalizeHomoglyphs('\u0410\u0412\u0421');
    expect(result).toBe('ABC');
  });

  it('leaves Latin characters unchanged', () => {
    expect(normalizeHomoglyphs('Latin text')).toBe('Latin text');
  });

  it('leaves Korean characters unchanged', () => {
    const korean = '오푸스원';
    expect(normalizeHomoglyphs(korean)).toBe(korean);
  });

  it('replaces mixed Cyrillic-Latin string correctly', () => {
    // "M" followed by Cyrillic о (U+043E) followed by "n"
    const result = normalizeHomoglyphs('M\u043En');
    expect(result).toBe('Mon');
  });
});
