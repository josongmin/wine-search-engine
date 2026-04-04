import type { EntityId } from '../../shared/types/index.js';

/**
 * A candidate prepared for cross-encoder reranking.
 */
export interface RerankCandidate {
  /** Entity identifier for this candidate. */
  readonly entityId: EntityId;

  /** Textual representation of the candidate used as passage input to the cross-encoder. */
  readonly text: string;
}

/**
 * Result of cross-encoder reranking for a single candidate.
 */
export interface RerankResult {
  /** Entity identifier for this candidate. */
  readonly entityId: EntityId;

  /** Cross-encoder relevance score (model-specific scale). */
  readonly score: number;

  /** 1-based rank assigned by the reranker. */
  readonly rank: number;
}

/**
 * Pluggable cross-encoder reranker port (RFC-013 rule 6).
 *
 * The reranker is NOT a fixed model — infrastructure adapters can swap in
 * any cross-encoder implementation (e.g. ColBERT, MiniLM, BGE-reranker)
 * without changing domain logic.
 *
 * When no reranker adapter is provided, the ranking pipeline skips the
 * reranking step and uses the aggregated scores directly.
 */
export interface RerankerPort {
  /**
   * Reranks candidates using a cross-encoder model.
   *
   * @param query - The user query string.
   * @param candidates - Candidates to rerank, each with entity ID and text passage.
   * @param limit - Maximum number of results to return from the reranker.
   * @returns Reranked results sorted by cross-encoder score descending.
   */
  rerank(
    query: string,
    candidates: readonly RerankCandidate[],
    limit: number,
  ): Promise<readonly RerankResult[]>;
}
