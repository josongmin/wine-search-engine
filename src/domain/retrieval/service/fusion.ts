import { createCanonicalEntityId } from '../../shared/types/index.js';
import { rrfFuse, RRF_DEFAULT_K } from '../../shared/utils/rrf.js';
import type {
  SparseHit,
  DenseHit,
  RetrievalHitSummary,
  RetrievalSummaryCarrier,
} from '../port/search-index.port.js';
import type { HybridCandidate } from '../model/hybrid-candidate.js';
import type { RetrievalTrace } from '../model/retrieval-trace.js';
import {
  mergeRetrievalHitSummaries,
  normalizeRetrievalHitSummary,
  summaryToHybridCandidateFields,
} from './hybrid-candidate-summary.js';

/**
 * Build a Map<entityId, normalized summary> from a hit list in a single pass.
 *
 * Avoids the quadratic scan pattern of calling
 * `findRetrievalHitSummaryForEntity` once per entity per list — for the fusion
 * path we iterate each list exactly once upfront and look up O(1) per entity.
 */
function buildSummaryMap(
  hits: readonly RetrievalSummaryCarrier[],
): ReadonlyMap<string, RetrievalHitSummary | undefined> {
  const map = new Map<string, RetrievalHitSummary | undefined>();
  for (const hit of hits) {
    if (!map.has(hit.entityId)) {
      map.set(hit.entityId, normalizeRetrievalHitSummary(hit.summary));
    }
  }
  return map;
}

// Rule 30 SSoT: RRF_DEFAULT_K is defined once in rrf.ts. Use it directly — no local alias.

/**
 * Fuses results from sparse, dense, and anchor retrieval passes using
 * Reciprocal Rank Fusion (RRF).
 *
 * The resulting {@link HybridCandidate.fusionRrfTotal} is a
 * retrieval-stage ranking signal — it is **never** a calibrated
 * decision confidence.
 */
