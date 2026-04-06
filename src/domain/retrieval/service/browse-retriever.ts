import type { ConstraintBundle } from '../../shared/types/index.js';
import type { SearchIndexPort, SparseHit } from '../port/search-index.port.js';
import type { HybridCandidate } from '../model/hybrid-candidate.js';
import type { RetrievalTrace } from '../model/retrieval-trace.js';
import { hardConstraintsToSparseFilterTokens } from './constraint-to-sparse-filter-tokens.js';
import { annotateCandidateConstraintEvidenceBatch } from './candidate-constraint-evidence.js';
import { ConstraintFilter } from './constraint-filter.js';
import {
  browseSparseFetchLimit,
  dedupeSparseHitsByEntity,
  diversifyProducerBrowseHits,
  diversifyRegionBrowseHits,
  expandProducerBrowseLexicalQueries,
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
      style: summary?.style,
      priceBand: summary?.priceBand,
      pairing: summary?.pairing,
      occasion: summary?.occasion,
      vintageYear: summary?.vintageYear,
      body: summary?.body,
      tannin: summary?.tannin,
      acidity: summary?.acidity,
      sweetness: summary?.sweetness,
      finishLength: summary?.finishLength,
      wineType: summary?.wineType,
      criticScoreNormalized: summary?.criticScoreNormalized,
      producerPrestige: summary?.producerPrestige,
      country: summary?.country,
      appellation: summary?.appellation,
      classification: summary?.classification,
      alcoholPct: summary?.alcoholPct,
      drinkingWindowStart: summary?.drinkingWindowStart,
      drinkingWindowEnd: summary?.drinkingWindowEnd,
      priceUsd: summary?.priceUsd,
      certifications: summary?.certifications,
      soilType: summary?.soilType,
      producerType: summary?.producerType,
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
 * - Over-fetches sparse hits, then diversifies: producer browse by structured line × vintage
 *   (producer+grape+geo when available) and prestige/critic-aware ranking; region browse by
 *   per-producer caps + prestige/critic-informed ranking.
 * - Region browse issues multiple OR queries (path + segments) for recall on hierarchical paths.
 */
export class BrowseRetriever {
  private readonly constraintFilter = new ConstraintFilter();

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
    const lexical = expandProducerBrowseLexicalQueries(q);
    const queries = lexical.length > 0 ? [...lexical] : [q];
    const rawHits = await this.searchIndex.sparseSearch(
      queries,
      filters.length > 0 ? filters : undefined,
      fetchLimit,
    );
    const hits = dedupeSparseHitsByEntity(rawHits);
    const diversified = diversifyProducerBrowseHits(hits, limit);
    const candidates = annotateCandidateConstraintEvidenceBatch(
      sparseHitsToBrowseCandidates(diversified, 'producer_browse', queries, filters),
      constraints,
    );
    return this.constraintFilter.applyHardFilters(candidates, constraints.hard);
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
    const candidates = annotateCandidateConstraintEvidenceBatch(sparseHitsToBrowseCandidates(
      diversified,
      'region_browse',
      lexical,
      filters,
    ), constraints);
    return this.constraintFilter.applyHardFilters(candidates, constraints.hard);
  }
}
