import type { FuzzyMatcherPort } from '../../domain/query/port/fuzzy-matcher.port.js';
import { FuzzyMatcher } from '../../domain/query/service/fuzzy-matcher.js';

export class LazyFuzzyMatcher implements FuzzyMatcherPort {
  private matcher: FuzzyMatcher | undefined;

  constructor(private readonly terms: readonly string[]) {}

  match(
    query: string,
    maxEditDistance?: number,
  ): readonly {
    term: string;
    editDistance: number;
    combinedScore: number;
  }[] {
    if (this.terms.length === 0) {
      return [];
    }

    if (this.matcher === undefined) {
      const matcher = new FuzzyMatcher();
      matcher.initialize(this.terms);
      this.matcher = matcher;
    }

    return this.matcher.match(query, maxEditDistance);
  }
}
