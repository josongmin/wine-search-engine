import type { ConstraintBundle } from '../../shared/types/index.js';
import type { SearchIndexPort, SparseHit } from '../port/search-index.port.js';
import type { HybridCandidate } from '../model/hybrid-candidate.js';
import { hardConstraintsToSparseFilterTokens } from './constraint-to-sparse-filter-tokens.js';
import { annotateCandidateConstraintEvidenceBatch } from './candidate-constraint-evidence.js';
import { ConstraintFilter } from './constraint-filter.js';
import { sparseHitsToCandidates } from './sparse-hit-to-candidate.js';
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
  return sparseHitsToCandidates(hits, {
    retrievalProfile: profile,
    lexicalQueries,
    filtersApplied,
    candidateSources: [
      'sparse_bm25',
      profile === 'producer_browse' ? 'browse_producer' : 'browse_region',
    ],
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
