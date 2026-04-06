import type { EntityId } from '../../shared/types/index.js';
import { rrfFuse } from '../../shared/utils/rrf.js';
import type {
  SparseHit,
  DenseHit,
  RetrievalHitSummary,
} from '../port/search-index.port.js';
import type { HybridCandidate } from '../model/hybrid-candidate.js';
import type { RetrievalTrace } from '../model/retrieval-trace.js';

/**
 * Merges per-pass hit summaries. Priority: sparse > dense > anchor (first non-empty wins).
 * Includes wine attributes for Epic 15.
 */
function mergeRetrievalSummaries(
  sparse?: RetrievalHitSummary,
  dense?: RetrievalHitSummary,
  anchor?: RetrievalHitSummary,
): {
  readonly canonicalLabel?: string;
  readonly producer?: string;
  readonly region?: string;
  readonly searchTextEn?: string;
  readonly grapePrimary?: string;
  readonly style?: string;
  readonly priceBand?: string;
  readonly pairing?: readonly string[];
  readonly occasion?: readonly string[];
  readonly vintageYear?: number;
  readonly body?: number;
  readonly tannin?: number;
  readonly acidity?: number;
  readonly sweetness?: number;
  readonly finishLength?: number;
  readonly wineType?: string;
  readonly criticScoreNormalized?: number;
  readonly country?: string;
  readonly appellation?: string;
  readonly classification?: string;
  readonly alcoholPct?: number;
  readonly drinkingWindowStart?: number;
  readonly drinkingWindowEnd?: number;
  readonly priceUsd?: number;
  readonly certifications?: readonly string[];
  readonly soilType?: string;
  readonly producerType?: string;
} {
  const canonicalLabel =
    sparse?.canonicalLabel ?? dense?.canonicalLabel ?? anchor?.canonicalLabel;
  const producer = sparse?.producer ?? dense?.producer ?? anchor?.producer;
  const region = sparse?.region ?? dense?.region ?? anchor?.region;
  const searchTextEn =
    sparse?.searchTextEn ?? dense?.searchTextEn ?? anchor?.searchTextEn;
  const grapePrimary =
    sparse?.grapePrimary ?? dense?.grapePrimary ?? anchor?.grapePrimary;
  const style = sparse?.style ?? dense?.style ?? anchor?.style;
  const priceBand = sparse?.priceBand ?? dense?.priceBand ?? anchor?.priceBand;
  const pairing = sparse?.pairing ?? dense?.pairing ?? anchor?.pairing;
  const occasion = sparse?.occasion ?? dense?.occasion ?? anchor?.occasion;

  // Epic 15: Wine attributes (for dynamic prediction)
  const vintageYear =
    sparse?.vintageYear ?? dense?.vintageYear ?? anchor?.vintageYear;
  const body = sparse?.body ?? dense?.body ?? anchor?.body;
  const tannin = sparse?.tannin ?? dense?.tannin ?? anchor?.tannin;
  const acidity = sparse?.acidity ?? dense?.acidity ?? anchor?.acidity;
  const sweetness = sparse?.sweetness ?? dense?.sweetness ?? anchor?.sweetness;
  const finishLength =
    sparse?.finishLength ?? dense?.finishLength ?? anchor?.finishLength;
  const wineType = sparse?.wineType ?? dense?.wineType ?? anchor?.wineType;
  const criticScoreNormalized =
    sparse?.criticScoreNormalized ?? dense?.criticScoreNormalized ?? anchor?.criticScoreNormalized;
  const country = sparse?.country ?? dense?.country ?? anchor?.country;
  const appellation = sparse?.appellation ?? dense?.appellation ?? anchor?.appellation;
  const classification =
    sparse?.classification ?? dense?.classification ?? anchor?.classification;
  const alcoholPct = sparse?.alcoholPct ?? dense?.alcoholPct ?? anchor?.alcoholPct;
  const drinkingWindowStart =
    sparse?.drinkingWindowStart ?? dense?.drinkingWindowStart ?? anchor?.drinkingWindowStart;
  const drinkingWindowEnd =
    sparse?.drinkingWindowEnd ?? dense?.drinkingWindowEnd ?? anchor?.drinkingWindowEnd;
  const priceUsd = sparse?.priceUsd ?? dense?.priceUsd ?? anchor?.priceUsd;
  const certifications =
    sparse?.certifications ?? dense?.certifications ?? anchor?.certifications;
  const soilType = sparse?.soilType ?? dense?.soilType ?? anchor?.soilType;
  const producerType =
    sparse?.producerType ?? dense?.producerType ?? anchor?.producerType;

  return {
    ...(canonicalLabel !== undefined ? { canonicalLabel } : {}),
    ...(producer !== undefined ? { producer } : {}),
    ...(region !== undefined ? { region } : {}),
    ...(searchTextEn !== undefined ? { searchTextEn } : {}),
    ...(grapePrimary !== undefined ? { grapePrimary } : {}),
    ...(style !== undefined ? { style } : {}),
    ...(priceBand !== undefined ? { priceBand } : {}),
    ...(pairing !== undefined ? { pairing } : {}),
    ...(occasion !== undefined ? { occasion } : {}),
    ...(vintageYear !== undefined ? { vintageYear } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(tannin !== undefined ? { tannin } : {}),
    ...(acidity !== undefined ? { acidity } : {}),
    ...(sweetness !== undefined ? { sweetness } : {}),
    ...(finishLength !== undefined ? { finishLength } : {}),
    ...(wineType !== undefined ? { wineType } : {}),
    ...(criticScoreNormalized !== undefined ? { criticScoreNormalized } : {}),
    ...(country !== undefined ? { country } : {}),
    ...(appellation !== undefined ? { appellation } : {}),
    ...(classification !== undefined ? { classification } : {}),
    ...(alcoholPct !== undefined ? { alcoholPct } : {}),
    ...(drinkingWindowStart !== undefined ? { drinkingWindowStart } : {}),
    ...(drinkingWindowEnd !== undefined ? { drinkingWindowEnd } : {}),
    ...(priceUsd !== undefined ? { priceUsd } : {}),
    ...(certifications !== undefined ? { certifications } : {}),
    ...(soilType !== undefined ? { soilType } : {}),
    ...(producerType !== undefined ? { producerType } : {}),
  };
}

function summaryFromSparseHits(
  hits: readonly SparseHit[],
  entityId: string,
): RetrievalHitSummary | undefined {
  for (const h of hits) {
    if (h.entityId === entityId) return h.summary;
  }
  return undefined;
}

function summaryFromDenseHits(
  hits: readonly DenseHit[],
  entityId: string,
): RetrievalHitSummary | undefined {
  for (const h of hits) {
    if (h.entityId === entityId) return h.summary;
  }
  return undefined;
}

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

    // Build rankings array for RRF — only include non-empty rankings.
    // Fusing with an empty ranking (dense off) adds no information and
    // dilutes the sparse signal (divides by more rankings with no benefit).
    const rankings: ReadonlyMap<string, number>[] = [];
    if (sparseRankMap.size > 0) rankings.push(sparseRankMap);
    if (denseRankMap.size > 0) rankings.push(denseRankMap);
    if (anchorHits && anchorRankMap.size > 0) rankings.push(anchorRankMap);

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

      const merged = mergeRetrievalSummaries(
        summaryFromSparseHits(sparseHits, entityId),
        summaryFromDenseHits(denseHits, entityId),
        anchorHits !== undefined
          ? summaryFromDenseHits(anchorHits, entityId)
          : undefined,
      );

      candidates.push({
        entityId: entityId as EntityId,
        sparseRank,
        denseRank,
        anchorRank,
        retrievalFusionScore: fusionScore,
        matchedConstraints: [],
        retrievalTrace: trace,
        ...merged,
      });
    }

    // Sort descending by retrievalFusionScore
    candidates.sort((a, b) => b.retrievalFusionScore - a.retrievalFusionScore);

    return candidates;
  }
}
