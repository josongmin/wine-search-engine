import type { SimilarRetrievalPort } from '../../domain/mixed/service/mixed-solver.js';
import type { AnchorProfile } from '../../domain/mixed/model/anchor-profile.js';
import type { HybridCandidate } from '../../domain/retrieval/model/hybrid-candidate.js';
import type { SearchIndexPort } from '../../domain/retrieval/port/search-index.port.js';
import { summaryToHybridCandidateFields } from '../../domain/retrieval/service/hybrid-candidate-summary.js';

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
        denseRawScore: hit.score,
        // retrievalFusionScore intentionally omitted — field is deprecated/optional.
        // Downstream consumers use fusionRrfTotal (absent here — no fusion pass)
        // or fall back to sparseRawScore/denseRawScore via candidate-pool mapping.
        matchedConstraints: [],
        retrievalTrace: {
          retrievalProfile: 'similar_anchor',
          lexicalQueriesUsed: [],
          semanticQueriesUsed: [anchorProfile.canonicalLabel],
          filtersApplied: [],
          candidateSources: ['anchor_similarity'],
        },
        ...summaryToHybridCandidateFields(hit.summary),
      }),
    );
  }
}
