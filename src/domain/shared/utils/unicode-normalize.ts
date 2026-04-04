/**
 * Common Cyrillic-to-Latin homoglyph mappings.
 * Keys are Cyrillic code points that visually resemble Latin letters.
 */
const HOMOGLYPH_MAP: ReadonlyMap<string, string> = new Map([
  ['\u0410', 'A'], // А → A
  ['\u0412', 'B'], // В → B
  ['\u0421', 'C'], // С → C
  ['\u0415', 'E'], // Е → E
  ['\u041D', 'H'], // Н → H
  ['\u041A', 'K'], // К → K
  ['\u041C', 'M'], // М → M
  ['\u041E', 'O'], // О → O
  ['\u0420', 'P'], // Р → P
  ['\u0422', 'T'], // Т → T
  ['\u0425', 'X'], // Х → X
  ['\u0430', 'a'], // а → a
  ['\u0435', 'e'], // е → e
  ['\u043E', 'o'], // о → o
  ['\u0440', 'p'], // р → p
  ['\u0441', 'c'], // с → c
  ['\u0443', 'y'], // у → y
  ['\u0445', 'x'], // х → x
  ['\u0455', 's'], // ѕ → s
  ['\u0456', 'i'], // і → i
  ['\u0458', 'j'], // ј → j
  ['\u04BB', 'h'], // һ → h
]);

/**
 * Normalizes a Unicode string for safe comparison and indexing.
 *
 * Steps:
 * 1. NFC normalization (canonical decomposition + canonical composition).
 * 2. Homoglyph replacement (Cyrillic look-alikes to Latin).
 * 3. Trim leading/trailing whitespace.
 * 4. Collapse interior runs of whitespace to a single space.
 *
 * @param input - The raw string to normalize.
 * @returns The normalized string.
 */
export function normalizeUnicode(input: string): string {
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
  let result = '';
  for (const char of input) {
    const replacement = HOMOGLYPH_MAP.get(char);
    result += replacement ?? char;
  }
  return result;
}
