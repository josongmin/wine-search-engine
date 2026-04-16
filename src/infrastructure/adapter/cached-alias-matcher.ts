import type {
  AliasMatchResult,
  AliasMatcher,
} from '../../domain/query/service/anchor-extractor.js';

interface CachedAliasMatcherOptions {
  readonly maxEntries?: number | undefined;
}

/** Deterministic alias-result memoizer with LRU eviction and single-flight dedupe. */
export class CachedAliasMatcher implements AliasMatcher {
  private static readonly DEFAULT_MAX_ENTRIES = 25_000;

  private readonly cache = new Map<string, readonly AliasMatchResult[]>();
  private readonly inFlight = new Map<string, Promise<readonly AliasMatchResult[]>>();
  private readonly maxEntries: number;

  constructor(
    private readonly inner: AliasMatcher,
    options: CachedAliasMatcherOptions = {},
  ) {
    this.maxEntries = Number.isFinite(options.maxEntries ?? CachedAliasMatcher.DEFAULT_MAX_ENTRIES)
      ? Math.max(1, options.maxEntries ?? CachedAliasMatcher.DEFAULT_MAX_ENTRIES)
      : CachedAliasMatcher.DEFAULT_MAX_ENTRIES;
  }

  async findMatches(normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
    const trimmed = normalizedQuery.trim();
    if (trimmed.length === 0) {
      return [];
    }

    const cached = this.cache.get(trimmed);
    if (cached !== undefined) {
      this.touch(trimmed);
      return cached;
    }

    const existingInFlight = this.inFlight.get(trimmed);
    if (existingInFlight !== undefined) {
      return existingInFlight;
    }

    const promise = this.inner.findMatches(trimmed)
      .then((matches) => {
        this.set(trimmed, matches);
        return matches;
      })
      .finally(() => {
        this.inFlight.delete(trimmed);
      });
    this.inFlight.set(trimmed, promise);
    return promise;
  }

  async findMatchesBatch(
    normalizedQueries: readonly string[],
  ): Promise<ReadonlyMap<string, readonly AliasMatchResult[]>> {
    const trimmedQueries = this.trimDedupedQueries(normalizedQueries);
    if (trimmedQueries.length === 0) {
      return new Map();
    }

    const hits = new Map<string, Promise<readonly AliasMatchResult[]>>();
    const misses: string[] = [];
    for (const query of trimmedQueries) {
      const cached = this.cache.get(query);
      if (cached !== undefined) {
        this.touch(query);
        hits.set(query, Promise.resolve(cached));
        continue;
      }

      const existingInFlight = this.inFlight.get(query);
      if (existingInFlight !== undefined) {
        hits.set(query, existingInFlight);
        continue;
      }

      misses.push(query);
    }

    if (misses.length > 0) {
      const batchLookup = (async () => {
        if (this.inner.findMatchesBatch !== undefined) {
          const raw = await this.inner.findMatchesBatch(misses);
          for (const query of misses) {
            const matches = raw.get(query) ?? [];
            this.set(query, matches);
          }
          return raw;
        }

        const perQuery = await Promise.all(misses.map((query) => this.inner.findMatches(query)));
        const resolved = new Map<string, readonly AliasMatchResult[]>();
        misses.forEach((query, index) => {
          const matches = perQuery[index] ?? [];
          resolved.set(query, matches);
          this.set(query, matches);
        });
        return resolved;
      })();

      for (const query of misses) {
        const inFlight = batchLookup
          .then((resolved) => resolved.get(query) ?? [])
          .finally(() => {
            this.inFlight.delete(query);
          });
        this.inFlight.set(query, inFlight);
        hits.set(query, inFlight);
      }
    }

    const allEntries = new Map<string, readonly AliasMatchResult[]>();
    for (const [query, promise] of hits) {
      const matches = await promise;
      allEntries.set(query, matches);
    }

    // Fill misses that were cached by the batch path and were not in `hits`
    // because the query had zero-length cache and was skipped by dedupe.
    for (const query of trimmedQueries) {
      const cached = this.cache.get(query);
      if (cached !== undefined) {
        allEntries.set(query, cached);
      }
    }

    return allEntries;
  }

  private set(query: string, matches: readonly AliasMatchResult[]): void {
    this.cache.delete(query);
    this.cache.set(query, matches);
    if (this.cache.size > this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
  }

  private touch(query: string): void {
    const cached = this.cache.get(query);
    if (cached === undefined) {
      return;
    }
    this.cache.delete(query);
    this.cache.set(query, cached);
  }

  private trimDedupedQueries(queries: readonly string[]): readonly string[] {
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const query of queries) {
      const trimmed = query.trim();
      if (trimmed.length === 0 || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      ordered.push(trimmed);
    }
    return ordered;
  }
}
