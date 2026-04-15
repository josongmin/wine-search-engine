import { describe, expect, it } from 'vitest';
import { soundexKo } from '../phonetic.js';

describe('soundexKo', () => {
  it('returns an empty string for empty input', () => {
    expect(soundexKo('')).toBe('');
  });

  it('passes through non-Hangul input unchanged', () => {
    expect(soundexKo('abc-123')).toBe('abc-123');
    expect(soundexKo('Moet Chandon!')).toBe('Moet Chandon!');
  });

  it('maps Hangul syllables to initial jamo while preserving non-Hangul characters', () => {
    expect(soundexKo('샤또 123')).toBe(`${String.fromCodePoint(0x1109)}${String.fromCodePoint(0x1104)} 123`);
  });
});
