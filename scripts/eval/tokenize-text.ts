/** Minimum token length to be considered a content-bearing keyword. */
export const MIN_TOKEN_LENGTH = 2;

/**
 * Split text into lowercased content tokens.
 * Uses Unicode property classes so Hangul and accented Latin text survive
 * tokenization; this is the shared SSOT for offline relevance fixtures.
 */
export function tokenize(text: string): readonly string[] {
  const lowered = text.normalize('NFKC').toLowerCase();
  const matches = lowered.match(/[\p{L}\p{N}]+/gu) ?? [];
  return matches.filter((token) => token.length >= MIN_TOKEN_LENGTH);
}
