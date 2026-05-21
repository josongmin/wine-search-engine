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

// ---------------------------------------------------------------------------
// Hangul syllable composition / decomposition (Unicode §3.12 D118-D132)
//
// SSoT for the Hangul L+V[+T] composition algorithm used by:
//   - src/domain/security/service/query-sanitizer.ts (injection regex
//     bypass-closure: an attacker can re-encode '무시' via Compat Jamo
//     'ㅁㅜㅅㅣ' which NFKC alone leaves in decomposed conjoining-jamo form;
//     the composer folds them back to syllables so the regex match holds)
//   - src/application/wine-search/query-analyzer.ts (deterministic anchor
//     and constraint extractors compare against NFC-encoded catalog terms;
//     Compat-Jamo input would otherwise drift to intent=unknown — fixed by
//     applying normalizeHangul() before the extraction pipeline)
//
// The 4 functions (`hasHangulContent`, `decomposeHangulSyllables`,
// `composeHangulSyllables`, `normalizeHangul`) and 8 codepoint constants
// previously lived inside query-sanitizer.ts as private helpers. Moving
// them here satisfies CLAUDE.md rule 25/30 (SSoT for shared logic) — the
// algorithm is general Unicode, not security-specific.
// ---------------------------------------------------------------------------

/** Base codepoint of the precomposed Hangul Syllables block (U+AC00). */
const HANGUL_SBASE = 0xac00;
/** Base codepoint of the conjoining Hangul L (Choseong) range (U+1100). */
const HANGUL_LBASE = 0x1100;
/** Base codepoint of the conjoining Hangul V (Jungseong) range (U+1161). */
const HANGUL_VBASE = 0x1161;
/** T-index 0 sentinel (no final). Actual finals start at U+11A8 (T_idx=1). */
const HANGUL_TBASE = 0x11a7;
/** Number of distinct L (Choseong) consonants. */
const HANGUL_LCOUNT = 19;
/** Number of distinct V (Jungseong) vowels. */
const HANGUL_VCOUNT = 21;
/** Number of distinct T (Jongseong) finals including the "no final" sentinel. */
const HANGUL_TCOUNT = 28;
// Note: HANGUL_SYLLABLE_END (= 0xd7a3) is declared above (line 26) and reused
// here — it is the last precomposed syllable in U+AC00..U+D7A3.
/** First conjoining-jamo codepoint (start of U+1100..U+11FF). */
const HANGUL_JAMO_BLOCK_START = 0x1100;
/** Last conjoining-jamo codepoint (end of U+1100..U+11FF). */
const HANGUL_JAMO_BLOCK_END = 0x11ff;

/**
 * Returns true if any codepoint in the input is a precomposed Hangul syllable
 * (U+AC00..U+D7A3) or a conjoining Hangul Jamo (U+1100..U+11FF). Used as a
 * fast pre-check so the compose/decompose round-trip is a no-op on
 * Hangul-free input.
 *
 * Distinct from {@link containsHangul} above (which also covers Compatibility
 * Jamo U+3130..U+318F) because this is specifically the pre-check for the
 * composition algorithm, which expects NFKC-decomposed conjoining jamo only.
 */
