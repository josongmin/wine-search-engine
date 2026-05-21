/**
 * Property-based regression tests for the Korean transliterator.
 *
 * The transliterator (RFC-003 §4.5) is a deterministic rule-based engine
 * (FR/IT/ES/EN → 한글) with an exception catalog of curated wine names.
 * Because it powers ETL alias generation and runtime entity resolution
 * fallback, the following invariants MUST hold; any regression here breaks
 * Korean-surface query recall against Latin-surface evidence.
 *
 * Invariants verified (append-only, SOTA++ grade):
 *  1. Determinism — transliterate(x) === transliterate(x) for arbitrary x
 *  2. Idempotence — feeding Hangul output back through the transliterator
 *     yields the same output (Hangul has no transliteration rules, so it
 *     passes through unchanged).
 *  3. Confidence tier — generateAliases returns only the documented tiers
 *     {0.95, 0.75, 0.6}; the value is deterministic per input.
 *  4. Length bound — output length is linearly bounded (K = 10) wrt input,
 *     guarding against pathological multi-char rule blow-up.
 *  5. No phantom characters — output is restricted to (Hangul ∪ ASCII
 *     passthrough set ∪ pre-existing input characters). The transliterator
 *     never injects characters not present in either the rule range or
 *     the input.
 *  6. Korean output validity for curated exceptions — every EXCEPTIONS-hit
 *     surface produces an output that contains at least one Hangul syllable
 *     and no Latin letters from the input vocabulary (the rule did fire).
 *  7. Exception catalog completeness — the well-known wine vocabulary
 *     pinned below MUST resolve via either the EXCEPTIONS map or the
 *     per-language word-level rules. This guards the canonical Korean
 *     surface vocabulary against silent regressions.
 *
 * Touch-policy: this file is regression-only and append-only. It does NOT
 * modify `transliterator.ts`. Any property that does not hold is documented
 * in `tools/feature-catalog/features/korean-i18n/transliterator.yaml`
 * under `known_limitations` — never loosen the engine to make a property
 * pass.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { Transliterator, type SourceLang } from '../../src/domain/alias/service/transliterator.js';

const t = new Transliterator();

const LANGS: readonly SourceLang[] = ['fr', 'it', 'es', 'en'] as const;

// fast-check defaults — seed is implicit but fast-check is deterministic when
// given the same seed; the runner pins a seed on failure so reruns reproduce.
const RUNS = 100;

// Linear length-bound factor. The widest single-char rule expands to 2 Hangul
// syllables (e.g. 'x' → '크스'); add safety margin for multi-char rules and
// whitespace preservation between word-level outputs.
const LENGTH_BOUND_K = 10;

// Hangul Syllables block (precomposed). The rule tables only output values
// inside this range plus ASCII spaces.
const HANGUL_SYLLABLE_RE = /[가-힣]/u;

/**
 * The character set the engine can introduce on its own. Anything in the
 * output that is NOT one of these MUST have been present in the input
 * (pass-through path inside applyRules).
 */
const ENGINE_INTRODUCED_CHARS_RE = /^[가-힣 ]+$/u;

// ────────────────────────────────────────────────────────────────────────────
// Property 1 — Determinism
// ────────────────────────────────────────────────────────────────────────────

