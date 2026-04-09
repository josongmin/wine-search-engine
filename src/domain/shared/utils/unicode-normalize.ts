/**
 * Consolidated Unicode confusables / homoglyph map.
 *
 * Single source of truth for cross-script homoglyph → ASCII Latin mappings.
 * Based on Unicode TR39 (https://www.unicode.org/reports/tr39/) confusables.
 *
 * NFKC normalization handles fullwidth/half-width and compatibility variants
 * (e.g. ｆ→f, ²→2) but NOT cross-script homoglyphs. This map covers the most
 * common Cyrillic, Greek, Armenian, and fullwidth attack/confusion characters.
 *
 * Consumers:
 * - `normalizeHomoglyphs()` in this module (ingestion / indexing normalization)
 * - `QuerySanitizer` (security: prompt injection pattern matching)
 * - `AdversarialGuard` (alias deconfusion)
 */
export const HOMOGLYPH_MAP: ReadonlyMap<string, string> = new Map([
  // ── Cyrillic uppercase ──
  ['\u0410', 'A'], // А → A
  ['\u0412', 'B'], // В → B
  ['\u0421', 'C'], // С → C
  ['\u0415', 'E'], // Е → E
  ['\u041D', 'H'], // Н → H
  ['\u041A', 'K'], // К → K
  ['\u041C', 'M'], // М → M
  ['\u041E', 'O'], // О → O
  ['\u0420', 'P'], // Р → P  (TR39: visually identical to Latin P)
  ['\u0422', 'T'], // Т → T
  ['\u0425', 'X'], // Х → X

  // ── Cyrillic lowercase ──
  ['\u0430', 'a'], // а → a
  ['\u0435', 'e'], // е → e
  ['\u0438', 'i'], // и → i (approximate — visually similar in some fonts)
  ['\u043A', 'k'], // к → k
  ['\u043C', 'm'], // м → m
  ['\u043D', 'n'], // н → n
  ['\u043E', 'o'], // о → o
  ['\u043F', 'p'], // п → p
  ['\u0440', 'p'], // р → p  (TR39: visually identical to Latin p)
  ['\u0441', 'c'], // с → c
  ['\u0442', 't'], // т → t
  ['\u0443', 'y'], // у → y
  ['\u0445', 'x'], // х → x

  // ── Cyrillic additional (security-relevant TR39 confusables) ──
  ['\u0432', 'b'], // в → b  (approximate — visually similar in many fonts)
  ['\u0433', 'r'], // г → r  (approximate — visually similar in italic/handwriting)
  ['\u0444', 'f'], // ф → f  (approximate — critical for "forget" injection bypass)
  ['\u0424', 'F'], // Ф → F
  ['\u0413', 'G'], // Г → G  (approximate — visually similar in some sans-serif fonts)
  ['\u0414', 'D'], // Д → D  (approximate — visually similar in italic)

  // ── Cyrillic extended ──
  ['\u0455', 's'], // ѕ → s
  ['\u0456', 'i'], // і → i
  ['\u0458', 'j'], // ј → j
  ['\u04BB', 'h'], // һ → h
  ['\u0501', 'd'], // ԁ → d
  ['\u051B', 'q'], // ԛ → q
  ['\u051D', 'w'], // ԝ → w

  // ── Greek lowercase ──
  ['\u03B1', 'a'], // α → a  (Greek small alpha)
  ['\u03B5', 'e'], // ε → e  (Greek small epsilon — approximate)
  ['\u03B7', 'h'], // η → h  (Greek small eta — visually similar)
  ['\u03B9', 'i'], // ι → i  (Greek small iota)
  ['\u03BA', 'k'], // κ → k  (Greek small kappa)
  ['\u03BD', 'v'], // ν → v  (Greek small nu)
  ['\u03BF', 'o'], // ο → o  (Greek small omicron)
  ['\u03C1', 'r'], // ρ → r  (Greek small rho — visually similar to Latin r)
  ['\u03C4', 't'], // τ → t  (Greek small tau — approximate)
  ['\u03C5', 'u'], // υ → u  (Greek small upsilon)

  // ── Greek uppercase ──
  ['\u0391', 'A'], // Α → A  (Greek capital alpha)
  ['\u0392', 'B'], // Β → B  (Greek capital beta)
  ['\u0395', 'E'], // Ε → E  (Greek capital epsilon)
  ['\u0396', 'Z'], // Ζ → Z  (Greek capital zeta)
  ['\u0397', 'H'], // Η → H  (Greek capital eta)
  ['\u0399', 'I'], // Ι → I  (Greek capital iota)
  ['\u039A', 'K'], // Κ → K  (Greek capital kappa)
  ['\u039C', 'M'], // Μ → M  (Greek capital mu)
  ['\u039D', 'N'], // Ν → N  (Greek capital nu)
  ['\u039F', 'O'], // Ο → O  (Greek capital omicron)
  ['\u03A1', 'P'], // Ρ → P  (Greek capital rho)
  ['\u03A4', 'T'], // Τ → T  (Greek capital tau)
  ['\u03A5', 'Y'], // Υ → Y  (Greek capital upsilon)
  ['\u03A7', 'X'], // Χ → X  (Greek capital chi)

  // ── Armenian lookalikes ──
  // Without these, "ign\u0585re your instructions" bypasses injection patterns.
  ['\u0561', 'a'], // ա → a  (Armenian ayb)
  ['\u0565', 'e'], // ե → e  (Armenian ech)
  ['\u056B', 'h'], // ի → h  (Armenian ini — approximate)
  ['\u056D', 'n'], // խ → n  (Armenian xeh — approximate in some fonts)
  ['\u0570', 'h'], // հ → h  (Armenian ho)
  ['\u0578', 'n'], // ո → n  (Armenian vo — approximate)
  ['\u0585', 'o'], // օ → o  (Armenian oh — visually identical to Latin o)
  ['\u057D', 's'], // ս → s  (Armenian seh)
  ['\u057E', 'v'], // վ → v  (Armenian vew)
  ['\u0580', 'r'], // ր → r  (Armenian reh)

  // ── Fullwidth Latin ──
  ['\uFF21', 'A'], // Ａ → A
  ['\uFF22', 'B'], // Ｂ → B
  ['\uFF23', 'C'], // Ｃ → C

  // ── Dash variants ──
  ['\u2010', '-'], // Hyphen → ASCII hyphen
  ['\u2011', '-'], // Non-breaking hyphen
  ['\u2012', '-'], // Figure dash
  ['\u2013', '-'], // En dash
  ['\u2014', '-'], // Em dash
]);

