import type { HybridCandidate } from '../model/hybrid-candidate.js';
import type { EntityId } from '../../shared/types/index.js';
import type { ConstraintBundle } from '../../shared/types/index.js';
import type { RetrievalTrace } from '../model/retrieval-trace.js';
import type { SearchIndexPort, SparseHit } from '../port/search-index.port.js';
import { hardConstraintsToSparseFilterTokens } from './constraint-to-sparse-filter-tokens.js';
import { dedupeSparseHitsByEntity } from './browse-diversity.js';

/**
 * Comparison candidate — enriched with structured attribute data for side-by-side comparison.
 *
 * Unlike {@link HybridCandidate}, which is optimized for retrieval/ranking,
 * ComparisonCandidate exposes all comparison-relevant attributes in a structured form.
 */
export class CompareRetriever {
  constructor(private readonly searchIndex: SearchIndexPort) {}

  private static readonly FETCH_MULTIPLIER = 4;

  private static hitsToCandidates(
    hits: readonly SparseHit[],
    lexicalQueries: readonly string[],
    filtersApplied: readonly string[],
  ): readonly HybridCandidate[] {
    return hits.map((hit, index) => {
      const summary = hit.summary;
      const trace: RetrievalTrace = {
        retrievalProfile: 'compare_candidates',
        lexicalQueriesUsed: lexicalQueries,
        semanticQueriesUsed: [],
        filtersApplied: [...filtersApplied],
        candidateSources: ['sparse', 'anchor'],
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
        producerPrestige: summary?.producerPrestige,
        country: summary?.country,
        appellation: summary?.appellation,
        sparseRank: index + 1,
        retrievalFusionScore: hit.score,
        matchedConstraints: [],
        retrievalTrace: trace,
      };
    });
  }

  private buildAnchorQueries(anchor: {
    readonly canonicalLabel: string;
    readonly producer: string;
    readonly region: string;
    readonly grapes: readonly string[];
    readonly style: string;
    readonly appellation?: string | undefined;
    readonly country?: string | undefined;
  }): readonly string[] {
    const queries = new Set<string>();
    const compactLabel = anchor.canonicalLabel.replace(/\b(19|20)\d{2}\b/g, '').trim();
    if (compactLabel.length > 0) {
      queries.add(compactLabel);
    }
    if (anchor.producer.trim().length > 0) {
      queries.add(anchor.producer.trim());
    }
    if (anchor.region.trim().length > 0) {
      queries.add(anchor.region.trim());
    }
    if (anchor.appellation !== undefined && anchor.appellation.trim().length > 0) {
      queries.add(anchor.appellation.trim());
    }
    if (anchor.country !== undefined && anchor.country.trim().length > 0) {
      queries.add(anchor.country.trim());
    }
    if (anchor.grapes[0] !== undefined && anchor.grapes[0].trim().length > 0) {
      queries.add(anchor.grapes[0].trim());
    }
    if (anchor.style.trim().length > 0) {
      queries.add(anchor.style.trim());
    }
    return [...queries];
  }

  /**
   * Compare mode: retrieve wines that align with an anchor's producer / region /
   * grape/style profile, then let the ranking layer do the final shaping.
   *
   * This keeps comparison retrieval operational in production instead of
   * silently falling back to the generic candidate pool.
   *
   * @param anchorEntityId - The reference wine to compare against.
   * @param constraints - Optional constraints to refine the comparison set.
   * @param limit - Maximum candidates to retrieve.
   */
  async compareAgainstAnchor(
    anchorEntityId: EntityId,
    constraints: ConstraintBundle,
    limit: number,
  ): Promise<readonly HybridCandidate[]> {
    const anchor = await this.searchIndex.getDocument(anchorEntityId);
    if (anchor === null) {
      return [];
    }

    const lexicalQueries = this.buildAnchorQueries(anchor);
    if (lexicalQueries.length === 0) {
      return [];
    }

    const filters = [...hardConstraintsToSparseFilterTokens(constraints.hard)];
    const rawHits = await this.searchIndex.sparseSearch(
      lexicalQueries,
      filters.length > 0 ? filters : undefined,
      Math.max(limit * CompareRetriever.FETCH_MULTIPLIER, limit),
    );
    const hits = dedupeSparseHitsByEntity(rawHits)
      .filter((hit) => hit.entityId !== anchorEntityId)
      .slice(0, limit);

    return CompareRetriever.hitsToCandidates(hits, lexicalQueries, filters);
  }
}
