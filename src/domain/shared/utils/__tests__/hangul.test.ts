import { describe, expect, it } from 'vitest';
import { buildHangulJamoKey, containsHangul } from '../hangul.js';

describe('hangul utilities', () => {
  it('detects Hangul syllables in normalized user queries', () => {
    expect(containsHangul('오푸스원')).toBe(true);
    expect(containsHangul('Opus One')).toBe(false);
  });

  it('builds IME-aware jamo keys that preserve incomplete syllable prefixes', () => {
    const complete = buildHangulJamoKey('오푸스원');
    const choseongPrefix = buildHangulJamoKey('오푸스ㅇ');
    const medialPrefix = buildHangulJamoKey('오푸스우');
    const compoundMedialPrefix = buildHangulJamoKey('오푸스워');
    const spaced = buildHangulJamoKey('오푸스 원');

    expect(complete.key).toBe('ㅇㅗㅍㅜㅅㅡㅇㅜㅓㄴ');
    expect(choseongPrefix.key).toBe('ㅇㅗㅍㅜㅅㅡㅇ');
    expect(medialPrefix.key).toBe('ㅇㅗㅍㅜㅅㅡㅇㅜ');
    expect(compoundMedialPrefix.key).toBe('ㅇㅗㅍㅜㅅㅡㅇㅜㅓ');
    expect(spaced.key).toBe(complete.key);

    expect(complete.syllableBoundaryOffsets.has(choseongPrefix.key.length)).toBe(false);
    expect(complete.syllableBoundaryOffsets.has(medialPrefix.key.length)).toBe(false);
    expect(complete.syllableBoundaryOffsets.has(compoundMedialPrefix.key.length)).toBe(false);
    expect(choseongPrefix.containsStandaloneJamo).toBe(true);
    expect(medialPrefix.containsStandaloneJamo).toBe(false);
    expect(compoundMedialPrefix.containsStandaloneJamo).toBe(false);
  });
});
