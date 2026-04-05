import type { SimilarRetrievalPort } from '../../domain/mixed/service/mixed-solver.js';
import type { AnchorProfile } from '../../domain/mixed/model/anchor-profile.js';
import type { HybridCandidate } from '../../domain/retrieval/model/hybrid-candidate.js';
import type { SearchIndexPort } from '../../domain/retrieval/port/search-index.port.js';

/**
 * Reciprocal Rank Fusion smoothing constant (standard value).
 * Prevents scores from exploding when rank = 1.
 */
const RRF_K = 60;

function rrfScore(rank: number): number {
  return 1 / (RRF_K + rank);
}

/**
 * Vespa-backed implementation of {@link SimilarRetrievalPort}.
 *
 * Uses the anchor entity's pre-computed embedding to execute an ANN
 * dense-retrieval pass and returns the results as {@link HybridCandidate}s
 * with RRF-computed fusion scores.
 *
 * If the anchor profile lacks an embedding vector (e.g. for legacy entities)
 * the method returns an empty set rather than throwing.
 */
export class VespaSimilarRetrieval implements SimilarRetrievalPort {
  constructor(private readonly searchIndex: SearchIndexPort) {}

  async retrieveSimilar(
    anchorProfile: AnchorProfile,
    limit: number,
  ): Promise<readonly HybridCandidate[]> {
    if (
      anchorProfile.embedding === undefined ||
      anchorProfile.embedding.length === 0
    ) {
      return [];
    }

    const hits = await this.searchIndex.denseSearch(
      anchorProfile.embedding,
      [],
      limit,
    );

    return hits.map(
      (hit): HybridCandidate => ({
        entityId: hit.entityId,
        denseRank: hit.rank,
        retrievalFusionScore: rrfScore(hit.rank),
        matchedConstraints: [],
        retrievalTrace: {
          retrievalProfile: 'similar_anchor',
          lexicalQueriesUsed: [],
          semanticQueriesUsed: [anchorProfile.canonicalLabel],
          filtersApplied: [],
          candidateSources: ['dense'],
        },
        ...(hit.summary?.canonicalLabel !== undefined
          ? { canonicalLabel: hit.summary.canonicalLabel }
          : {}),
        ...(hit.summary?.producer !== undefined ? { producer: hit.summary.producer } : {}),
        ...(hit.summary?.region !== undefined ? { region: hit.summary.region } : {}),
        ...(hit.summary?.searchTextEn !== undefined
          ? { searchTextEn: hit.summary.searchTextEn }
          : {}),
        ...(hit.summary?.grapePrimary !== undefined
          ? { grapePrimary: hit.summary.grapePrimary }
          : {}),
      }),
    );
  }
}