export function hasHangulContent(input: string): boolean {
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    if (
      (c >= HANGUL_SBASE && c <= HANGUL_SYLLABLE_END) ||
      (c >= HANGUL_JAMO_BLOCK_START && c <= HANGUL_JAMO_BLOCK_END)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Decomposes precomposed Hangul syllables (U+AC00..U+D7A3) into their
 * conjoining L V [T] jamo sequence. Non-Hangul characters pass through.
 *
 * Required as a preprocessing step before {@link composeHangulSyllables} so
 * mixed forms (e.g. attacker insertion of a lone choseong between two
 * precomposed syllables: '무ㅅ시' → after NFKC '무ᄉ시' = U+BB34 U+1109
 * U+C2DC) are normalized to a fully-jamo stream the composer can resynthesize
 * into clean syllables.
 *
 * Algorithm: index = code - SBase; L_idx = index / (V*T);
 * V_idx = (index % (V*T)) / T; T_idx = index % T. Emit the corresponding
 * conjoining jamo codepoints.
 */
export function decomposeHangulSyllables(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    const sIdx = code - HANGUL_SBASE;
    if (sIdx >= 0 && sIdx < HANGUL_LCOUNT * HANGUL_VCOUNT * HANGUL_TCOUNT) {
      const lIdx = Math.floor(sIdx / (HANGUL_VCOUNT * HANGUL_TCOUNT));
      const vIdx = Math.floor((sIdx % (HANGUL_VCOUNT * HANGUL_TCOUNT)) / HANGUL_TCOUNT);
      const tIdx = sIdx % HANGUL_TCOUNT;
      out += String.fromCharCode(HANGUL_LBASE + lIdx);
      out += String.fromCharCode(HANGUL_VBASE + vIdx);
      if (tIdx > 0) {
        out += String.fromCharCode(HANGUL_TBASE + tIdx);
      }
    } else {
      out += input.charAt(i);
    }
  }
  return out;
}

/**
 * Composes a sequence of conjoining Hangul Jamo (U+1100..U+11FF) into the
 * precomposed syllable form (U+AC00..U+D7A3). Orphan conjoining jamo that
 * cannot be combined into a syllable are dropped — they are not legitimate
 * standalone characters in well-formed Korean text and their presence
 * indicates either attacker tampering or already-broken input.
 *
 * The algorithm is the canonical L+V[+T] composition per Unicode §3.12 —
 * 19 × 21 × 28 = 11_172 syllables addressable.
 *
 * Performance: single linear scan, O(n).
 */
export function composeHangulSyllables(input: string): string {
  let out = '';
  let i = 0;
  while (i < input.length) {
    const lCode = input.charCodeAt(i);
    const lIdx = lCode - HANGUL_LBASE;
    if (lIdx >= 0 && lIdx < HANGUL_LCOUNT && i + 1 < input.length) {
      const vCode = input.charCodeAt(i + 1);
      const vIdx = vCode - HANGUL_VBASE;
      if (vIdx >= 0 && vIdx < HANGUL_VCOUNT) {
        // Optional trailing T (final consonant): only consume if it is a
        // valid jongseong (U+11A8..U+11C2) AND not immediately followed by a
        // medial V — in 'L V L V' (e.g. '다아') the second L belongs to the
        // next syllable, not as a final of the first.
        let tIdx = 0;
        let consumed = 2;
        if (i + 2 < input.length) {
          const tCode = input.charCodeAt(i + 2);
          const candidateT = tCode - HANGUL_TBASE;
          const isValidT = candidateT > 0 && candidateT < HANGUL_TCOUNT;
          let nextIsV = false;
          if (isValidT && i + 3 < input.length) {
            const afterT = input.charCodeAt(i + 3);
            nextIsV = afterT >= HANGUL_VBASE && afterT < HANGUL_VBASE + HANGUL_VCOUNT;
          }
          if (isValidT && !nextIsV) {
            tIdx = candidateT;
            consumed = 3;
          }
        }
        const syllable =
          HANGUL_SBASE + (lIdx * HANGUL_VCOUNT + vIdx) * HANGUL_TCOUNT + tIdx;
        out += String.fromCharCode(syllable);
        i += consumed;
        continue;
      }
    }
    // Orphan conjoining jamo we could not compose: drop it. Legitimate text
    // contains only precomposed syllables; orphan jamo signals attacker
    // tampering or already-malformed input.
    if (lCode >= HANGUL_JAMO_BLOCK_START && lCode <= HANGUL_JAMO_BLOCK_END) {
      i += 1;
      continue;
    }
    out += input.charAt(i);
    i += 1;
  }
  return out;
}

/**
 * Full Hangul normalization: decompose precomposed syllables to L V [T] jamo,
 * then re-compose to syllables, dropping orphan jamo. The round-trip
 * canonicalizes attacker-encoded forms (compat jamo, mid-syllable jamo
 * insertion) into clean syllable form so downstream matchers (regex,
 * catalog lookup, anchor extraction) see a consistent NFC-syllable stream.
 *
 * Callers should typically apply this AFTER `String.prototype.normalize('NFKC')`
 * so Hangul Compatibility Jamo (U+3130..U+318F) is first mapped to conjoining
 * jamo (U+1100..U+11FF) — only then can `composeHangulSyllables` fold them
 * into syllables.
 *
 * Pure passthrough when the input contains no Hangul.
 */
export function normalizeHangul(input: string): string {
  if (!hasHangulContent(input)) return input;
  return composeHangulSyllables(decomposeHangulSyllables(input));
}
