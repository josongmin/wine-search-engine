/**
 * Double Metaphone phonetic encoding (Philips, 2000) wrapper.
 *
 * Why two keys (primary + alternate)?
 *   Double Metaphone returns two phonetic codes to capture both the
 *   anglicized and source-language pronunciations of a name. This is
 *   critical for wine vocabulary because brand names are dominated by
 *   foreign-origin proper nouns (French, Italian, German). A user typing
 *   "Margeaux" expects to find "Margaux"; an English speaker pronouncing
 *   "Schmidt" might encode it as "XMT" (sh-MIT) while a German speaker
 *   encodes it as "SMT". The algorithm returns *both* so either side
 *   can find the other.
 *
 * Why the `double-metaphone` npm package?
 *   - License: MIT (compatible with project).
 *   - Maintainer: Titus Wormer (wooorm) — long-standing prolific OSS
 *     author of unified/remark; this implementation is the canonical
 *     reference JS port of the published algorithm.
 *   - Pure ESM (`"type": "module"`), no transitive deps, ships TS
 *     declarations (`index.d.ts`). Node 22 ESM-native — no shim required.
 *   - Reference-accurate against Philips's published test cases
 *     (Thompson → TMSN, Schmidt → XMT/SMT, etc.).
 *   - Bundle size: ~34 KB unpacked, single index.js, no runtime deps.
 *
 * Korean / Hangul input policy:
 *   Double Metaphone is defined only for Latin script. Hangul (and any
 *   purely non-Latin input) is intentionally encoded to an empty string;
 *   that path is owned by the transliterator (see `Transliterator` and
 *   `KOREAN_TRANSLITERATION_*` rules in `query-normalizer.ts`), which
 *   romanizes Korean wine terms before any phonetic comparison runs.
 *
 * Diacritic policy:
 *   Latin-1 supplement diacritics (é, ñ, ü, ô, …) are normalized away
 *   via NFD + combining-mark strip before encoding. This lets "Pétrus"
 *   and "Petrus" share a key even though the upstream library only
 *   accepts ASCII letters.
 */
import { doubleMetaphone as doubleMetaphoneImpl } from 'double-metaphone';
import { stripAccents } from '../../shared/utils/unicode-normalize.js';

/**
 * Phonetic key pair produced by the Double Metaphone algorithm.
 *
 * - `primary` is the anglicized phonetic code.
 * - `alternate` is the source-language phonetic code, OR `null` when the
 *   library returned an identical alternate to the primary (the common
 *   case for words that have a single pronunciation).
 *
 * Both fields are deterministic and pure functions of the input string.
 */
export interface DoubleMetaphoneKeys {
  readonly primary: string;
  readonly alternate: string | null;
}

/** Empty-input return value, exposed as a const to avoid per-call allocation. */
const EMPTY_KEYS: DoubleMetaphoneKeys = Object.freeze({ primary: '', alternate: null });

/** Empty key set, exposed as a const to avoid per-call allocation. */
const EMPTY_KEY_SET: ReadonlySet<string> = new Set<string>();

/**
 * Permitted code-point range produced by the Double Metaphone algorithm.
 *
 * The published algorithm only emits uppercase ASCII consonant codes
 * (plus the 'X' for sh/ch and '0' for "th"). Any other character in the
 * library output would indicate a corrupted or incompatible version of
 * the upstream package; the runtime guard below rejects that case rather
 * than silently propagating garbage downstream.
 */
const DOUBLE_METAPHONE_KEY_RE = /^[A-Z0]*$/;

function isDoubleMetaphoneTuple(value: unknown): value is readonly [string, string] {
  return (
    Array.isArray(value)
    && value.length === 2
    && typeof value[0] === 'string'
    && typeof value[1] === 'string'
    && DOUBLE_METAPHONE_KEY_RE.test(value[0])
    && DOUBLE_METAPHONE_KEY_RE.test(value[1])
  );
}

/**
 * Returns the Double Metaphone primary + alternate keys for an input.
 *
 * Behavior contract:
 *   - Empty input → `{ primary: '', alternate: null }`. Does NOT throw.
 *   - Non-Latin-only input (e.g. Hangul `샤또마고`) → empty primary +
 *     `null` alternate. Use the transliterator before this function for
 *     Hangul-bearing strings.
 *   - Diacritics are stripped before encoding so `Pétrus` and `Petrus`
 *     produce the same key pair.
 *   - When the upstream library returns identical primary and alternate
 *     codes, `alternate` is normalized to `null` to make the "single
 *     pronunciation" case explicit and reduce duplicate work at the
 *     callsite.
 *
 * Pure, deterministic, no I/O.
 *
 * @param input — Raw string from a query or alias surface form.
 */
export function doubleMetaphone(input: string): DoubleMetaphoneKeys {
  if (input.length === 0) {
    return EMPTY_KEYS;
  }
  const normalized = stripAccents(input).trim();
  if (normalized.length === 0) {
    return EMPTY_KEYS;
  }

  // The upstream library returns ['', ''] on inputs with no Latin letters,
  // so we explicitly normalize that to EMPTY_KEYS to keep the contract
  // crisp at the callsite (Hangul-only / digit-only / punctuation-only
  // inputs all collapse to the same shape).
  const raw: unknown = doubleMetaphoneImpl(normalized);
  if (!isDoubleMetaphoneTuple(raw)) {
    // Defensive: a future library update that violates the output
    // contract (e.g. non-string entries) MUST fail loudly rather than
    // poison the alias index with malformed phonetic keys.
    throw new Error(
      `double-metaphone returned a value that did not match the [primary, alternate] string-pair contract: ${JSON.stringify(raw)}`,
    );
  }

  const [primary, alternate] = raw;
  if (primary.length === 0) {
    return EMPTY_KEYS;
  }

  return {
    primary,
    alternate: alternate.length === 0 || alternate === primary ? null : alternate,
  };
}

/**
 * Returns the set of distinct Double Metaphone keys for an input.
 *
 * Useful when comparing two phonetic-key sets for any overlap (the
 * "either pronunciation matches" semantic of Double Metaphone).
 *
 * Empty input → empty set (callers should treat this as "no phonetic
 * signal" — never a wildcard match).
 */
export function doubleMetaphoneKeys(input: string): ReadonlySet<string> {
  const { primary, alternate } = doubleMetaphone(input);
  if (primary.length === 0) {
    return EMPTY_KEY_SET;
  }
  if (alternate === null) {
    return new Set([primary]);
  }
  return new Set([primary, alternate]);
}

/**
 * Returns `true` when two strings share any Double Metaphone key.
 *
 * Empty / non-Latin inputs return `false` — phonetic matching is
 * undefined outside Latin script, so we refuse to claim a match rather
 * than fabricate one.
 */
export function doubleMetaphoneMatches(a: string, b: string): boolean {
  const aKeys = doubleMetaphoneKeys(a);
  if (aKeys.size === 0) {
    return false;
  }
  const bKeys = doubleMetaphoneKeys(b);
  if (bKeys.size === 0) {
    return false;
  }
  for (const key of aKeys) {
    if (bKeys.has(key)) {
      return true;
    }
  }
  return false;
}
