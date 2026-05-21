/**
 * Deterministic caps-initialism derivation from a canonical wine label.
 *
 * Wine queries routinely use initialisms — "CM 15" for Château Margaux
 * 2015, "DRC" for Domaine de la Romanée-Conti, "PRCM" for Pavillon Rouge
 * du Château Margaux. The curated alias catalog does not enumerate these
 * by hand at scale; this module produces them as a structural ETL
 * transform.
 *
 * The derivation is a **pure deterministic function** of the canonical
 * label. There is no heuristic disambiguation, no ML guess, no
 * statistical inference — same label in, same initialism set out, every
 * time. Audit is trivial: read the rules below and run them by hand.
 *
 * The companion AliasType `'derived_initialism'` is capped lower than
 * curated aliases in `candidate-scorer.ts` because initialisms collide
 * frequently — the resolver still demands corroborating evidence
 * (vintage, producer, region) before emitting a resolved status purely
 * on an initialism hit.
 */

/**
 * Stop words excluded from initialism derivation across the dominant
 * Romance-language wine catalogs (French / Italian / Spanish) plus
 * English articles / conjunctions. Order doesn't matter; lookup is
 * case-insensitive against the lowercased token.
 */
const INITIALISM_STOP_WORDS: ReadonlySet<string> = new Set([
  // English
  'the', 'a', 'an', 'of', 'and', '&',
  // French (full + elided forms left bare after the apostrophe is stripped
  // by TOKEN_SEP_RE; "d'Yquem" → ['d', 'yquem'] so bare 'd' must be a
  // stop word, and same for 'l' from "l'Évangile").
  'de', 'du', 'des', 'le', 'la', 'les', "d'", 'd', 'l', "l'",
  // Italian
  'di', 'da', 'del', 'della', 'delle', 'dei', 'degli', 'lo',
  // Spanish
  'el', 'los', 'las',
  // German
  'von', 'der', 'die', 'das', 'zur', 'zum',
]);

/**
 * Token separator regex: whitespace, hyphen, en-dash, em-dash, apostrophe
 * (covers "Domaine de la Romanée-Conti" → ['domaine','de','la','romanée','conti']
 * and "Château d'Yquem" → ['château','d','yquem']).
 */
const TOKEN_SEP_RE = /[\s\-–—'']+/u;

/**
 * Decimal-year pattern (4-digit). Stripped before tokenization so the
 * vintage doesn't pollute the initialism (e.g. "Château Margaux 2015"
 * yields 'CM', not 'CM2'). The 2-digit shorthand is handled by
 * {@link expandVintageVariants} on the query side. Uses Unicode-safe
 * boundaries instead of `\b` (CLAUDE.md rule 8) so non-ASCII labels
 * still match correctly.
 */
const FOUR_DIGIT_YEAR_RE = /(?<=^|[^\p{L}\p{N}])\d{4}(?=$|[^\p{L}\p{N}])/gu;

/**
 * Confidence prior for derived-initialism alias entries (RFC-003 §4.3
 * weighting tier).
 *
 * Set below `misspelling` (0.6) to ensure that on a tie between a curated
 * alias and a derived initialism, the resolver picks the curated one.
 * Initialisms exist purely to widen recall on shorthand queries; they
 * never claim authoritative identity on their own.
 */
const DERIVED_INITIALISM_CONFIDENCE = 0.5;

/** Minimum significant tokens needed to emit any initialism. */
const MIN_SIGNIFICANT_TOKENS = 2;

/**
 * Inclusive max number of leading significant tokens we'll emit prefixed
 * initialisms for. Beyond this, an initialism becomes a memorability
 * burden ("PRDCMU" is not a real shorthand anyone uses), so we cap at 4
 * — enough to cover the 3-word + occasional 4-word producer name.
 */
const MAX_PREFIX_LENGTH = 4;

/** Public result row: a single derived initialism with its confidence weight. */
export interface DerivedInitialism {
  readonly surface: string;
  readonly confidencePrior: number;
}

