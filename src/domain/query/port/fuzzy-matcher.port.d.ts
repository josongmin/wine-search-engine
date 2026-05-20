/**
 * Port for fuzzy matching against a pre-built term index.
 *
 * Consumers depend on this interface rather than the concrete FuzzyMatcher,
 * allowing stub/mock implementations in tests and alternative backends.
 */
export interface FuzzyMatcherPort {
    match(query: string, maxEditDistance?: number): readonly {
        term: string;
        editDistance: number;
        combinedScore: number;
    }[];
}
//# sourceMappingURL=fuzzy-matcher.port.d.ts.map