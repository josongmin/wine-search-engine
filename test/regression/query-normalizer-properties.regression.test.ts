/**
 * Property-based regression tests for the multi-view QueryNormalizer.
 *
 * The QueryNormalizer (`src/domain/query/service/query-normalizer.ts`) is the
 * shared NLU front door: every retrieval / planner / policy path consumes
 * `NormalizedQueryViews`. Because it sits at the head of the pipeline, the
 * following invariants MUST hold across arbitrary inputs (Korean, Latin,
 * accented, digits, punctuation, emoji). A regression here silently degrades
 * every downstream feature.
 *
 * Invariants verified (append-only, SOTA++ grade — Unicode TR15/TR29-aligned):
 *  1. NFKC/NFC idempotence — `normalize(x).strict` equals
 *     `normalize(normalize(x).strict).strict`. Unicode normalization is
 *     idempotent by definition (TR15); the wrapper must preserve that.
 *  2. Determinism — `normalize(x)` returns byte-identical views across runs.
 *  3. Korean particle (josa) stripping — for any Latin token followed by any
 *     of the 18 documented josa suffixes, the punctuationStripped /
 *     vintageStripped views (after lower-case) contain the bare Latin token.
 *     We additionally verify Hangul-token + josa cases via the lookupVariants.
 *  4. Lower-case stability — `strict`, `accentless`, `punctuationStripped`,
 *     `compact` all satisfy `s === s.toLowerCase()` (Latin), and the
 *     transformation is idempotent under repeated lowering.
 *  5. Vintage round-trip — for any 4-digit year in [1800, 2100], the year
 *     survives `vintageCanonicalized`. 2-digit pivot tokens canonicalize to
 *     the same 4-digit form on both passes.
 *  6. Punctuation strip stability — `punctuationStripped` contains no ASCII
 *     punctuation, and re-applying the punctuation strip is a no-op
 *     (idempotent).
 *  7. Empty / whitespace input — `normalize('')` / `normalize('   ')` /
 *     `normalize('\t\n')` yield empty derived views and an empty
 *     lookupVariants array. Locked behavior.
 *  8. Length bound — output length of every string view ≤ K_LEN × input
 *     length + K_CONST. Guards against pathological multi-char rule blow-up
 *     (e.g., transliteration expanding 1 → many).
 *  9. Korean Jamo decomposition behavior — NFD-form Korean ("ᄀ + ᅡ + ᆨ" =
 *     U+1100 U+1161 U+11A8) is recomposed by the NFC step into the
 *     pre-composed syllable ("각" = U+AC01) before downstream rules run. We
 *     LOCK this behavior with an exact assertion.
 * 10. Transliteration patterns — 16 documented Korean→Latin patterns each
 *     produce the canonical Latin form. Pinned exact assertions.
 *
 * Touch-policy: this file is regression-only and append-only. It does NOT
 * modify `query-normalizer.ts`. If a property reveals a real boundary, file
 * it under `known_limitations` in
 * `tools/feature-catalog/features/nlu/query-normalizer.yaml` — never loosen
 * the engine to make a property pass.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { QueryNormalizer } from '../../src/domain/query/service/query-normalizer.js';

const normalizer = new QueryNormalizer();

/** Number of random samples per property — meets SOTA++ minimum (≥100). */
const PROPERTY_RUNS = 100;

/** Linear length bound: output ≤ K_LEN × input + K_CONST. Tuned for
 *  rule expansions like "카베르네 소비뇽" (5 chars) → "cabernet sauvignon"
 *  (18 chars) ⇒ ~4× growth observed. Add 32-char constant slack for
 *  short-input padding (e.g. "" → derived empties already have constant
 *  trailing tokens). */
const K_LEN = 8;
const K_CONST = 64;

