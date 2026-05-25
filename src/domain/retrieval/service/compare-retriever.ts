import type { HybridCandidate } from '../model/hybrid-candidate.js';
import type { CanonicalEntityId } from '../../shared/types/index.js';
import type { ConstraintBundle } from '../../shared/types/index.js';
import type { ConstraintGraph } from '../../query/model/constraint-graph.js';
import type { SearchIndexPort, SparseHit } from '../port/search-index.port.js';
import { ConstraintFilter } from './constraint-filter.js';
import { sparseHitsToCandidates } from './sparse-hit-to-candidate.js';
import { stripVintageYearsBounded } from '../../shared/utils/vintage.js';
import { normalizeUnicode } from '../../shared/utils/unicode-normalize.js';
import {
  RETRIEVAL_CHANNEL_COMPARE_ANCHOR,
  RETRIEVAL_CHANNEL_SPARSE_BM25,
} from '../model/retrieval-channel.js';
import {
  annotateAndApplyHardFilters,
  resolveHardForFilter,
  searchAndDedupSparse,
  toSparseFilterTokens,
} from './sparse-retrieval-pipeline.js';

export class CompareRetriever {
  private readonly constraintFilter = new ConstraintFilter();

  constructor(private readonly searchIndex: SearchIndexPort) {}

  /**
   * Bounded fan-out multiplier: over-fetch this many × `limit` sparse hits
   * before de-dup + anchor exclusion + slice. Keeps the comparison candidate
   * set bounded regardless of how many anchor lexical legs are emitted.
   */
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
      candidateSources: [RETRIEVAL_CHANNEL_SPARSE_BM25, RETRIEVAL_CHANNEL_COMPARE_ANCHOR],
    });
  }

  private buildAnchorQueries(anchor: {
    readonly canonicalLabel: string;
    readonly producer: string;
    readonly region: string;
    readonly grapes: readonly string[];
    readonly style?: string | undefined;
    readonly appellation?: string | undefined;
    readonly country?: string | undefined;
  }): readonly string[] {
    // SSoT: every anchor-derived lexical leg is NFC-normalized + whitespace
    // collapsed via normalizeUnicode before it reaches the sparse index. The
    // index stores NFC text, so an NFD Korean anchor label (e.g. decomposed
    // 한글 jamo) must be composed first or the BM25 match silently misses.
    // Normalizing through the Set also collapses NFC-equivalent duplicates
    // deterministically (insertion-order-stable). See test discipline rule 5/8.
    const queries = new Set<string>();
    const add = (raw: string | undefined): void => {
      if (raw === undefined) {
        return;
      }
      const normalized = normalizeUnicode(raw);
      if (normalized.length > 0) {
        queries.add(normalized);
      }
    };
    add(stripVintageYearsBounded(anchor.canonicalLabel));
    add(anchor.producer);
    add(anchor.region);
    add(anchor.appellation);
    add(anchor.country);
    add(anchor.grapes[0]);
    add(anchor.style);
    return [...queries];
  }

  /**
   * Compare mode: retrieve wines that align with an anchor's producer / region /
   * grape/style profile, then let the ranking layer do the final shaping.
   *
   * This keeps comparison retrieval operational in production instead of
   * silently falling back to the generic candidate pool.
   *
   * Shared pipeline steps (graph-aware hard-filter resolution, sparse-search
   * + dedup, constraint-evidence annotation + hard-filter rejection) live in
   * `sparse-retrieval-pipeline.ts`; only the compare-specific anchor query
   * synthesis and anchor exclusion stay inline here.
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

    const hardForFilter = resolveHardForFilter(constraints, graph);
    const filters = toSparseFilterTokens(hardForFilter);
    const dedupedHits = await searchAndDedupSparse({
      client: this.searchIndex,
      queries: lexicalQueries,
      filters,
      fetchLimit: Math.max(limit * CompareRetriever.FETCH_MULTIPLIER, limit),
    });
    const hits = dedupedHits
      .filter((hit) => hit.entityId !== anchorEntityId)
      .slice(0, limit);

    return annotateAndApplyHardFilters({
      candidates: CompareRetriever.hitsToCandidates(hits, lexicalQueries, filters),
      constraints,
      graph,
      constraintFilter: this.constraintFilter,
      hardForFilter,
    });
  }
}
