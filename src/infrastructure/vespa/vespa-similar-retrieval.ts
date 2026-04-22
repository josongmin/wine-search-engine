import type { SimilarRetrievalPort } from '../../domain/mixed/port/mixed-query.port.js';
import type { AnchorProfile } from '../../domain/mixed/model/anchor-profile.js';
import type { HybridCandidate } from '../../domain/retrieval/model/hybrid-candidate.js';
import type { SearchIndexPort } from '../../domain/retrieval/port/search-index.port.js';
import { summaryToHybridCandidateFields } from '../../domain/retrieval/service/hybrid-candidate-summary.js';
import { hardConstraintsToSparseFilterTokens } from '../../domain/retrieval/service/constraint-to-sparse-filter-tokens.js';
import type { NormalizedConstraint } from '../../domain/shared/types/index.js';

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
    hardConstraints: readonly NormalizedConstraint[] = [],
  ): Promise<readonly HybridCandidate[]> {
    if (
      anchorProfile.embedding === undefined ||
      anchorProfile.embedding.length === 0
    ) {
      return [];
    }

    const filters = hardConstraintsToSparseFilterTokens(hardConstraints);
    const hits = await this.searchIndex.denseSearch(
      anchorProfile.embedding,
      filters,
      limit,
    );

    return hits.map(
      (hit): HybridCandidate => ({
        entityId: hit.entityId,
        denseRank: hit.rank,
        denseRawScore: hit.score,
        identityExactnessTier: 'none',
        // No fused-score field is written here because similar retrieval does
        // not go through fusion. Downstream consumers must use denseRawScore.
        matchedConstraints: [],
        retrievalTrace: {
          retrievalProfile: 'similar_anchor',
          lexicalQueriesUsed: [],
          semanticQueriesUsed: [anchorProfile.canonicalLabel],
          filtersApplied: filters,
          candidateSources: ['anchor_similarity'],
        },
        ...summaryToHybridCandidateFields(hit.summary),
      }),
    );
  }
}
