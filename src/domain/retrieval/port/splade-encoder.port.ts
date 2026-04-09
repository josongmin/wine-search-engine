/**
 * Port (driven side) for SPLADE-style learned sparse query encoding.
 *
 * Implementations wrap a learned model (e.g.,
 * `naver/splade-cocondenser-ensembledistil`) that maps a natural-language
 * query to a sparse vector of (token, weight) pairs. The output is consumed
 * by {@link SearchIndexPort.searchLearnedSparse} to run a `dotProduct`
 * retrieval pass against the index's `learned_sparse_weights` tensor field.
 *
 * Learned sparse retrieval sits alongside BM25 (lexical) and dense ANN
 * (semantic) channels; it recovers high-precision term matches that dense
 * encoders smear over while also expanding beyond exact-term BM25 matches.
 */

export interface SpladeQueryWeights {
  readonly token: string;
  readonly weight: number;
}

export interface SpladeEncoderPort {
  /**
   * Encode a query string into a sparse vector of (token, weight) pairs.
   *
   * The encoder is a learned model (e.g.,
   * `naver/splade-cocondenser-ensembledistil`) that produces high-recall
   * sparse representations beyond raw BM25.
   *
   * Implementations MUST return an empty array for an empty or
   * whitespace-only query (no I/O, no model invocation).
   */
  encode(query: string): Promise<readonly SpladeQueryWeights[]>;

  /** Number of non-zero tokens the encoder typically produces (for capacity planning). */
  readonly typicalActiveTokens: number;

  /** Model identifier for cache key versioning. */
  readonly modelId: string;
}
