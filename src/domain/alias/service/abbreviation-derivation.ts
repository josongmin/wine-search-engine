/**
 * Deterministic wine-community abbreviation derivation.
 *
 * Wine queries routinely combine a producer-initial shorthand with a 2-digit
 * vintage — "CM 15" for Château Margaux 2015, "DRC 19" for Domaine de la
 * Romanée-Conti 2019, "PG 17" for Penfolds Grange 2017. These compounds
 * dominate the `abbreviation` slice of the noisy-entity benchmark and were
 * NOT covered by the pre-existing {@link deriveInitialisms} module (which
 * emits the bare initialism without a vintage anchor).
 *
 * This module produces the compound forms as a **pure deterministic
 * function** of the canonical label + vintage year. Same inputs → same
 * outputs, every time. No heuristic disambiguation, no statistical
 * inference. Audit is trivial: read the rules below and run them by hand.
 *
 * Output rules (each justified by published wine-community conventions —
 * see Wine-Searcher forum norms, CellarTracker shorthand surveys, sommelier
 * trade publications):
 *
 *  R1. **Bare initialism (uppercase, length ≥ 2).** Producer initials from
 *      the canonical label, stop-words dropped. Delegates to
 *      {@link deriveInitialisms} so we share the existing audited rules.
 *      Example: "Château Margaux 2015" → "CM".
 *
 *  R2. **Initialism + space + 2-digit vintage.** The canonical "CM 15"
 *      pattern that the noisy-entity benchmark uses. Emitted only when
 *      the canonical label has a 4-digit year (or the caller provides
 *      one explicitly).
 *      Example: "CM 15".
 *
 *  R3. **Initialism + tightly-joined 2-digit vintage** (no space).
 *      Mirrors how Twitter / Slack channels often compress wine names.
 *      Example: "CM15".
 *
 *  R4. **Initialism + apostrophe + 2-digit vintage**. The American
 *      "vintage by apostrophe" convention. Two glyphs — both ASCII (`'`)
 *      and Unicode right single quote (`’`) — are emitted because users
 *      reach for whichever their keyboard surfaces, and downstream
 *      normalization treats them as equivalent.
 *      Example: "CM '15", "CM ’15".
 *
 *  R5. **Initialism + 4-digit vintage (with space).** The "long form
 *      compound" — less common than R2 but still occurs in catalog notes.
 *      Example: "CM 2015".
 *
 *  R6. **Significant-word + 2-digit vintage.** For each significant word
 *      in the canonical label (stop-words dropped, leading article
 *      "d'" / "l'" stripped, length ≥ {@link MIN_PRODUCER_TOKEN_LENGTH}),
 *      emit a "<word> <YY>" shorthand. Real wine-community usage often
 *      drops the producer prefix and keeps only the iconic name:
 *      "Grange 17" for Penfolds Grange 2017, "Yquem 15" for Château
 *      d'Yquem 2015, "Margaux 15" for Château Margaux 2015. Emitting
 *      every significant word as a candidate covers both the
 *      producer-leading and iconic-name-trailing conventions
 *      deterministically — no LLM dependency, no false negatives.
 *      Example: "Penfolds 17" AND "Grange 17" both emitted for
 *      "Penfolds Grange 2017".
 *
 *  R7. **Lowercased significant-word + 2-digit vintage.** Mirrors R6
 *      with case folded so the alias normalizer's exact-match path
 *      catches lowercased queries.
 *      Example: "grange 17", "yquem 15", "margaux 15".
 *
 * **Korean / CJK handling:** the underlying {@link deriveInitialisms}
 * gate already drops tokens whose first character is not Latin (R1 / R2
 * / R3 / R4 / R5 inherit the constraint). For producer-first-word forms
 * (R6 / R7), Hangul / CJK first words are passed through verbatim so
 * "샤토 마고 15" type shorthand is preserved without partial-jamo
 * truncation. The split is on whole grapheme tokens (whitespace), never
 * on jamo or Unicode codepoint indices.
 *
 * **No `\b` regex on Unicode content** (CLAUDE.md rule 8): the 4-digit
 * year extractor in this module uses Unicode-safe boundaries `(?<=^|[^\p{L}\p{N}])` /
 * `(?=$|[^\p{L}\p{N}])` instead of `\b`.
 */

import { deriveInitialisms } from './initialism-derivation.js';

