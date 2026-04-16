/**
 * Noise stripping utilities for the ingestion pipeline (RFC-002 §5.3).
 *
 * Removes promotional text, marketplace noise, and irrelevant tokens
 * from wine titles and descriptions before canonicalization.
 */

/** Tokens considered noise in wine product titles (case-insensitive). */
const NOISE_TOKENS: readonly string[] = [
  'gift box',
  'gift set',
  'import',
  'imported',
  'sale',
  'best',
  'premium',
  '750ml',
  '750 ml',
  'set',
  'bundle',
  '선물세트',
  '프리미엄',
  '행사',
  '특가',
  '수입',
] as const;

/** Patterns that indicate promotional or marketing text. */
const PROMOTIONAL_PATTERNS: readonly RegExp[] = [
  // Unicode-aware boundaries replace \b (ASCII-only, silently fails on Korean/accented Latin).
  /\d+%\s*(?:off|할인|세일)/iu,
  /(?:free\s+shipping|무료\s*배송)/iu,
  /(?<![\p{L}\p{N}])(?:limited\s+(?:time|edition|offer))(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])(?:best\s+seller)(?![\p{L}\p{N}])|(?:^|\s)베스트(?:\s|$)/iu,
  /(?<![\p{L}\p{N}])(?:hot\s+deal)(?![\p{L}\p{N}])|(?:^|\s)(?:특가|행사)(?:\s|$)/iu,
  /(?<![\p{L}\p{N}])(?:buy\s+\d+\s+get)(?![\p{L}\p{N}])/iu,
  /[!]{2,}/,
  /★+/u,
  /(?:^|\s)(?:추천|인기)(?:\s|$)/u,
];

/**
 * Result of stripping noise tokens from a title.
 */
interface NoiseStripResult {
  /** The cleaned title with noise tokens removed. */
  readonly cleaned: string;
  /** List of noise tokens that were found and removed. */
  readonly noiseFlags: readonly string[];
}

/**
 * Strips known noise tokens from a wine title.
 *
 * Matching is case-insensitive. Multi-word tokens are matched as phrases.
 * The function preserves the original casing of non-noise parts.
 *
 * @param title - The raw or partially normalized title.
 * @returns The cleaned title and an array of noise tokens that were stripped.
 */
export function stripNoiseTokens(title: string): NoiseStripResult {
  const detectedFlags: string[] = [];
  let cleaned = title;

  // Sort tokens by length descending so multi-word tokens match before sub-tokens
  const sortedTokens = [...NOISE_TOKENS].sort((a, b) => b.length - a.length);

  for (const token of sortedTokens) {
    const escaped = escapeRegExp(token);
    // \b doesn't work with Korean/CJK characters (non-ASCII are non-word chars).
    // Use whitespace / string boundary anchors for universal matching.
    const pattern = new RegExp(`(?:^|(?<=\\s))${escaped}(?=\\s|$)`, 'gi');

    if (pattern.test(cleaned)) {
      detectedFlags.push(token);
      cleaned = cleaned.replace(pattern, ' ');
    }
  }

  // Collapse resulting multiple spaces and trim
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // If stripping removed everything, keep the original to prevent empty titles
  if (cleaned.length === 0) {
    return { cleaned: title.replace(/\s+/g, ' ').trim(), noiseFlags: detectedFlags };
  }

  return { cleaned, noiseFlags: detectedFlags };
}

/**
 * Detects whether a text string contains promotional or marketing language.
 *
 * @param text - The text to check.
 * @returns `true` if the text contains promotional patterns.
 */
export function isPromotionalText(text: string): boolean {
  return PROMOTIONAL_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Escapes special regex characters in a string for use in a RegExp constructor.
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
