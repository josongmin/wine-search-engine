import type { HybridCandidate } from '../model/hybrid-candidate.js';
import type { CanonicalEntityId } from '../../shared/types/index.js';
import type { ConstraintBundle } from '../../shared/types/index.js';
import type { ConstraintGraph } from '../../query/model/constraint-graph.js';
import type { SearchIndexPort, SparseHit } from '../port/search-index.port.js';
import { hardConstraintsToSparseFilterTokens } from './constraint-to-sparse-filter-tokens.js';
import { dedupeSparseHitsByEntity } from './browse-diversity.js';
import { annotateCandidateConstraintEvidenceBatch } from './candidate-constraint-evidence.js';
import { ConstraintFilter } from './constraint-filter.js';
import { sparseHitsToCandidates } from './sparse-hit-to-candidate.js';
import { stripVintageYearsBounded } from '../../shared/utils/vintage.js';
import { extractHardConstraintsFromGraph } from '../../query/service/graph-slot-constraints.js';

export class CompareRetriever {
  private readonly constraintFilter = new ConstraintFilter();

  constructor(private readonly searchIndex: SearchIndexPort) {}

  private static readonly FETCH_MULTIPLIER = 4;

  private static hitsToCandidates(
    hits: readonly SparseHit[],
    lexicalQueries: readonly string[],
    filtersApplied: readonly string[],
  ): readonly HybridCandidate[] {
    return sparseHitsToCandidates(hits, {
      retrievalProfile: 'compare_default',
      lexicalQueries,
      filtersApplied,
      candidateSources: ['sparse_bm25', 'compare_anchor'],
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
    const compactLabel = stripVintageYearsBounded(anchor.canonicalLabel).trim();
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
    anchorEntityId: CanonicalEntityId,
    constraints: ConstraintBundle,
    limit: number,
    graph?: ConstraintGraph  ,
  ): Promise<readonly HybridCandidate[]> {
    const anchor = await this.searchIndex.getDocument(anchorEntityId);
    if (anchor === null) {
      return [];
    }

    const lexicalQueries = this.buildAnchorQueries(anchor);
    if (lexicalQueries.length === 0) {
      return [];
    }

    // ADR-014 Phase 1b.3b: graph-aware filter extraction. Trivial-graph
    // emission is byte-identical to the pre-PR5 `constraints.hard` path.
    const hardForFilter = graph !== undefined
      ? extractHardConstraintsFromGraph(graph)
      : constraints.hard;
    const filters = [...hardConstraintsToSparseFilterTokens(hardForFilter)];
    const rawHits = await this.searchIndex.sparseSearch(
      lexicalQueries,
      filters.length > 0 ? filters : undefined,
      Math.max(limit * CompareRetriever.FETCH_MULTIPLIER, limit),
    );
    const hits = dedupeSparseHitsByEntity(rawHits)
      .filter((hit) => hit.entityId !== anchorEntityId)
      .slice(0, limit);

    const candidates = annotateCandidateConstraintEvidenceBatch(
      CompareRetriever.hitsToCandidates(hits, lexicalQueries, filters),
      constraints,
      graph,
    );
    return this.constraintFilter.applyHardFilters(candidates, hardForFilter);
  }
}
