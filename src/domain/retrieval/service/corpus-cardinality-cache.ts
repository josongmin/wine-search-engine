/**
 * Corpus cardinality cache — per-wine-type entity counts from the search index.
 *
 * Populated once at container init (or on-demand with TTL).
 * Used by agent-tools to distinguish "corpus exhausted" (small type, retry is
 * futile) from "query too specific" (large type, retry may help).
 */

/**
 * Minimum corpus size below which retry is considered futile.
 * Derived from empirical observation: wine types with fewer than ~200 indexed
 * entities rarely benefit from constraint relaxation — the entire type is small
 * enough that 0-result means "nothing matching exists", not "query too narrow".
 */
export const CORPUS_LIMITED_THRESHOLD = 200;

export interface CorpusCardinalityCache {
  /** Get entity count for a wine type. Returns undefined if type unknown. */
  getTypeCount(wineType: string): number | undefined;
  /** Total entities across all types. */
  getTotalCount(): number;
  /** Check if a wine type's corpus is below the retry-futility threshold. */
  isCorpusLimited(wineType: string | undefined): boolean;
}

export class InMemoryCorpusCardinalityCache implements CorpusCardinalityCache {
  private readonly counts: ReadonlyMap<string, number>;
  private readonly total: number;

  constructor(counts: ReadonlyMap<string, number>) {
    this.counts = counts;
    let sum = 0;
    for (const c of counts.values()) sum += c;
    this.total = sum;
  }

  getTypeCount(wineType: string): number | undefined {
    return this.counts.get(wineType);
  }

  getTotalCount(): number {
    return this.total;
  }

  isCorpusLimited(wineType: string | undefined): boolean {
    if (wineType === undefined) return this.total < CORPUS_LIMITED_THRESHOLD;
    const count = this.counts.get(wineType);
    // Unknown type → fall back to total corpus check (conservative: empty cache
    // treats everything as limited to prevent futile retries before data loads).
    if (count === undefined) return this.total < CORPUS_LIMITED_THRESHOLD;
    return count < CORPUS_LIMITED_THRESHOLD;
  }

  static empty(): InMemoryCorpusCardinalityCache {
    return new InMemoryCorpusCardinalityCache(new Map());
  }
}