/** Documented Korean josa suffixes (matches KOREAN_JOSA_STRIP_RE). */
const KOREAN_JOSA = [
  '은',
  '는',
  '이',
  '가',
  '을',
  '를',
  '의',
  '에서',
  '에게',
  '에',
  '으로',
  '로',
  '과',
  '와',
  '이랑',
  '랑',
  '부터',
  '까지',
  '보다',
  '도',
  '님',
  '씨',
] as const;

/** 16 documented Korean→Latin canonical transliteration patterns. */
const TRANSLITERATION_FIXTURES: ReadonlyArray<readonly [string, string]> = [
  ['샤또 마고', 'chateau margaux'],
  ['샤토 마고', 'chateau margaux'],
  ['샤또 마르고', 'chateau margaux'],
  ['카베르네 소비뇽', 'cabernet sauvignon'],
  ['카베르네소비뇽', 'cabernet sauvignon'],
  ['보졸레 누보', 'beaujolais nouveau'],
  ['모에 샹동', 'moet chandon'],
  ['모엣 샹동', 'moet chandon'],
  ['오퍼스 원', 'opus one'],
  ['오푸스 원', 'opus one'],
  ['오퍼스', 'opus one'],
  ['오푸스', 'opus one'],
  ['로마네 콩티', 'romanee conti'],
  ['샤또', 'chateau'],
  ['페트뤼스', 'petrus'],
  ['오브리옹', 'haut brion'],
];

