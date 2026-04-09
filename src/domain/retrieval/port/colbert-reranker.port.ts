/**
 * Port (driven side) for ColBERT late-interaction reranking.
 *
 * Late interaction scores every query token against every candidate
 * document token (contextualized BERT embeddings) and aggregates via
 * MaxSim. This is substantially more expensive than a dense bi-encoder
 * (which collapses the document to a single vector before the dot
 * product) but captures finer-grained term alignment and produces
 * higher-quality top-K rankings.
 *
 * Reference: Khattab & Zaharia 2020
 * "ColBERT: Efficient and Effective Passage Search via Contextualized
 * Late Interaction over BERT" (SIGIR 2020).
 */

export interface ColbertScoredCandidate {
  readonly entityId: string;
  readonly colbertScore: number;
}

export interface ColbertRerankerPort {
  /**
   * Late-interaction reranking: token-level similarity between query and
   * candidate documents. More expensive than dense bi-encoder but produces
   * higher-quality rankings via MaxSim aggregation.
   *
   * Implementations MUST return an empty array if `candidateIds` is empty
   * or `topK <= 0` (no I/O, no model invocation). The returned list is
   * sorted by descending `colbertScore` and capped at `topK`.
   *
   * Reference: Khattab & Zaharia 2020
   * "ColBERT: Efficient and Effective Passage Search via Contextualized
   * Late Interaction over BERT".
   */
  rerank(
    query: string,
    candidateIds: readonly string[],
    topK: number,
  ): Promise<readonly ColbertScoredCandidate[]>;

  readonly modelId: string;
}
