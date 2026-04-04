import type { EntityId } from '../../shared/types/index.js';
import { rrfFuse } from '../../shared/utils/rrf.js';
import type { SparseHit, DenseHit } from '../port/search-index.port.js';
import type { HybridCandidate } from '../model/hybrid-candidate.js';
import type { RetrievalTrace } from '../model/retrieval-trace.js';

/**
 * Fuses results from sparse, dense, and anchor retrieval passes using
 * Reciprocal Rank Fusion (RRF).
 *
 * The resulting {@link HybridCandidate.retrievalFusionScore} is a
 * retrieval-stage ranking signal — it is **never** a calibrated
 * decision confidence.
 */
export class FusionService {
  /**
   * Fuse multiple retrieval result lists into a single ranked candidate list.
   *
   * Deduplicates by entityId and returns candidates sorted by
   * descending retrievalFusionScore.
   *
   * @param sparseHits - Results from the BM25 / lexical pass.
   * @param denseHits - Results from the dense / embedding pass.
   * @param anchorHits - Optional results from the anchor neighbourhood pass.
   * @param k - RRF smoothing constant (default 60).
   * @returns Fused candidates sorted by descending retrievalFusionScore.
   */
  fuse(
    sparseHits: readonly SparseHit[],
    denseHits: readonly DenseHit[],
    anchorHits?: readonly DenseHit[],
    k?: number,
  ): readonly HybridCandidate[] {
    const effectiveK = k ?? 60;

    // Build rank maps for RRF
    const sparseRankMap = new Map<string, number>();
    for (const hit of sparseHits) {
      sparseRankMap.set(hit.entityId, hit.rank);
    }

    const denseRankMap = new Map<string, number>();
    for (const hit of denseHits) {
      denseRankMap.set(hit.entityId, hit.rank);
    }

    const anchorRankMap = new Map<string, number>();
    if (anchorHits) {
      for (const hit of anchorHits) {
        anchorRankMap.set(hit.entityId, hit.rank);
      }
    }

    // Build rankings array for RRF
    const rankings: ReadonlyArray<ReadonlyMap<string, number>> = anchorHits
      ? [sparseRankMap, denseRankMap, anchorRankMap]
      : [sparseRankMap, denseRankMap];

    const fusedScores = rrfFuse(rankings, effectiveK);

    // Collect all unique entity IDs
    const allEntityIds = new Set<string>();
    for (const hit of sparseHits) allEntityIds.add(hit.entityId);
    for (const hit of denseHits) allEntityIds.add(hit.entityId);
    if (anchorHits) {
      for (const hit of anchorHits) allEntityIds.add(hit.entityId);
    }

    // Build candidates
    const candidates: HybridCandidate[] = [];

    for (const entityId of allEntityIds) {
      const fusionScore = fusedScores.get(entityId) ?? 0;
      const sparseRank = sparseRankMap.get(entityId);
      const denseRank = denseRankMap.get(entityId);
      const anchorRank = anchorRankMap.get(entityId);

      const candidateSources: string[] = [];
      if (sparseRank !== undefined) candidateSources.push('sparse');
      if (denseRank !== undefined) candidateSources.push('dense');
      if (anchorRank !== undefined) candidateSources.push('anchor');

      const trace: RetrievalTrace = {
        retrievalProfile: 'fusion',
        lexicalQueriesUsed: [],
        semanticQueriesUsed: [],
        filtersApplied: [],
        candidateSources,
      };

      candidates.push({
        entityId: entityId as EntityId,
        sparseRank,
        denseRank,
        anchorRank,
        retrievalFusionScore: fusionScore,
        matchedConstraints: [],
        retrievalTrace: trace,
      });
    }

    // Sort descending by retrievalFusionScore
    candidates.sort((a, b) => b.retrievalFusionScore - a.retrievalFusionScore);

    return candidates;
  }
}