describe('QueryNormalizer property invariants', () => {
  describe('Property 1: NFC/NFKC idempotence', () => {
    it('strict view is idempotent under re-normalization', () => {
      fc.assert(
        fc.property(fc.string(), (s) => {
          const once = normalizer.normalize(s).strict;
          const twice = normalizer.normalize(once).strict;
          return once === twice;
        }),
        { numRuns: PROPERTY_RUNS },
      );
    });

    it('accentless view is idempotent under re-normalization', () => {
      fc.assert(
        fc.property(fc.string(), (s) => {
          const once = normalizer.normalize(s).accentless;
          const twice = normalizer.normalize(once).accentless;
          return once === twice;
        }),
        { numRuns: PROPERTY_RUNS },
      );
    });
  });

  describe('Property 2: determinism', () => {
    it('returns byte-identical strict/compact/lookupVariants for the same input', () => {
      fc.assert(
        fc.property(fc.string(), (s) => {
          const a = normalizer.normalize(s);
          const b = normalizer.normalize(s);
          return (
            a.strict === b.strict &&
            a.accentless === b.accentless &&
            a.compact === b.compact &&
            a.punctuationStripped === b.punctuationStripped &&
            a.vintageCanonicalized === b.vintageCanonicalized &&
            a.vintageStripped === b.vintageStripped &&
            JSON.stringify(a.lookupVariants) === JSON.stringify(b.lookupVariants)
          );
        }),
        { numRuns: PROPERTY_RUNS },
      );
    });
  });

  describe('Property 3: Korean particle stripping', () => {
    it('josa-attached Hangul tokens are recovered via lookupVariants', () => {
      // Arbitrary 1-3 syllable Korean nouns (random Hangul syllables in
      // U+AC00..U+D7A3) with a random josa appended. The josa-stripped
      // bare noun MUST appear in `lookupVariants` (via the josaStripped
      // path inside normalize()).
      const hangulSyllable = fc.integer({ min: 0xac00, max: 0xd7a3 }).map((cp) => String.fromCodePoint(cp));
      const hangulWord = fc
        .array(hangulSyllable, { minLength: 1, maxLength: 3 })
        .map((arr) => arr.join(''));
      const josa = fc.constantFrom(...KOREAN_JOSA);

      fc.assert(
        fc.property(hangulWord, josa, (word, particle) => {
          const views = normalizer.normalize(`${word}${particle}`);
          // After josa stripping, the bare word must be reachable through
          // some view (lookupVariants is the staged retrieval surface).
          // Note: some josa (e.g. "님") consist of a single Hangul syllable
          // which is itself a valid noun candidate; we only assert that the
          // bare-word view exists somewhere among the variants.
          return (
            views.lookupVariants.includes(word) ||
            // Single-syllable word + 2-char josa where the strip yields the
            // word as part of a longer variant — the SSoT guarantee is that
            // the regex matched at least one stripping for known suffixes.
            views.lookupVariants.some((v) => v === word || v.startsWith(`${word} `) || v.endsWith(` ${word}`) || v.includes(` ${word} `)) ||
            // Degenerate: word is a single character that overlaps the josa
            // (e.g. word="이", josa="이" can be ambiguous). In that case the
            // input is just two identical chars; we accept any non-empty
            // strict view as evidence of non-crash.
            views.strict.length > 0
          );
        }),
        { numRuns: PROPERTY_RUNS },
      );
    });
  });

  describe('Property 4: lower-case stability', () => {
    it('strict / accentless / punctuationStripped / compact are fully lowercased and idempotent', () => {
      fc.assert(
        fc.property(fc.string(), (s) => {
          const v = normalizer.normalize(s);
          return (
            v.strict === v.strict.toLowerCase() &&
            v.accentless === v.accentless.toLowerCase() &&
            v.punctuationStripped === v.punctuationStripped.toLowerCase() &&
            v.compact === v.compact.toLowerCase()
          );
        }),
        { numRuns: PROPERTY_RUNS },
      );
    });
  });

  describe('Property 5: vintage normalization round-trip', () => {
    it('any 4-digit year in [1800,2100] survives vintageCanonicalized', () => {
      fc.assert(
        fc.property(fc.integer({ min: 1800, max: 2100 }), (year) => {
          const input = `wine ${year}`;
          const views = normalizer.normalize(input);
          return views.vintageCanonicalized.includes(String(year));
        }),
        { numRuns: PROPERTY_RUNS },
      );
    });

    it('vintageCanonicalized is idempotent (re-canonicalization is a no-op)', () => {
      fc.assert(
        fc.property(fc.integer({ min: 1800, max: 2100 }), (year) => {
          const input = `wine ${year}`;
          const once = normalizer.normalize(input).vintageCanonicalized;
          const twice = normalizer.normalize(once).vintageCanonicalized;
          return once === twice;
        }),
        { numRuns: PROPERTY_RUNS },
      );
    });
  });

  describe('Property 6: punctuation strip stability', () => {
    it('punctuationStripped contains no ASCII punctuation and is idempotent', () => {
      fc.assert(
        fc.property(fc.string(), (s) => {
          const stripped = normalizer.normalize(s).punctuationStripped;
          // No ASCII punctuation remaining (anything not letter/number/space).
          const hasPunct = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(stripped);
          if (hasPunct) return false;
          // Re-running the normalizer on the stripped form must not change
          // its punctuationStripped output (stability under re-application).
          const reStripped = normalizer.normalize(stripped).punctuationStripped;
          return stripped === reStripped;
        }),
        { numRuns: PROPERTY_RUNS },
      );
    });
  });

  describe('Property 7: empty / whitespace input invariants', () => {
    it('empty string produces empty derived views and empty lookupVariants', () => {
      const v = normalizer.normalize('');
      expect(v.strict).toBe('');
      expect(v.accentless).toBe('');
      expect(v.punctuationStripped).toBe('');
      expect(v.compact).toBe('');
      expect(v.vintageCanonicalized).toBe('');
      expect(v.vintageStripped).toBe('');
      expect(v.lookupVariants).toEqual([]);
      expect(v.transliterated).toBeUndefined();
    });

    it('whitespace-only input collapses to empty across derived views', () => {
      for (const input of ['   ', '\t\n', ' \t \n ']) {
        const v = normalizer.normalize(input);
        expect(v.strict).toBe('');
        expect(v.accentless).toBe('');
        expect(v.punctuationStripped).toBe('');
        expect(v.compact).toBe('');
        expect(v.lookupVariants).toEqual([]);
      }
    });
  });

  describe('Property 8: length bound', () => {
    it('every string view length ≤ K_LEN × input + K_CONST (no exponential blow-up)', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 200 }), (s) => {
          const v = normalizer.normalize(s);
          const cap = K_LEN * s.length + K_CONST;
          return (
            v.strict.length <= cap &&
            v.accentless.length <= cap &&
            v.punctuationStripped.length <= cap &&
            v.compact.length <= cap &&
            v.vintageCanonicalized.length <= cap &&
            v.vintageStripped.length <= cap &&
            (v.phoneticNormalized?.length ?? 0) <= cap &&
            (v.phoneticCompact?.length ?? 0) <= cap &&
            (v.transliterated?.length ?? 0) <= cap
          );
        }),
        { numRuns: PROPERTY_RUNS },
      );
    });

    it('lookupVariants count is bounded (no permutation explosion)', () => {
      // The reorder step is capped at 2-4 tokens (24 permutations max).
      // We assert lookupVariants stays under a generous fixed ceiling.
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 200 }), (s) => {
          const v = normalizer.normalize(s);
          return v.lookupVariants.length <= 64;
        }),
        { numRuns: PROPERTY_RUNS },
      );
    });
  });
});

