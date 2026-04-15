/**
 * Wine-domain-aware title case (Rule 25: single source-of-truth).
 *
 * Capitalises each word except Romance language prepositions/articles that
 * are conventionally lowercase in region and appellation names:
 *   - "brunello di montalcino" → "Brunello di Montalcino"
 *   - "côtes du rhône"        → "Côtes du Rhône"
 *   - "ribera del duero"      → "Ribera del Duero"
 *
 * The first word is always capitalised regardless of membership in the
 * exception set.
 *
 * Covers French (de, du, des, la, le, les), Italian (di, della, delle,
 * dei, da, al), Spanish (del, los, las, el), and Portuguese (do, das).
 */

/** Romance prepositions/articles kept lowercase in wine region names. */
const LOWERCASE_PREPOSITIONS: ReadonlySet<string> = new Set([
  'di', 'du', 'de', 'del', 'della', 'delle', 'dei', 'des', 'da',
  'la', 'le', 'les', 'los', 'las', 'el', 'al', 'do', 'das',
]);

export function wineTitleCase(s: string): string {
  return s
    .split(/\s+/)
    .map((w, i) => {
      if (w.length === 0) return w;
      if (i > 0 && LOWERCASE_PREPOSITIONS.has(w.toLowerCase())) return w.toLowerCase();
      return w[0]!.toUpperCase() + w.slice(1);
    })
    .join(' ');
}