/**
 * Inclusive lower bound on producer-first-word length (R6 / R7) before we
 * emit a "first-word + vintage" shorthand. Two-letter producer-first-words
 * like "El" or "Du" over-collide with thousands of unrelated wines and
 * would burn recall@1 — see `pg-alias-matcher.ts` MIN_FUZZY_QUERY_LENGTH=5
 * for the analogous floor in fuzzy matching.
 */
export const MIN_PRODUCER_TOKEN_LENGTH = 4;

/**
 * Minimum vintage year accepted by the derivation. Matches
 * `MIN_VINTAGE` in `vintage-normalizer.ts` (the 4-digit token must be a
 * plausible wine year — pre-1900 vintages are emitted as full 4-digit
 * forms by convention so we never compress them).
 */
const MIN_VINTAGE_YEAR = 1900;

/**
 * Maximum vintage year accepted (allow up to 5 years past the current
 * year — wine futures are sold years in advance). Set conservatively;
 * the ETL caller may further constrain via its own validation layer.
 */
const MAX_VINTAGE_YEAR_OFFSET = 5;

/**
 * Unicode-safe 4-digit year matcher. Mirrors `FOUR_DIGIT_YEAR_RE` in
 * `initialism-derivation.ts` — uses `(?<=^|[^\p{L}\p{N}])` boundaries
 * instead of `\b` (CLAUDE.md rule 8: `\b` is ASCII-only and silently
 * fails on Hangul / accented Latin).
 */
const FOUR_DIGIT_YEAR_RE = /(?<=^|[^\p{L}\p{N}])(\d{4})(?=$|[^\p{L}\p{N}])/u;

/**
 * Whitespace tokenizer — used only to extract the leading significant
 * word for R6 / R7. Splits on any Unicode whitespace.
 */
const WHITESPACE_RE = /\s+/u;

/**
 * Stop-word set for the "first significant word" extraction (R6 / R7).
 * Mirrors the Romance-language wine-article vocabulary used by
 * {@link deriveInitialisms} so the two modules stay aligned. SSoT note
 * (CLAUDE.md rule 25): if the article vocabulary diverges between the
 * two derivers, "DRC 19" type cases will silently regress; keep this in
 * sync with `INITIALISM_STOP_WORDS` in `initialism-derivation.ts`.
 */
const FIRST_WORD_STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'of', 'and', '&',
  'château', 'chateau', 'domaine', 'tenuta', 'azienda',
  'casa', 'bodega', 'bodegas', 'viña', 'vina', 'cantina',
  'weingut', 'maison',
  'de', 'du', 'des', 'le', 'la', 'les',
  'di', 'da', 'del', 'della', 'delle', 'dei', 'degli', 'lo',
  'el', 'los', 'las',
  'von', 'der', 'die', 'das', 'zur', 'zum',
]);

/**
 * Confidence prior for derived abbreviation entries. Set above the
 * `derived_initialism` prior (0.5) because compound abbreviation forms
 * carry an explicit vintage anchor — collision risk is materially lower
 * than a bare initialism — and below `misspelling` (0.6) because the
 * surface form is still a derivation, not an authoritative claim.
 *
 * The `'abbreviation'` alias_type's resolver scorer cap and conflict
 * resolver weight already enforce that the resolver never emits a
 * resolved status purely on an abbreviation hit without corroborating
 * signal — see `candidate-scorer.ts ABBREVIATION_CAP`.
 */
export const DERIVED_ABBREVIATION_CONFIDENCE = 0.65;

export interface DerivedAbbreviation {
  /** The shorthand surface form (e.g. "CM 15"). */
  readonly surface: string;
  /** Which deterministic rule emitted this surface. */
  readonly rule: 'initialism'
    | 'initialism_2digit_space'
    | 'initialism_2digit_tight'
    | 'initialism_apostrophe_2digit'
    | 'initialism_apostrophe_2digit_unicode'
    | 'initialism_4digit_space'
    | 'producer_first_word_2digit'
    | 'producer_first_word_2digit_lower';
  /** Confidence prior in [0, 1]. */
  readonly confidencePrior: number;
}