export class FusionService {
  /**
   * Fuse multiple retrieval result lists into a single ranked candidate list.
   *
   * Deduplicates by entityId and returns candidates sorted by
   * descending fusionRrfTotal.
   *
   * @param sparseHits - Results from the BM25 / lexical pass.
   * @param denseHits - Results from the dense / embedding pass.
   * @param anchorHits - Optional results from the anchor neighbourhood pass.
   * @param k - RRF smoothing constant (default 60).
   * @returns Fused candidates sorted by descending fusionRrfTotal.
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
    const effectiveK = k ?? RRF_DEFAULT_K;

    // Build rank maps for RRF.
    // Dedup by entityId using best (lowest) rank — if the same entity appears at
    // two positions in the same hit list (e.g. Vespa dedup misconfigured), take
    // the better rank so the RRF contribution is correct. Last-write-wins semantics
    // would otherwise produce an arbitrary, non-best rank for the entity.
    const sparseRankMap = new Map<string, number>();
    const sparseScoreMap = new Map<string, number>();
    for (const hit of sparseHits) {
      const existing = sparseRankMap.get(hit.entityId);
      if (existing === undefined || hit.rank < existing) {
        sparseRankMap.set(hit.entityId, hit.rank);
        sparseScoreMap.set(hit.entityId, hit.score);
      }
    }

    const denseRankMap = new Map<string, number>();
    const denseScoreMap = new Map<string, number>();
    for (const hit of denseHits) {
      const existing = denseRankMap.get(hit.entityId);
      if (existing === undefined || hit.rank < existing) {
        denseRankMap.set(hit.entityId, hit.rank);
        denseScoreMap.set(hit.entityId, hit.score);
      }
    }

    const learnedSparseRankMap = new Map<string, number>();
    const learnedSparseScoreMap = new Map<string, number>();
    for (const hit of learnedSparseHits) {
      const existing = learnedSparseRankMap.get(hit.entityId);
      if (existing === undefined || hit.rank < existing) {
        learnedSparseRankMap.set(hit.entityId, hit.rank);
        learnedSparseScoreMap.set(hit.entityId, hit.score);
      }
    }

    const anchorRankMap = new Map<string, number>();
    const anchorScoreMap = new Map<string, number>();
    if (anchorHits) {
      for (const hit of anchorHits) {
        const existing = anchorRankMap.get(hit.entityId);
        if (existing === undefined || hit.rank < existing) {
          anchorRankMap.set(hit.entityId, hit.rank);
          anchorScoreMap.set(hit.entityId, hit.score);
        }
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

    // Pre-index per-list summaries by entityId so merging is O(1) per
    // candidate instead of a full scan over every hit list per entity.
    const sparseSummaries = buildSummaryMap(sparseHits);
    const denseSummaries = buildSummaryMap(denseHits);
    const learnedSparseSummaries = buildSummaryMap(learnedSparseHits);
    const anchorSummaries = anchorHits ? buildSummaryMap(anchorHits) : undefined;

    // Build candidates
    const candidates: HybridCandidate[] = [];

    for (const entityId of allEntityIds) {
      const fusionScore = fusedScores.get(entityId) ?? 0;
      const sparseRank = sparseRankMap.get(entityId);
      const sparseRawScore = sparseScoreMap.get(entityId);
      const denseRank = denseRankMap.get(entityId);
      const denseRawScore = denseScoreMap.get(entityId);
      const learnedSparseRank = learnedSparseRankMap.get(entityId);
      const learnedSparseRawScore = learnedSparseScoreMap.get(entityId);
      const anchorRank = anchorRankMap.get(entityId);
      const anchorRawScore = anchorScoreMap.get(entityId);

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

      const merged = mergeRetrievalHitSummaries(
        sparseSummaries.get(entityId),
        denseSummaries.get(entityId),
        learnedSparseSummaries.get(entityId),
        anchorSummaries?.get(entityId),
      );

      candidates.push({
        entityId: createCanonicalEntityId(entityId),
        sparseRank,
        ...(sparseRawScore !== undefined ? { sparseRawScore } : {}),
        denseRank,
        ...(denseRawScore !== undefined ? { denseRawScore } : {}),
        learnedSparseRank,
        ...(learnedSparseRawScore !== undefined ? { learnedSparseRawScore } : {}),
        anchorRank,
        ...(anchorRawScore !== undefined ? { anchorRawScore } : {}),
        fusionRrfTotal: fusionScore,
        identityExactnessTier: 'none',
        matchedConstraints: [],
        retrievalTrace: trace,
        ...summaryToHybridCandidateFields(merged),
      });
    }

    // Sort descending by fusionRrfTotal (canonical RRF score); break ties by
    // entityId (lexicographic ascending) for deterministic output ordering.
    // NaN guard: treat non-finite scores as 0 so the comparator always returns a
    // well-defined numeric value and the sort remains deterministic.
    // Perf: entityId is a branded string (see shared/types/entity-id.ts), so a
    // direct `<`/`>` comparison produces the same lexicographic order as
    // localeCompare for ASCII IDs without the allocation of `String(...)`
    // wrappers or the heavy Intl collator path.
    candidates.sort((a, b) => {
      // NaN/Infinity guard: use -Infinity (not 0) so non-finite scores always
      // sort LAST rather than interleaving with valid 0-score candidates.
      // evidence-accumulator.ts uses the same -Infinity sentinel — keep them
      // in sync (Rule 30: SSoT for cross-module sort behaviour).
      const aScore = Number.isFinite(a.fusionRrfTotal) ? a.fusionRrfTotal! : -Infinity;
      const bScore = Number.isFinite(b.fusionRrfTotal) ? b.fusionRrfTotal! : -Infinity;
      // Guard: if BOTH scores are non-finite (-Infinity - (-Infinity) = NaN), the
      // subtraction produces NaN, which violates the sort comparator contract (must
      // return a consistent number). Fall through to entityId tie-break in that case.
      if (aScore !== bScore) return bScore - aScore;
      return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;
    });

    return candidates;
  }
}
