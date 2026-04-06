import type { ConstraintBundle } from '../../shared/types/index.js';
import type { SearchIndexPort, SparseHit } from '../port/search-index.port.js';
import type { HybridCandidate } from '../model/hybrid-candidate.js';
import type { RetrievalTrace } from '../model/retrieval-trace.js';
import { hardConstraintsToSparseFilterTokens } from './constraint-to-sparse-filter-tokens.js';
import {
  browseSparseFetchLimit,
  dedupeSparseHitsByEntity,
  diversifyProducerBrowseHits,
  diversifyRegionBrowseHits,
  expandRegionBrowseLexicalQueries,
} from './browse-diversity.js';

/**
 * Maps sparse index hits to hybrid candidates for browse modes.
 */
function sparseHitsToBrowseCandidates(
  hits: readonly SparseHit[],
  profile: 'producer_browse' | 'region_browse',
  lexicalQueries: readonly string[],
  filtersApplied: readonly string[],
): readonly HybridCandidate[] {
  return hits.map((hit, index) => {
    const summary = hit.summary;
    const trace: RetrievalTrace = {
      retrievalProfile: profile,
      lexicalQueriesUsed: lexicalQueries,
      semanticQueriesUsed: [],
      filtersApplied: [...filtersApplied],
      candidateSources: ['sparse'],
    };
    return {
      entityId: hit.entityId,
      canonicalLabel: summary?.canonicalLabel,
      producer: summary?.producer,
      region: summary?.region,
      searchTextEn: summary?.searchTextEn,
      grapePrimary: summary?.grapePrimary,
      vintageYear: summary?.vintageYear,
      body: summary?.body,
      tannin: summary?.tannin,
      acidity: summary?.acidity,
      sweetness: summary?.sweetness,
      criticScoreNormalized: summary?.criticScoreNormalized,
      country: summary?.country,
      appellation: summary?.appellation,
      sparseRank: index + 1,
      retrievalFusionScore: hit.score,
      matchedConstraints: [],
      retrievalTrace: trace,
    };
  });
}

/**
 * Epic 10: Browse Retriever — set retrieval for producer / region exploration.
 *
 * - Applies hard constraints as Vespa sparse filter tokens (when mappable).
 * - Over-fetches sparse hits, then diversifies: producer browse by product line × vintage,
 *   region browse by per-producer caps + critic-informed ranking.
 * - Region browse issues multiple OR queries (path + segments) for recall on hierarchical paths.
 */
export class BrowseRetriever {
  constructor(private readonly searchIndex: SearchIndexPort) {}

  async browseProducer(
    producerName: string,
    constraints: ConstraintBundle,
    limit: number,
  ): Promise<readonly HybridCandidate[]> {
    const q = producerName.trim();
    if (q.length === 0) {
      return [];
    }
    const filters = [...hardConstraintsToSparseFilterTokens(constraints.hard)];
    const fetchLimit = browseSparseFetchLimit(limit);
    const rawHits = await this.searchIndex.sparseSearch(
      [q],
      filters.length > 0 ? filters : undefined,
      fetchLimit,
    );
    const hits = dedupeSparseHitsByEntity(rawHits);
    const diversified = diversifyProducerBrowseHits(hits, limit);
    return sparseHitsToBrowseCandidates(diversified, 'producer_browse', [q], filters);
  }

  async browseRegion(
    regionName: string,
    constraints: ConstraintBundle,
    limit: number,
  ): Promise<readonly HybridCandidate[]> {
    const q = regionName.trim();
    if (q.length === 0) {
      return [];
    }
    const filters = [...hardConstraintsToSparseFilterTokens(constraints.hard)];
    const queries = expandRegionBrowseLexicalQueries(q);
    const lexical = queries.length > 0 ? queries : [q];
    const fetchLimit = browseSparseFetchLimit(limit);
    const rawHits = await this.searchIndex.sparseSearch(
      lexical,
      filters.length > 0 ? filters : undefined,
      fetchLimit,
    );
    const hits = dedupeSparseHitsByEntity(rawHits);
    const diversified = diversifyRegionBrowseHits(hits, limit);
    return sparseHitsToBrowseCandidates(
      diversified,
      'region_browse',
      lexical,
      filters,
    );
  }
}
