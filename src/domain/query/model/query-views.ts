/**
 * Multi-view normalization output for noisy entity lookup.
 *
 * Each field is intentionally preserved because downstream debugging often
 * needs to know which normalized view was responsible for an anchor match.
 *
 * Views are ordered from conservative to aggressive normalization:
 *   strict → accentless → compact → vintageCanonicalized → vintageStripped
 *   → transliterated → phoneticNormalized → phoneticCompact
 */
export interface NormalizedQueryViews {
  /** Original, unmodified. */
  readonly raw: string;
  /** Unicode NFC, lowercased, whitespace-collapsed. */
  readonly strict: string;
  /** strict with accents stripped. */
  readonly accentless: string;
  /** accentless with whitespace collapsed (alias kept for downstream compat). */
  readonly collapsedWhitespace: string;
  /** accentless with punctuation replaced by spaces, whitespace collapsed. */
  readonly punctuationStripped: string;
  /** accentless with all non-alphanumeric removed. */
  readonly compact: string;
  /** Phonetic normalization (sch→ch, eaux→o, etc.) applied to accentless — without vowel removal. */
  readonly phoneticNormalized?: string | undefined;
  /** Phonetic with vowels removed — aggressive noisy match. */
  readonly phoneticCompact?: string | undefined;
  /** Vintage tokens canonicalized (2-digit → 4-digit years). */
  readonly vintageCanonicalized: string;
  /** Vintage tokens stripped. */
  readonly vintageStripped: string;
  /** Korean/CJK transliterated to Latin. */
  readonly transliterated?: string | undefined;
  /** All token orderings tried (for multi-word queries). */
  readonly reordered?: readonly string[] | undefined;
  /**
   * Deduplicated flat list of all non-empty view values.
   * Used for staged entity lookup: try each in order from conservative to aggressive.
   */
  readonly lookupVariants: readonly string[];
}
