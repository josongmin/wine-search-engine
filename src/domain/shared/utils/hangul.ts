/**
 * Hangul (한글) detection utilities (SSoT).
 *
 * The previous codebase had `[\uAC00-\uD7A3]` redefined in 8+ files, with
 * subtle inconsistencies — some used the syllables block only, others
 * extended to Jamo / Compatibility Jamo. This module centralizes the
 * canonical ranges and exposes guard functions so query classifiers,
 * LTR feature extractors, and agent prompts all agree on what "contains
 * Korean" means.
 *
 * The default check targets precomposed Hangul syllables (U+AC00–U+D7A3),
 * which is sufficient for normalized user queries.
 */

/**
 * Tests whether the input contains at least one precomposed Hangul syllable.
 * Use this for the default "is Korean" check on user queries — anything
 * normalized to NFC will land in this range.
 */
const HANGUL_SYLLABLES_RE = /[\uAC00-\uD7A3]/u;
export function containsHangul(text: string): boolean {
  return HANGUL_SYLLABLES_RE.test(text);
}

const HANGUL_SYLLABLE_BASE = 0xac00;
const HANGUL_SYLLABLE_END = 0xd7a3;
const HANGUL_INITIAL_STRIDE = 588; // 21 medials * 28 finals
const HANGUL_MEDIAL_STRIDE = 28;

const COMPAT_INITIALS = [
  'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ',
  'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
] as const;

const COMPAT_MEDIALS = [
  'ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ',
  'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ',
] as const;

const COMPAT_FINALS = [
  '', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ',
  'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ',
  'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
] as const;

const COMPAT_DECOMPOSITION: Readonly<Record<string, string>> = {
  ㄳ: 'ㄱㅅ',
  ㄵ: 'ㄴㅈ',
  ㄶ: 'ㄴㅎ',
  ㄺ: 'ㄹㄱ',
  ㄻ: 'ㄹㅁ',
  ㄼ: 'ㄹㅂ',
  ㄽ: 'ㄹㅅ',
  ㄾ: 'ㄹㅌ',
  ㄿ: 'ㄹㅍ',
  ㅀ: 'ㄹㅎ',
  ㅄ: 'ㅂㅅ',
  ㅘ: 'ㅗㅏ',
  ㅙ: 'ㅗㅐ',
  ㅚ: 'ㅗㅣ',
  ㅝ: 'ㅜㅓ',
  ㅞ: 'ㅜㅔ',
  ㅟ: 'ㅜㅣ',
  ㅢ: 'ㅡㅣ',
};

const COMPAT_JAMO_RE = /[\u3130-\u318f]/u;
const LEADING_JAMO_BASE = 0x1100;
const LEADING_JAMO_END = 0x1112;
const MEDIAL_JAMO_BASE = 0x1161;
const MEDIAL_JAMO_END = 0x1175;
const FINAL_JAMO_BASE = 0x11a7;
const FINAL_JAMO_END = 0x11c2;

export interface HangulJamoKey {
  readonly key: string;
  readonly syllableBoundaryOffsets: ReadonlySet<number>;
  readonly syllableCount: number;
  readonly containsHangul: boolean;
  readonly containsStandaloneJamo: boolean;
}

function decomposeCompatJamo(jamo: string): string {
  return COMPAT_DECOMPOSITION[jamo] ?? jamo;
}

function compatFromCanonicalJamo(code: number): string | undefined {
  if (code >= LEADING_JAMO_BASE && code <= LEADING_JAMO_END) {
    return COMPAT_INITIALS[code - LEADING_JAMO_BASE];
  }
  if (code >= MEDIAL_JAMO_BASE && code <= MEDIAL_JAMO_END) {
    return COMPAT_MEDIALS[code - MEDIAL_JAMO_BASE];
  }
  if (code > FINAL_JAMO_BASE && code <= FINAL_JAMO_END) {
    return COMPAT_FINALS[code - FINAL_JAMO_BASE];
  }
  return undefined;
}

/**
 * Builds an IME-oriented Hangul jamo key.
 *
 * Unlike 초성-only phonetic keys, this preserves initial/medial/final order and
 * decomposes compound vowels/finals (`워` → `ㅇㅜㅓ`, `ㄳ` → `ㄱㅅ`). That lets
 * query-time completion distinguish:
 *   - `오푸스ㅇ` as a prefix of `오푸스원`
 *   - `오푸스우` as an IME prefix of `오푸스원`
 *   - `오푸스` as a completed syllable boundary, not an in-progress completion
 *
 * Non-Hangul characters are ignored intentionally so spacing and punctuation do
 * not change the key (`오푸스 원` == `오푸스원`).
 */
export function buildHangulJamoKey(input: string): HangulJamoKey {
  let key = '';
  let syllableCount = 0;
  let containsHangul = false;
  let containsStandaloneJamo = false;
  const boundaries = new Set<number>();

  for (const char of input.normalize('NFC')) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;

    if (code >= HANGUL_SYLLABLE_BASE && code <= HANGUL_SYLLABLE_END) {
      const syllableIndex = code - HANGUL_SYLLABLE_BASE;
      const initialIndex = Math.floor(syllableIndex / HANGUL_INITIAL_STRIDE);
      const medialIndex = Math.floor((syllableIndex % HANGUL_INITIAL_STRIDE) / HANGUL_MEDIAL_STRIDE);
      const finalIndex = syllableIndex % HANGUL_MEDIAL_STRIDE;
      const initial = COMPAT_INITIALS[initialIndex];
      const medial = COMPAT_MEDIALS[medialIndex];
      const final = COMPAT_FINALS[finalIndex];
      if (initial === undefined || medial === undefined || final === undefined) {
        continue;
      }

      key += decomposeCompatJamo(initial);
      key += decomposeCompatJamo(medial);
      key += decomposeCompatJamo(final);
      syllableCount += 1;
      containsHangul = true;
      boundaries.add(key.length);
      continue;
    }

    if (COMPAT_JAMO_RE.test(char)) {
      key += decomposeCompatJamo(char);
      containsHangul = true;
      containsStandaloneJamo = true;
      continue;
    }

    const compat = compatFromCanonicalJamo(code);
    if (compat !== undefined) {
      key += decomposeCompatJamo(compat);
      containsHangul = true;
      containsStandaloneJamo = true;
    }
  }

  return {
    key,
    syllableBoundaryOffsets: boundaries,
    syllableCount,
    containsHangul,
    containsStandaloneJamo,
  };
}