/**
 * Unicode codepoint ranges for the "Latin letter" gate. We accept the
 * basic ASCII Latin block (uppercase + lowercase) and the
 * Latin-1-Supplement letter band (À–ÿ, omitting the punctuation rows)
 * so accented producer names like "Château", "Cabernet", "Étoile"
 * survive the gate even before NFD-strip.
 */
const LATIN_UPPER_LO = 0x41;
const LATIN_UPPER_HI = 0x5A;
const LATIN_LOWER_LO = 0x61;
const LATIN_LOWER_HI = 0x7A;
const LATIN_ACCENTED_LO = 0xC0;
const LATIN_ACCENTED_HI = 0xFF;

function isSignificantLatinToken(token: string): boolean {
  if (token.length === 0) return false;
  if (INITIALISM_STOP_WORDS.has(token.toLowerCase())) return false;
  // First character must be a Latin letter — a token starting with a
  // CJK / Hangul codepoint contributes no Latin initial. The Korean
  // alias catalog handles its own shorthand independently.
  const firstCode = token.codePointAt(0);
  if (firstCode === undefined) return false;
  const isLatinUpper = firstCode >= LATIN_UPPER_LO && firstCode <= LATIN_UPPER_HI;
  const isLatinLower = firstCode >= LATIN_LOWER_LO && firstCode <= LATIN_LOWER_HI;
  const isLatinAccented = firstCode >= LATIN_ACCENTED_LO && firstCode <= LATIN_ACCENTED_HI;
  return isLatinUpper || isLatinLower || isLatinAccented;
}

function leadingLetter(token: string): string {
  // Strip diacritics on the leading character so 'Château' → 'C',
  // 'Étoile' → 'E', preserving the conventional initialism reading.
  const decomposed = token.normalize('NFD');
  const stripped = decomposed.replace(/[̀-ͯ]/gu, '');
  return stripped.charAt(0).toUpperCase();
}

/**
 * Derives the deterministic set of caps-initialisms for a canonical wine
 * label.
 *
 * Algorithm:
 *  1. Strip 4-digit vintages from the label (treat vintage as a separate
 *     constraint axis — query side does its own 2-digit expansion).
 *  2. Tokenize on whitespace / hyphens / apostrophes.
 *  3. Drop stop words (Romance articles, English articles, German
 *     determiners) and non-Latin-leading tokens.
 *  4. Take the leading letter of each significant token (with diacritics
 *     stripped) and uppercase it.
 *  5. Emit:
 *      - The full initialism (all significant tokens)
 *      - Every prefix of length 2..MAX_PREFIX_LENGTH (covers the natural
 *        shorthand range)
 *  6. Dedupe and require minimum length 2 (single-letter initialisms
 *     collide with every label starting with that letter — useless).
 *
 * Stability: returned in deterministic order (sorted ascending) so the
 * ETL artifact hash is reproducible across rebuilds.
 */
export function deriveInitialisms(canonicalLabel: string): readonly DerivedInitialism[] {
  if (canonicalLabel.length === 0) return [];
  const dewvintaged = canonicalLabel.replace(FOUR_DIGIT_YEAR_RE, ' ');
  const rawTokens = dewvintaged.split(TOKEN_SEP_RE);
  const significant: string[] = [];
  for (const token of rawTokens) {
    if (isSignificantLatinToken(token)) {
      significant.push(token);
    }
  }
  if (significant.length < MIN_SIGNIFICANT_TOKENS) return [];

  const letters: string[] = [];
  for (const token of significant) {
    const letter = leadingLetter(token);
    if (letter.length === 0) continue;
    letters.push(letter);
  }
  if (letters.length < MIN_SIGNIFICANT_TOKENS) return [];

  const variants = new Set<string>();
  // Full initialism
  variants.add(letters.join(''));
  // Prefix initialisms (length 2..min(MAX_PREFIX_LENGTH, letters.length-1))
  const maxPrefix = Math.min(MAX_PREFIX_LENGTH, letters.length - 1);
  for (let len = MIN_SIGNIFICANT_TOKENS; len <= maxPrefix; len++) {
    variants.add(letters.slice(0, len).join(''));
  }

  const sorted = [...variants].sort();
  return sorted.map((surface) => ({
    surface,
    confidencePrior: DERIVED_INITIALISM_CONFIDENCE,
  }));
}
