import { createEntityId } from '../../shared/types/index.js';
import { rrfFuse } from '../../shared/utils/rrf.js';
import type { SparseHit, DenseHit } from '../port/search-index.port.js';
import type { HybridCandidate } from '../model/hybrid-candidate.js';
import type { RetrievalTrace } from '../model/retrieval-trace.js';
import {
  mergeRetrievalHitSummariesForEntity,
  summaryToHybridCandidateFields,
} from './hybrid-candidate-summary.js';

/** Standard RRF smoothing constant (rank + k in denominator). */
const RECIPROCAL_RANK_FUSION_DEFAULT_K = 60;

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
    learnedSparseHits: readonly DenseHit[] = [],
  ): readonly HybridCandidate[] {
    // Guard against k=0 or negative k: the `??` operator passes through
    // explicit 0 (only catches null/undefined), so we need an explicit check.
    // k must be ≥ 1 — k=0 makes rank-1 scores equal to 1.0 (fine), but
    // k<0 produces negative scores for high ranks, corrupting the fusion.
    // The standard RRF value is 60; callers should never pass k<1.
    if (k !== undefined && k < 1) {
      throw new Error(`FusionService.fuse: k must be ≥ 1, got ${k}`);
    }
    const effectiveK = k ?? RECIPROCAL_RANK_FUSION_DEFAULT_K;

    // Build rank maps for RRF
    const sparseRankMap = new Map<string, number>();
    for (const hit of sparseHits) {
      sparseRankMap.set(hit.entityId, hit.rank);
    }

    const denseRankMap = new Map<string, number>();
    for (const hit of denseHits) {
      denseRankMap.set(hit.entityId, hit.rank);
    }

    const learnedSparseRankMap = new Map<string, number>();
    for (const hit of learnedSparseHits) {
      learnedSparseRankMap.set(hit.entityId, hit.rank);
    }

    const anchorRankMap = new Map<string, number>();
    if (anchorHits) {
      for (const hit of anchorHits) {
        anchorRankMap.set(hit.entityId, hit.rank);
      }
    }

    // Build rankings array for RRF — only include non-empty rankings.
    // CRITICAL: BM25 (sparse) and learned-sparse (SPLADE) share lexical
    // priors. Treating them as two independent rankings double-counts
    // lexical signal and demotes pure-semantic recalls. Collapse them
    // into a single "lexical family" by taking the BEST (lowest) rank
    // for each entity across the two channels.
    const lexicalFamilyMap = new Map<string, number>();
    for (const [id, rank] of sparseRankMap) {
      lexicalFamilyMap.set(id, rank);
    }
    for (const [id, rank] of learnedSparseRankMap) {
      const existing = lexicalFamilyMap.get(id);
      if (existing === undefined || rank < existing) {
        lexicalFamilyMap.set(id, rank);
      }
    }

    const rankings: ReadonlyMap<string, number>[] = [];
    if (lexicalFamilyMap.size > 0) rankings.push(lexicalFamilyMap);
    if (denseRankMap.size > 0) rankings.push(denseRankMap);
    if (anchorHits && anchorRankMap.size > 0) rankings.push(anchorRankMap);

    const fusedScores = rrfFuse(rankings, effectiveK);

    // Collect all unique entity IDs
    const allEntityIds = new Set<string>();
    for (const hit of sparseHits) allEntityIds.add(hit.entityId);
    for (const hit of denseHits) allEntityIds.add(hit.entityId);
    for (const hit of learnedSparseHits) allEntityIds.add(hit.entityId);
    if (anchorHits) {
      for (const hit of anchorHits) allEntityIds.add(hit.entityId);
    }

    // Build candidates
    const candidates: HybridCandidate[] = [];

    for (const entityId of allEntityIds) {
      const fusionScore = fusedScores.get(entityId) ?? 0;
      const sparseRank = sparseRankMap.get(entityId);
      const denseRank = denseRankMap.get(entityId);
      const learnedSparseRank = learnedSparseRankMap.get(entityId);
      const anchorRank = anchorRankMap.get(entityId);

      const candidateSources: string[] = [];
      if (sparseRank !== undefined) candidateSources.push('sparse_bm25');
      if (denseRank !== undefined) candidateSources.push('dense_semantic');
      if (learnedSparseRank !== undefined) candidateSources.push('learned_sparse');
      if (anchorRank !== undefined) candidateSources.push('anchor_similarity');

      const trace: RetrievalTrace = {
        retrievalProfile: 'fusion',
        lexicalQueriesUsed: [],
        semanticQueriesUsed: [],
        filtersApplied: [],
        candidateSources,
      };

      const merged = mergeRetrievalHitSummariesForEntity(
        createEntityId(entityId),
        sparseHits,
        denseHits,
        learnedSparseHits,
        anchorHits ?? [],
      );

      candidates.push({
        entityId: createEntityId(entityId),
        sparseRank,
        denseRank,
        learnedSparseRank,
        anchorRank,
        retrievalFusionScore: fusionScore,
        matchedConstraints: [],
        retrievalTrace: trace,
        ...summaryToHybridCandidateFields(merged),
      });
    }

    // Sort descending by retrievalFusionScore; break ties by entityId (lexicographic ascending)
    // for deterministic output ordering.
    // NaN guard: treat non-finite scores as 0 so the comparator always returns a
    // well-defined numeric value and the sort remains deterministic.
    candidates.sort((a, b) => {
      const aScore = Number.isFinite(a.retrievalFusionScore) ? a.retrievalFusionScore : 0;
      const bScore = Number.isFinite(b.retrievalFusionScore) ? b.retrievalFusionScore : 0;
      const diff = bScore - aScore;
      if (diff !== 0) return diff;
      return String(a.entityId).localeCompare(String(b.entityId));
    });

    return candidates;
  }
}