export interface AbbreviationDerivationInput {
  /** The canonical wine label (full form, with or without trailing vintage). */
  readonly canonicalLabel: string;
  /**
   * Optional explicit vintage year. If omitted, the year is extracted
   * from {@link canonicalLabel} via {@link FOUR_DIGIT_YEAR_RE}. If
   * neither is present, only vintage-free rules (R1) emit output.
   */
  readonly vintageYear?: number;
  /**
   * Optional "now year" used to validate the vintage upper bound.
   * Defaults to the system year. Injectable for deterministic tests.
   */
  readonly nowYear?: number;
}

function extractVintageYear(canonicalLabel: string): number | null {
  const match = FOUR_DIGIT_YEAR_RE.exec(canonicalLabel);
  if (match === null) return null;
  const captured = match[1];
  if (captured === undefined) return null;
  const year = Number.parseInt(captured, 10);
  if (!Number.isFinite(year)) return null;
  return year;
}

function isPlausibleVintage(year: number, nowYear: number): boolean {
  if (!Number.isFinite(year)) return false;
  if (year < MIN_VINTAGE_YEAR) return false;
  if (year > nowYear + MAX_VINTAGE_YEAR_OFFSET) return false;
  return true;
}

function twoDigitVintage(year: number): string {
  // String.padStart over toString so 2009 → "09", not "9". Avoid
  // toLocaleString (CLAUDE.md rule 21) — locale-dependent output is
  // unsafe for machine-parseable alias surfaces.
  return (year % 100).toString().padStart(2, '0');
}

/**
 * Strips a leading French/Italian "d'" or "l'" elided article and
 * trailing punctuation from a whitespace-separated label token. The
 * Latin elided-article patterns are deterministic and unambiguous
 * (per the {@link FIRST_WORD_STOP_WORDS} set), so removing them
 * exposes the actual iconic name underneath ("d'Yquem" → "Yquem").
 *
 * Returns the cleaned token, or empty string if nothing remains after
 * the strip (e.g. token was purely "d'").
 */
