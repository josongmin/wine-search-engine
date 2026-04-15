/**
 * Stopword blacklist for Doc2Query synthetic query post-filtering.
 *
 * Purpose: prevent IDF dilution. If every wine document receives a
 * query like "레드 와인 추천" or "wine recommendation", that query's
 * tokens become worthless for BM25 ranking. We drop any synthetic query
 * whose content-bearing tokens are entirely in the stopword set.
 *
 * Design:
 *   - Content-bearing = tokens ≥ 2 chars after unicode-aware tokenization.
 *   - A query is "stopword-only" when every content-bearing token is in
 *     the blacklist. Mixed queries like "wine for steak" keep the
 *     discriminating token ("steak") and pass.
 *   - Tokenization matches the Vespa BM25 expectation loosely — lowercase,
 *     split on non-letter/non-digit (Unicode-aware).
 */

/**
 * Tokens that carry no useful BM25 signal on their own. Include both
 * English and Korean variants that the LLM tends to overuse.
 */
const STOPWORD_SET: ReadonlySet<string> = new Set<string>([
  // English generic
  'wine',
  'wines',
  'red',
  'white',
  'good',
  'best',
  'great',
  'nice',
  'top',
  'recommendation',
  'recommend',
  'recommended',
  'similar',
  'alternative',
  'premium',
  'luxury',
  'quality',
  'fine',
  'popular',
  'classic',
  'favorite',
  'the',
  'a',
  'an',
  'for',
  'and',
  'or',
  'to',
  // Korean generic
  '와인',
  '레드',
  '화이트',
  '추천',
  '추천해줘',
  '추천해',
  '좋은',
  '유명한',
  '인기',
  '프리미엄',
  '고급',
  '최고',
  '베스트',
  '대표',
  '보통',
  '괜찮은',
]);

const TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;

/** Minimum token length treated as content-bearing. */
const CONTENT_TOKEN_MIN_LEN = 2;

/**
 * Tokenize a query into lowercased, content-bearing tokens.
 * Short filler tokens (< 2 chars) are dropped up front.
 */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(TOKEN_SPLIT)
    .filter((t) => t.length >= CONTENT_TOKEN_MIN_LEN);
}

/**
 * Returns true when the query provides no BM25 signal — either empty
 * after tokenization, or every content-bearing token is a stopword.
 */
function isStopwordOnly(query: string): boolean {
  const tokens = tokenize(query);
  if (tokens.length === 0) return true;
  return tokens.every((t) => STOPWORD_SET.has(t));
}

/**
 * Filter out stopword-only queries while preserving order and
 * de-duplicating by lowercased-trimmed form.
 */
export function filterStopwordOnly(
  queries: readonly string[],
): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of queries) {
    const trimmed = q.trim();
    if (trimmed.length === 0) continue;
    if (isStopwordOnly(trimmed)) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