describe('Property: transliterate determinism', () => {
  for (const lang of LANGS) {
    it(`is referentially transparent for arbitrary strings (lang=${lang})`, () => {
      fc.assert(
        fc.property(fc.string(), (s) => {
          const a = t.transliterate(s, lang);
          const b = t.transliterate(s, lang);
          return a === b;
        }),
        { numRuns: RUNS },
      );
    });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Property 2 — Idempotence on a real wine-domain corpus
// ────────────────────────────────────────────────────────────────────────────
//
// transliterate(transliterate(x)) === transliterate(x) when the first pass
// yields output that lies inside the Hangul block ∪ whitespace, because no
// rule key matches Hangul syllables and applyRules pass-through preserves
// them. This is the contract the verifier (RFC-020) relies on.

const IDEMPOTENT_CORPUS: ReadonlyArray<readonly [string, SourceLang]> = [
  // FR
  ['Château Margaux', 'fr'],
  ['Bordeaux', 'fr'],
  ['Champagne', 'fr'],
  ['Margaux', 'fr'],
  ['Sauternes', 'fr'],
  ['Pauillac', 'fr'],
  ['Médoc', 'fr'],
  // IT
  ['Barolo', 'it'],
  ['Chianti', 'it'],
  ['Brunello', 'it'],
  ['Amarone', 'it'],
  ['Sangiovese', 'it'],
  ['Pinot', 'it'],
  // ES
  ['Rioja', 'es'],
  ['Ribera', 'es'],
  ['Tempranillo', 'es'],
  // EN
  ['Opus One', 'en'],
  ['Napa', 'en'],
  ['Sonoma', 'en'],
  ['Penfolds', 'en'],
];

describe('Property: idempotence on wine-domain corpus', () => {
  for (const [label, lang] of IDEMPOTENT_CORPUS) {
    it(`transliterate(transliterate("${label}")) is stable (lang=${lang})`, () => {
      const once = t.transliterate(label, lang);
      const twice = t.transliterate(once, lang);
      expect(twice).toBe(once);
    });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Property 3 — Confidence tier vocabulary
// ────────────────────────────────────────────────────────────────────────────

const VALID_CONFIDENCES = new Set([0.95, 0.75, 0.6]);

describe('Property: generateAliases confidence tier', () => {
  it('every confidence value is one of {0.95, 0.75, 0.6} (rand strings, EN)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 32 }),
        (s) => {
          const results = t.generateAliases(s, 'en');
          for (const r of results) {
            if (!VALID_CONFIDENCES.has(r.confidence)) return false;
          }
          return true;
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('confidence is deterministic per input (same input → same tiers)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.constantFrom(...LANGS),
        (s, lang) => {
          const a = t.generateAliases(s, lang);
          const b = t.generateAliases(s, lang);
          if (a.length !== b.length) return false;
          for (let i = 0; i < a.length; i += 1) {
            if (a[i]!.confidence !== b[i]!.confidence) return false;
            if (a[i]!.value !== b[i]!.value) return false;
          }
          return true;
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('exception input → exactly 0.95 (high tier)', () => {
    expect(t.generateAliases('Opus One', 'en')[0]!.confidence).toBe(0.95);
    expect(t.generateAliases('Sassicaia', 'it')[0]!.confidence).toBe(0.95);
    expect(t.generateAliases('Penfolds', 'en')[0]!.confidence).toBe(0.95);
  });

  it('non-exception rule input → exactly 0.75 (rule tier)', () => {
    expect(t.generateAliases('Brunello', 'it')[0]!.confidence).toBe(0.75);
    expect(t.generateAliases('Sauternes', 'fr')[0]!.confidence).toBe(0.75);
  });

  it('compact phonetic variant (when emitted) → exactly 0.6', () => {
    // Multi-word non-exception input forces a compact variant.
    const results = t.generateAliases('Pinot Noir', 'fr');
    const compactResult = results.find((r) => r.type === 'phonetic');
    if (compactResult !== undefined) {
      expect(compactResult.confidence).toBe(0.6);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Property 4 — Length bound
// ────────────────────────────────────────────────────────────────────────────

describe('Property: output length is linearly bounded', () => {
  it(`|transliterate(x)| ≤ ${LENGTH_BOUND_K} × |x| + 1 (constant offset for empty)`, () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 64 }),
        fc.constantFrom(...LANGS),
        (s, lang) => {
          const out = t.transliterate(s, lang);
          return out.length <= LENGTH_BOUND_K * s.length + 1;
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('1000-char input does not crash and respects the bound', () => {
    const long = 'cabernet sauvignon '.repeat(53); // ~1007 chars
    const out = t.transliterate(long, 'en');
    expect(out.length).toBeLessThanOrEqual(LENGTH_BOUND_K * long.length);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Property 5 — No phantom characters (output charset is bounded by input
// ∪ engine-introduced-set).
// ────────────────────────────────────────────────────────────────────────────

describe('Property: output contains no phantom characters', () => {
  it('every output char is either in the input or in the engine introduced set', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 48 }),
        fc.constantFrom(...LANGS),
        (s, lang) => {
          const out = t.transliterate(s, lang);
          // Build the union: NFC-lowered input chars ∪ Hangul ∪ whitespace.
          // The engine lowercases + NFC normalizes input before processing,
          // so passthrough chars in the output reflect the lowered form.
          // Iterate via for…of to get Unicode code points (avoids surrogate
          // pair splitting that `.split("")` / spread would otherwise hit).
          const allowedFromInput = new Set<string>();
          for (const ch of s.normalize('NFC').toLowerCase()) {
            allowedFromInput.add(ch);
          }
          for (const ch of out) {
            if (ENGINE_INTRODUCED_CHARS_RE.test(ch)) continue; // Hangul/space
            if (allowedFromInput.has(ch)) continue;            // passthrough
            return false;                                      // phantom!
          }
          return true;
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Property 6 — Korean output validity for curated exception surfaces
// ────────────────────────────────────────────────────────────────────────────

const EXCEPTION_SURFACE_SAMPLES: ReadonlyArray<readonly [string, SourceLang, string]> = [
  // [latin, lang, expected Korean exception surface]
  ['Opus One', 'en', '오푸스원'],
  ['Sassicaia', 'it', '사시카이아'],
  ['Tignanello', 'it', '티냐넬로'],
  ['Antinori', 'it', '안티노리'],
  ['Gaja', 'it', '가야'],
  ['Penfolds', 'en', '펜폴즈'],
  ['Krug', 'fr', '크뤼그'],
  ['Tempranillo', 'es', '템프라니요'],
  ['Riesling', 'fr', '리슬링'],
  ['Mosel', 'fr', '모젤'],
];

describe('Property: exception surfaces emit pure Hangul (no Latin leakage)', () => {
  for (const [latin, lang, expected] of EXCEPTION_SURFACE_SAMPLES) {
    it(`"${latin}" (${lang}) → "${expected}"`, () => {
      const out = t.transliterate(latin, lang);
      expect(out).toBe(expected);
      expect(HANGUL_SYLLABLE_RE.test(out)).toBe(true);
      // No Latin letters from the input survived.
      expect(/[a-z]/i.test(out)).toBe(false);
    });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Property 7 — Exception catalog completeness for the canonical wine
// vocabulary. These terms MUST resolve via EXCEPTIONS or rule-level word
// hits. The expected Korean is pinned per the live rule tables / catalog as
// of RFC-003 §4.5; if you change the engine, the catalog must move in sync.
// ────────────────────────────────────────────────────────────────────────────

const CANONICAL_WINE_VOCAB: ReadonlyArray<readonly [string, SourceLang, string]> = [
  // Producer-level exceptions (EXCEPTIONS map)
  ['Chateau Margaux', 'fr', '샤또 마고'],
  // Region / appellation rule hits
  ['Margaux', 'fr', '마고'],
  ['Bordeaux', 'fr', '보르도'],
  ['Burgundy', 'fr', '부르고뉴'],   // FR rule "burgundy"
  ['Bourgogne', 'fr', '부르고뉴'],  // FR rule "bourgogne"
  ['Champagne', 'fr', '샴페인'],
  ['Sauternes', 'fr', '소테른'],
  ['Pauillac', 'fr', '포이약'],
  // Italian
  ['Barolo', 'it', '바롤로'],
  ['Chianti', 'it', '키안티'],
  ['Pinot', 'it', '피노'],
  // Spanish
  ['Rioja', 'es', '리오하'],
  // 'Chateau' alone (no estate) — FR word-level rule
  ['Chateau', 'fr', '샤또'],
];

describe('Property: canonical wine vocabulary catalog completeness', () => {
  it('contains ≥10 well-known terms (acceptance bar)', () => {
    expect(CANONICAL_WINE_VOCAB.length).toBeGreaterThanOrEqual(10);
  });

  for (const [latin, lang, expected] of CANONICAL_WINE_VOCAB) {
    it(`"${latin}" (${lang}) → "${expected}"`, () => {
      expect(t.transliterate(latin, lang)).toBe(expected);
    });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Adversarial / boundary regression cases
// ────────────────────────────────────────────────────────────────────────────

describe('Regression: boundary inputs', () => {
  it('empty string → empty string', () => {
    expect(t.transliterate('', 'fr')).toBe('');
  });

  it('whitespace-only input → empty string (trim semantics)', () => {
    expect(t.transliterate('   \t  ', 'fr')).toBe('');
  });

  it('generateAliases on empty/whitespace returns []', () => {
    expect(t.generateAliases('', 'fr')).toEqual([]);
    expect(t.generateAliases('   ', 'fr')).toEqual([]);
  });

  it('generateAliases with invalid lang returns []', () => {
    expect(t.generateAliases('Barolo', 'de')).toEqual([]);
    expect(t.generateAliases('Barolo', 'ko')).toEqual([]);
  });

  it('1000-char repeated input does not throw and stays bounded', () => {
    const long = 'a'.repeat(1000);
    const out = t.transliterate(long, 'fr');
    expect(out).toBeTypeOf('string');
    expect(out.length).toBeLessThanOrEqual(LENGTH_BOUND_K * 1000);
  });

  it('multilingual mixed input (French + Italian in same string) does not crash', () => {
    // The engine processes the string under a single SourceLang; here we
    // verify the FR pass produces a deterministic Korean rendering of a
    // mixed-language wine description.
    const mixed = 'Château Barolo';
    const out = t.transliterate(mixed, 'fr');
    expect(out).toBeTypeOf('string');
    expect(HANGUL_SYLLABLE_RE.test(out)).toBe(true);
    // Deterministic across invocations
    expect(t.transliterate(mixed, 'fr')).toBe(out);
  });

  it('adversarial: emoji + Korean + Latin mixed is handled without throwing', () => {
    const adv = '🍷 Château 보르도 wine 2018';
    const out = t.transliterate(adv, 'fr');
    expect(out).toBeTypeOf('string');
    // Hangul should appear (from 'château' and the existing Korean span).
    expect(HANGUL_SYLLABLE_RE.test(out)).toBe(true);
    // Determinism on adversarial input.
    expect(t.transliterate(adv, 'fr')).toBe(out);
  });

  it('passthrough of digits (vintage years) is preserved', () => {
    // applyRules pass-through covers digits — no rule key matches them.
    const out = t.transliterate('test 2018', 'fr');
    expect(out).toContain('2018');
  });

  it('NFC and NFD inputs of an accented label collide on the exception', () => {
    // Property: Map.get uses codepoint equality; NFC normalization in the
    // engine guards against macOS NFD strings silently missing keys.
    const nfd = 'Château Margaux'.normalize('NFD');
    const nfc = 'Château Margaux'.normalize('NFC');
    expect(t.transliterate(nfd, 'fr')).toBe(t.transliterate(nfc, 'fr'));
  });
});
