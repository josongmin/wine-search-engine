/**
 * Phonetic encoding utilities for approximate matching.
 *
 * Provides Soundex-style encodings for English and a simplified consonant-key
 * encoding for Korean (based on initial jamo decomposition).
 */

/**
 * Standard Soundex encoding for English words.
 *
 * Maps the first letter verbatim, then encodes subsequent consonants as
 * digits (1-6). Ignores vowels and H/W/Y. Pads or truncates to 4 characters.
 */
/** Classic Soundex output width (letter + three digits). */
const SOUNDEX_ENCODED_LENGTH = 4;

const SOUNDEX_CODES: Readonly<Record<string, string>> = {
  B: '1', F: '1', P: '1', V: '1',
  C: '2', G: '2', J: '2', K: '2', Q: '2', S: '2', X: '2', Z: '2',
  D: '3', T: '3',
  L: '4',
  M: '5', N: '5',
  R: '6',
};

export function soundexEn(word: string): string {
  const upper = word.toUpperCase().replace(/[^A-Z]/g, '');
  if (upper.length === 0) return '0000';

  let result = upper[0] ?? '';
  let lastCode = SOUNDEX_CODES[result] ?? '0';

  for (let i = 1; i < upper.length && result.length < SOUNDEX_ENCODED_LENGTH; i++) {
    const ch = upper[i];
    if (ch === undefined) continue;
    const code = SOUNDEX_CODES[ch];
    if (code !== undefined && code !== lastCode) {
      result += code;
      lastCode = code;
    } else if (code === undefined) {
      lastCode = '0'; // vowel / H / W / Y resets
    }
  }

  return result.padEnd(SOUNDEX_ENCODED_LENGTH, '0');
}

/**
 * Simplified Korean phonetic key based on initial jamo (초성) extraction.
 *
 * Decomposes each Hangul syllable into its leading consonant and returns the
 * sequence of initial jamo code points as a string key. Non-Hangul characters
 * are passed through unchanged.
 */
export function soundexKo(word: string): string {
  const INITIAL_JAMO_BASE = 0x1100;
  const HANGUL_BASE = 0xac00;
  const HANGUL_END = 0xd7a3;
  const JAMO_PER_INITIAL = 588; // 21 vowels × 28 finals

  let key = '';
  for (const ch of word) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= HANGUL_BASE && code <= HANGUL_END) {
      const initialIndex = Math.floor((code - HANGUL_BASE) / JAMO_PER_INITIAL);
      key += String.fromCodePoint(INITIAL_JAMO_BASE + initialIndex);
    } else {
      key += ch;
    }
  }

  return key;
}