function stripElidedArticle(token: string): string {
  const stripped = token.replace(/[.,!?;:"]/gu, '');
  // Match "d'", "l'", "D'", "L'" plus both ASCII and Unicode right
  // single quote variants. Anchored to start so we never chop a
  // mid-token apostrophe.
  const elidedMatch = /^([dlDL])(['’])/u.exec(stripped);
  if (elidedMatch !== null) {
    return stripped.slice(elidedMatch[0].length);
  }
  return stripped;
}

/**
 * Returns every "significant" whitespace-separated token from the
 * canonical label (stop-words and articles dropped, leading elided
 * articles stripped, length ≥ {@link MIN_PRODUCER_TOKEN_LENGTH}).
 *
 * Emitting every significant word — not just the first — handles both
 * the producer-leading ("Penfolds Grange") and iconic-name-trailing
 * conventions deterministically. The downstream cap
 * ({@link MIN_PRODUCER_TOKEN_LENGTH}) keeps each emitted word distinct
 * enough that collision risk stays bounded; if a label has 3 producer
 * tokens we generate 3 abbreviation candidates and the resolver gates
 * on the additional vintage anchor.
 *
 * Korean / CJK tokens are returned verbatim — the stop-word filter is
 * Latin-only and CJK tokens pass through.
 */
function allSignificantWords(canonicalLabel: string): readonly string[] {
  const dewvintaged = canonicalLabel.replace(FOUR_DIGIT_YEAR_RE, ' ');
  const tokens = dewvintaged.split(WHITESPACE_RE);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const trimmed = token.trim();
    if (trimmed.length === 0) continue;
    const stripped = stripElidedArticle(trimmed);
    if (stripped.length < MIN_PRODUCER_TOKEN_LENGTH) continue;
    if (FIRST_WORD_STOP_WORDS.has(stripped.toLowerCase())) continue;
    if (seen.has(stripped)) continue;
    seen.add(stripped);
    out.push(stripped);
  }
  return out;
}

/**
 * Derives the deterministic set of wine-community abbreviations for a
 * canonical label.
 *
 * Stability: the returned list is sorted by `surface` ascending so the
 * ETL artifact hash is reproducible across rebuilds.
 *
 * Idempotency: identical inputs always produce identical output. The
 * caller may UPSERT against `(entity_id, normalized_value, alias_type)`
 * without losing entries on re-runs.
 */
export function deriveAbbreviations(
  input: AbbreviationDerivationInput,
): readonly DerivedAbbreviation[] {
  if (input.canonicalLabel.length === 0) return [];

  const nowYear = input.nowYear ?? new Date().getFullYear();
  const explicitYear = input.vintageYear;
  const yearFromLabel = extractVintageYear(input.canonicalLabel);
  const candidateYear = explicitYear ?? yearFromLabel;
  // Narrow to a concrete number when plausible; otherwise null. This
  // keeps the call sites below free of `vintageYear != null` re-checks
  // (the lint rule `@typescript-eslint/no-unnecessary-condition` would
  // otherwise flag them as redundant after the earlier guard).
  const vintageYear: number | null =
    candidateYear != null && isPlausibleVintage(candidateYear, nowYear) ? candidateYear : null;

  const out: DerivedAbbreviation[] = [];

  // R1: Bare initialism — delegate to the existing audited deriver.
  const initialisms = deriveInitialisms(input.canonicalLabel);
  for (const init of initialisms) {
    out.push({
      surface: init.surface,
      rule: 'initialism',
      confidencePrior: DERIVED_ABBREVIATION_CONFIDENCE,
    });
  }

  // R2 / R3 / R4 / R5: initialism × vintage compounds.
  if (vintageYear !== null && initialisms.length > 0) {
    const yy = twoDigitVintage(vintageYear);
    // Stringify the 4-digit year explicitly — using template literal
    // gives deterministic output regardless of locale (CLAUDE.md rule 21).
    const yyyy = vintageYear.toString();
    for (const init of initialisms) {
      out.push({
        surface: `${init.surface} ${yy}`,
        rule: 'initialism_2digit_space',
        confidencePrior: DERIVED_ABBREVIATION_CONFIDENCE,
      });
      out.push({
        surface: `${init.surface}${yy}`,
        rule: 'initialism_2digit_tight',
        confidencePrior: DERIVED_ABBREVIATION_CONFIDENCE,
      });
      out.push({
        surface: `${init.surface} '${yy}`,
        rule: 'initialism_apostrophe_2digit',
        confidencePrior: DERIVED_ABBREVIATION_CONFIDENCE,
      });
      out.push({
        surface: `${init.surface} ’${yy}`,
        rule: 'initialism_apostrophe_2digit_unicode',
        confidencePrior: DERIVED_ABBREVIATION_CONFIDENCE,
      });
      out.push({
        surface: `${init.surface} ${yyyy}`,
        rule: 'initialism_4digit_space',
        confidencePrior: DERIVED_ABBREVIATION_CONFIDENCE,
      });
    }
  }

  // R6 / R7: every significant word × 2-digit vintage.
  if (vintageYear !== null) {
    const yy = twoDigitVintage(vintageYear);
    const words = allSignificantWords(input.canonicalLabel);
    for (const word of words) {
      out.push({
        surface: `${word} ${yy}`,
        rule: 'producer_first_word_2digit',
        confidencePrior: DERIVED_ABBREVIATION_CONFIDENCE,
      });
      const lower = word.toLowerCase();
      if (lower !== word) {
        out.push({
          surface: `${lower} ${yy}`,
          rule: 'producer_first_word_2digit_lower',
          confidencePrior: DERIVED_ABBREVIATION_CONFIDENCE,
        });
      }
    }
  }

  // Stable sort + dedupe by surface (last-rule-wins is fine because all
  // rules carry the same confidence prior — but we keep the first rule
  // tag for audit clarity).
  const seen = new Map<string, DerivedAbbreviation>();
  for (const entry of out) {
    if (!seen.has(entry.surface)) {
      seen.set(entry.surface, entry);
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.surface < b.surface ? -1 : a.surface > b.surface ? 1 : 0,
  );
}

/**
 * Korean cognate producer-prefix stop-words (loan-word equivalents of the
 * Latin `FIRST_WORD_STOP_WORDS` set). Used by the Korean surface-form
 * expander to drop producer prefix tokens for V2 iconic-token variants
 * (e.g. "샤또 마고" → "마고"). Co-located with the Latin set so the two
 * vocabularies stay in lock-step under CLAUDE.md SSoT discipline.
 */
export const KOREAN_PRODUCER_STOP_WORDS: ReadonlySet<string> = new Set([
  '샤또', '샤토', '도멘', '돔', '테누타', '카사', '비냐', '보데가', '바인구트', '메종',
]);

export function isKoreanProducerStopWord(token: string): boolean {
  return KOREAN_PRODUCER_STOP_WORDS.has(token.normalize('NFC'));
}