/**
 * Normalizes a Unicode string for safe comparison and indexing.
 *
 * Steps:
 * 1. NFC normalization (canonical decomposition + canonical composition).
 * 2. Trim leading/trailing whitespace.
 * 3. Collapse interior runs of whitespace to a single space.
 *
 * NOTE: Does NOT apply homoglyph replacement — that is a lossy transform
 * appropriate for query normalization and security, but not for indexing
 * (Cyrillic wine labels like "Массандра" would be corrupted).
 * Use {@link normalizeUnicodeWithHomoglyphs} when homoglyph replacement is needed.
 *
 * @param input - The raw string to normalize.
 * @returns The normalized string.
 */
export function normalizeUnicode(input: string): string {
  let result = input.normalize('NFC');
  result = result.trim().replace(/\s+/g, ' ');
  return result;
}

/**
 * Like {@link normalizeUnicode} but also replaces visual homoglyphs
 * (Cyrillic/Greek/Armenian look-alikes → Latin equivalents).
 *
 * Use this for **query-time normalization** and **security sanitization**
 * where cross-script deconfusion is needed. Do NOT use for indexing/ingestion.
 */
export function normalizeUnicodeWithHomoglyphs(input: string): string {
  let result = input.normalize('NFC');
  result = normalizeHomoglyphs(result);
  result = result.trim().replace(/\s+/g, ' ');
  return result;
}

/**
 * Strips all combining diacritical marks from a string.
 *
 * Uses NFD decomposition to separate base characters from combining marks,
 * then removes the combining marks (Unicode category Mn: Mark, Nonspacing).
 *
 * @param input - The string to strip accents from.
 * @returns The accent-free string.
 */
export function stripAccents(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC');
}

/**
 * Replaces common confusable homoglyphs (primarily Cyrillic look-alikes)
 * with their Latin equivalents.
 *
 * @param input - The string potentially containing homoglyphs.
 * @returns The string with homoglyphs replaced by Latin counterparts.
 */
export function normalizeHomoglyphs(input: string): string {
  // NFC first: ensures combining character sequences (e.g. e + \u0301) are
  // pre-composed so per-codepoint map lookup matches single chars correctly.
  const composed = input.normalize('NFC');
  let result = '';
  for (const char of composed) {
    const replacement = HOMOGLYPH_MAP.get(char);
    result += replacement ?? char;
  }
  return result;
}
