import type { SparseHit } from '../port/search-index.port.js';
import type { HybridCandidate } from '../model/hybrid-candidate.js';
import type { RetrievalTrace } from '../model/retrieval-trace.js';
import { summaryToHybridCandidateFields } from './hybrid-candidate-summary.js';

/**
 * Shared sparse-hit → HybridCandidate mapping used by browse and compare
 * retrievers.
 *
 * Extracted from the near-identical copies that previously lived in
 * `browse-retriever.ts` and `compare-retriever.ts`. The only places the two
 * diverged were the retrieval profile label, the lexical query list, the
 * applied filter list, and the candidate source tags — all of which are
 * parameters here.
 */
export interface SparseHitToCandidateOptions {
  readonly retrievalProfile: string;
  readonly lexicalQueries: readonly string[];
  readonly filtersApplied: readonly string[];
  readonly candidateSources: readonly string[];
}

/**
 * Map a single sparse index hit onto a {@link HybridCandidate}.
 *
 * @param hit - Sparse index hit carrying the entity id and optional summary.
 * @param rank - 1-indexed sparse rank to record on the candidate.
 * @param options - Retrieval profile + trace context for the candidate.
 */
export function sparseHitToCandidate(
  hit: SparseHit,
  rank: number,
  options: SparseHitToCandidateOptions,
): HybridCandidate {
  const trace: RetrievalTrace = {
    retrievalProfile: options.retrievalProfile,
    lexicalQueriesUsed: options.lexicalQueries,
    semanticQueriesUsed: [],
    filtersApplied: [...options.filtersApplied],
    candidateSources: [...options.candidateSources],
  };
  return {
    entityId: hit.entityId,
    ...summaryToHybridCandidateFields(hit.summary),
    sparseRank: rank,
    retrievalFusionScore: hit.score,
    matchedConstraints: [],
    retrievalTrace: trace,
  };
}

/**
 * Convenience wrapper to map an ordered list of sparse hits onto candidates,
 * assigning ranks from 1..N in iteration order.
 */
export function sparseHitsToCandidates(
  hits: readonly SparseHit[],
  options: SparseHitToCandidateOptions,
): readonly HybridCandidate[] {
  return hits.map((hit, index) => sparseHitToCandidate(hit, index + 1, options));
}
