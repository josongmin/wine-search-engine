import type { ConstraintBundle } from '../../shared/types/index.js';
import type { ConstraintGraph } from '../../query/model/constraint-graph.js';
import type { SearchIndexPort, SparseHit } from '../port/search-index.port.js';
import type { HybridCandidate } from '../model/hybrid-candidate.js';
import { ConstraintFilter } from './constraint-filter.js';
import { sparseHitsToCandidates } from './sparse-hit-to-candidate.js';
import {
  browseSparseFetchLimit,
  diversifyProducerBrowseHits,
  diversifyRegionBrowseHits,
  expandProducerBrowseLexicalQueries,
  expandRegionBrowseLexicalQueries,
} from './browse-diversity.js';
import {
  annotateAndApplyHardFilters,
  resolveHardForFilter,
  searchAndDedupSparse,
  toSparseFilterTokens,
} from './sparse-retrieval-pipeline.js';

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
 *
 * Shared pipeline steps (graph-aware hard-filter resolution, sparse-search +
 * dedup, constraint-evidence annotation + hard-filter rejection) live in
 * `sparse-retrieval-pipeline.ts`; only browse-specific lexical expansion and
 * diversification stay inline here.
 */
export class BrowseRetriever {
  private readonly constraintFilter = new ConstraintFilter();

  constructor(private readonly searchIndex: SearchIndexPort) {}

  async browseProducer(
    producerName: string,
    constraints: ConstraintBundle,
    limit: number,
    graph?: ConstraintGraph  ,
  ): Promise<readonly HybridCandidate[]> {
    const q = producerName.trim();
    if (q.length === 0) {
      return [];
    }
    const hardForFilter = resolveHardForFilter(constraints, graph);
    const filters = toSparseFilterTokens(hardForFilter);
    const fetchLimit = browseSparseFetchLimit(limit);
    const lexical = expandProducerBrowseLexicalQueries(q);
    const queries = lexical.length > 0 ? [...lexical] : [q];
    const hits = await searchAndDedupSparse({
      client: this.searchIndex,
      queries,
      filters,
      fetchLimit,
    });
    const diversified = diversifyProducerBrowseHits(hits, limit);
    return annotateAndApplyHardFilters({
      candidates: sparseHitsToBrowseCandidates(diversified, 'producer_browse', queries, filters),
      constraints,
      graph,
      constraintFilter: this.constraintFilter,
      hardForFilter,
    });
  }

  async browseRegion(
    regionName: string,
    constraints: ConstraintBundle,
    limit: number,
    graph?: ConstraintGraph  ,
  ): Promise<readonly HybridCandidate[]> {
    const q = regionName.trim();
    if (q.length === 0) {
      return [];
    }
    const hardForFilter = resolveHardForFilter(constraints, graph);
    const filters = toSparseFilterTokens(hardForFilter);
    const queries = expandRegionBrowseLexicalQueries(q);
    const lexical = queries.length > 0 ? queries : [q];
    const fetchLimit = browseSparseFetchLimit(limit);
    const hits = await searchAndDedupSparse({
      client: this.searchIndex,
      queries: lexical,
      filters,
      fetchLimit,
    });
    const diversified = diversifyRegionBrowseHits(hits, limit);
    return annotateAndApplyHardFilters({
      candidates: sparseHitsToBrowseCandidates(diversified, 'region_browse', lexical, filters),
      constraints,
      graph,
      constraintFilter: this.constraintFilter,
      hardForFilter,
    });
  }
}
