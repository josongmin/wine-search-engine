/**
 * Multi-view normalization output for noisy entity lookup.
 *
 * Each field is intentionally preserved because downstream debugging often
 * needs to know which normalized view was responsible for an anchor match.
 */
export interface NormalizedQueryViews {
  readonly raw: string;
  readonly strict: string;
  readonly accentless: string;
  readonly collapsedWhitespace: string;
  readonly punctuationStripped: string;
  readonly compact: string;
  readonly phoneticCompact?: string | undefined;
  readonly vintageCanonicalized: string;
  readonly vintageStripped: string;
  readonly transliterated?: string | undefined;
  readonly lookupVariants: readonly string[];
}
