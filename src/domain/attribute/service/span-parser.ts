/**
 * RFC-019 Stage 1: Span-based Parsing
 *
 * Replaces the naive n-gram tokenizer with a span-based parser that:
 *   - Tokenizes with position preservation
 *   - Generates n-gram spans up to MAX_SPAN_TOKENS
 *   - Uses longest-match priority to resolve overlaps
 *   - Strips trailing punctuation from spans (comma, period, bracket)
 *   - Normalizes whitespace and NFKC
 *
 * Unlike the current `planner.parseConstraints()` n-gram loop, this parser
 * returns spans with character offsets, which enables:
 *   - Overlap resolution (longest span wins when two overlap)
 *   - Trace telemetry ("this span at chars 5-12 resolved to entity X")
 *   - Downstream ambiguity scoring
 *
 * The parser is intentionally lossless — it emits ALL candidate spans.
 * Overlap resolution happens AFTER entity resolution, because we can only
 * decide which span "wins" once we know what each one resolves to.
 */

/** Maximum span length in tokens (1-gram, 2-gram, 3-gram). */
const MAX_SPAN_TOKENS = 3;

/** Trailing punctuation to strip from span text (preserves apostrophes in names). */
const TRAILING_PUNCT_RE = /[,.;:?!)\]}\s]+$/u;
const LEADING_PUNCT_RE = /^[([{\s]+/u;

export interface Span {
  /** Lowercased + NFKC-normalized + punctuation-stripped span text. */
  readonly text: string;
  /** Character offset (inclusive) in the normalized query. */
  readonly startChar: number;
  /** Character offset (exclusive) in the normalized query. */
  readonly endChar: number;
  /** Number of tokens in this span (1 = unigram). */
  readonly tokenCount: number;
}

/**
 * Parse a normalized query string into all candidate spans.
 *
 * Returns spans in arbitrary order. Duplicates (same text) are NOT deduplicated
 * here — callers can dedup after resolving to entities (longer span wins).
 */
export function parseSpans(normalizedQuery: string): readonly Span[] {
  const query = normalizedQuery.normalize('NFKC');
  if (query.trim().length === 0) return [];

  // Tokenize with position tracking: whitespace-delimited, preserve char offsets.
  const tokens: { text: string; start: number; end: number }[] = [];
  let pos = 0;
  while (pos < query.length) {
    // Skip whitespace
    while (pos < query.length && /\s/u.test(query[pos]!)) pos++;
    if (pos >= query.length) break;
    const start = pos;
    // Advance until next whitespace
    while (pos < query.length && !/\s/u.test(query[pos]!)) pos++;
    tokens.push({ text: query.slice(start, pos), start, end: pos });
  }

  if (tokens.length === 0) return [];

  const spans: Span[] = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j <= Math.min(i + MAX_SPAN_TOKENS, tokens.length); j++) {
      const slice = tokens.slice(i, j);
      if (slice.length === 0) continue;
      const first = slice[0]!;
      const last = slice[slice.length - 1]!;
      const rawText = query.slice(first.start, last.end);
      const stripped = stripPunctuation(rawText).toLowerCase();
      if (stripped.length === 0) continue;
      spans.push({
        text: stripped,
        startChar: first.start,
        endChar: last.end,
        tokenCount: slice.length,
      });
    }
  }
  return spans;
}

/**
 * Resolve span overlaps using longest-match priority.
 *
 * Given a set of (span, resolution) pairs where some spans overlap in
 * character ranges, keep only non-overlapping spans preferring:
 *   1. Longer spans first (more tokens)
 *   2. Ties broken by earlier start position
 *
 * Unresolved spans (no entity binding) are dropped when they overlap with
 * a resolved one. Unresolved, non-overlapping spans are kept so the caller
 * can fall through to LLM/fallback for them.
 */
export function resolveOverlaps<T>(
  annotated: readonly { span: Span; resolved: T | null }[],
): readonly { span: Span; resolved: T | null }[] {
  // Sort by: resolved first (longer first, earlier first, then span text), then unresolved.
  // The text tie-breaker is required for determinism when two spans share the same resolved
  // status, tokenCount, and startChar (e.g. different endChar after punctuation stripping).
  const sorted = [...annotated].sort((a, b) => {
    const aResolved = a.resolved !== null;
    const bResolved = b.resolved !== null;
    if (aResolved !== bResolved) return aResolved ? -1 : 1;
    if (a.span.tokenCount !== b.span.tokenCount) return b.span.tokenCount - a.span.tokenCount;
    if (a.span.startChar !== b.span.startChar) return a.span.startChar - b.span.startChar;
    // Prefer longer span (larger endChar) when start and tokenCount are equal
    if (a.span.endChar !== b.span.endChar) return b.span.endChar - a.span.endChar;
    // Final deterministic tie-breaker: lexicographic on span text
    return a.span.text < b.span.text ? -1 : a.span.text > b.span.text ? 1 : 0;
  });

  const claimed: { start: number; end: number }[] = [];
  const kept: { span: Span; resolved: T | null }[] = [];

  for (const entry of sorted) {
    const { startChar, endChar } = entry.span;
    const conflicts = claimed.some(
      (c) => !(endChar <= c.start || startChar >= c.end),
    );
    if (conflicts) continue;
    claimed.push({ start: startChar, end: endChar });
    kept.push(entry);
  }

  // Sort output by original startChar for stable trace output
  return kept.sort((a, b) => a.span.startChar - b.span.startChar);
}

function stripPunctuation(text: string): string {
  return text.replace(TRAILING_PUNCT_RE, '').replace(LEADING_PUNCT_RE, '');
}
