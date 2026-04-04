/**
 * Diagnostic trace attached to every {@link HybridCandidate} for
 * pipeline observability and debugging (RFC-012 S9.4).
 */
export interface RetrievalTrace {
  /** Name of the retrieval profile that governed this retrieval pass. */
  readonly retrievalProfile: string;

  /** Lexical query strings that were actually executed against the sparse index. */
  readonly lexicalQueriesUsed: readonly string[];

  /** Semantic query strings that were embedded and used for dense retrieval. */
  readonly semanticQueriesUsed: readonly string[];

  /** Filter expressions applied to the search index. */
  readonly filtersApplied: readonly string[];

  /** Sources that contributed to this candidate (e.g. 'sparse', 'dense', 'anchor'). */
  readonly candidateSources: readonly string[];

  /** Phases that were skipped per the cascade router (S9.4 tracking). */
  readonly skippedPhases?: readonly string[] | undefined;
}
