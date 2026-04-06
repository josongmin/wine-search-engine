/**
 * Char n-gram index for approximate string matching.
 * Builds a trigram inverted index over alias terms for O(1) candidate lookup.
 * Handles collapsed whitespace, missing spaces, and partial matches.
 */

export interface CharNgramMatch {
  readonly term: string;
  readonly similarity: number;
  readonly sharedTrigrams: number;
}

export class CharNgramIndex {
  private readonly trigramIndex = new Map<string, Set<string>>();
  private readonly termSet = new Set<string>();

  /**
   * Builds the trigram inverted index from a set of known terms.
   * Must be called before {@link search}.
   */
  initialize(terms: readonly string[]): void {
    for (const term of terms) {
      const normalized = term.toLowerCase().replace(/\s+/g, '');
      this.termSet.add(normalized);
      const trigrams = this.extractTrigrams(normalized);
      for (const tri of trigrams) {
        let bucket = this.trigramIndex.get(tri);
        if (!bucket) {
          bucket = new Set();
          this.trigramIndex.set(tri, bucket);
        }
        bucket.add(term); // Store original term for display
      }
    }
  }

  /**
   * Find candidate terms that share enough trigrams with the query.
   * Returns candidates sorted by Jaccard similarity of trigram sets.
   *
   * @param query - The user's search term.
   * @param minSimilarity - Minimum Jaccard similarity threshold (default 0.3).
   * @returns Candidates sorted by similarity descending.
   */
  search(query: string, minSimilarity: number = 0.3): readonly CharNgramMatch[] {
    const normalized = query.toLowerCase().replace(/\s+/g, '');
    if (normalized.length < 3) return [];

    const queryTrigrams = this.extractTrigrams(normalized);
    const candidateCounts = new Map<string, number>();

    for (const tri of queryTrigrams) {
      const bucket = this.trigramIndex.get(tri);
      if (bucket) {
        for (const term of bucket) {
          candidateCounts.set(term, (candidateCounts.get(term) ?? 0) + 1);
        }
      }
    }

    const results: CharNgramMatch[] = [];
    for (const [term, sharedCount] of candidateCounts) {
      const termNormalized = term.toLowerCase().replace(/\s+/g, '');
      const termTrigrams = this.extractTrigrams(termNormalized);
      const unionSize = queryTrigrams.length + termTrigrams.length - sharedCount;
      const similarity = unionSize > 0 ? sharedCount / unionSize : 0;
      if (similarity >= minSimilarity) {
        results.push({ term, similarity, sharedTrigrams: sharedCount });
      }
    }

    return results.sort((a, b) => b.similarity - a.similarity);
  }

  /**
   * Extracts character trigrams from a string.
   * For strings shorter than 3 characters, returns the string itself as a single "trigram".
   */
  private extractTrigrams(s: string): string[] {
    if (s.length < 3) return [s];
    const trigrams: string[] = [];
    for (let i = 0; i <= s.length - 3; i++) {
      trigrams.push(s.slice(i, i + 3));
    }
    return trigrams;
  }
}