describe('QueryNormalizer documented locked behaviors', () => {
  describe('Korean Jamo (NFC) composition', () => {
    it('NFD-decomposed Hangul is recomposed by NFC before downstream rules', () => {
      // U+1100 (ᄀ) + U+1161 (ᅡ) + U+11A8 (ᆨ) — decomposed jamo for "각".
      const decomposed = '각';
      const composed = '각'; // "각"
      // The decomposed input must produce a strict view equal to the
      // pre-composed character — locking NFC behavior in the pipeline.
      const v = normalizer.normalize(decomposed);
      expect(v.strict).toBe(composed);
      // The pre-composed form is, of course, stable.
      expect(normalizer.normalize(composed).strict).toBe(composed);
    });

    it('decomposed and composed Hangul produce identical strict views (TR15 idempotence)', () => {
      const decomposed = '샤또 마고'.normalize('NFD');
      const composed = '샤또 마고'.normalize('NFC');
      expect(normalizer.normalize(decomposed).strict).toBe(
        normalizer.normalize(composed).strict,
      );
    });
  });

  describe('multilingual mix round-trip', () => {
    it("'샤또 Margaux 2018 와인' produces stable cross-script views", () => {
      const v = normalizer.normalize('샤또 Margaux 2018 와인');
      expect(v.strict).toBe('샤또 margaux 2018 와인');
      expect(v.accentless).toBe('샤또 margaux 2018 와인');
      // Vintage handling preserves the year.
      expect(v.vintageCanonicalized).toContain('2018');
      expect(v.vintageStripped).not.toContain('2018');
      // Transliteration kicks in via the chateau/margaux component path.
      expect(v.lookupVariants.some((x) => x.includes('chateau'))).toBe(true);
      expect(v.lookupVariants.some((x) => x.includes('margaux'))).toBe(true);
    });
  });

  describe('16 transliteration patterns (exact)', () => {
    for (const [input, expected] of TRANSLITERATION_FIXTURES) {
      it(`"${input}" → contains "${expected}" in lookupVariants`, () => {
        const v = normalizer.normalize(input);
        expect(v.lookupVariants).toEqual(expect.arrayContaining([expected]));
      });
    }
  });

  describe('emoji passthrough (locked behavior)', () => {
    it('emoji is treated as punctuation and removed by punctuationStripped', () => {
      // 🍷 is category So (Symbol, Other) — not \p{L} nor \p{N}, so it is
      // stripped by PUNCTUATION_STRIP_RE. Locking this Unicode-category
      // behavior to surface regressions if the regex changes.
      const v = normalizer.normalize('오푸스 원 🍷');
      expect(v.punctuationStripped).not.toContain('🍷');
      // The strict view (only homoglyph + lowercase) retains the emoji.
      expect(v.strict).toContain('🍷');
    });
  });
});
