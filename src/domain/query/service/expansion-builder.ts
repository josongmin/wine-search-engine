import type { QueryIntent } from '../model/query-intent.js';
import type { AnchorCandidate } from '../model/anchor-candidate.js';
import type { ExpansionBundle } from '../model/constraint-bundle.js';

/**
 * Builds lexical and semantic expansion terms for a query.
 *
 * Expansion terms broaden retrieval coverage beyond the literal query text.
 * The builder selects expansion strategies based on the detected intent and
 * available anchors.
 */
export class ExpansionBuilder {
  /**
   * Builds an expansion bundle from the normalized query, intent, and anchors.
   *
   * Strategy:
   * - `entity_exact` / `entity_fuzzy` -- minimal expansions; anchors are primary.
   * - `facet_search` / `budget_search` -- no semantic expansion; lexical synonyms only.
   * - `semantic_discovery` / `pairing_search` -- full semantic expansion.
   * - `comparison_search` -- expand each anchor independently.
   * - `mixed_query` -- combine entity-based and constraint-based expansions.
   *
   * @param normalizedQuery - The normalized query string.
   * @param intent - The detected query intent.
   * @param anchors - Extracted anchor candidates.
   * @returns An expansion bundle with lexical and semantic terms.
   */
  build(
    normalizedQuery: string,
    intent: QueryIntent,
    anchors: readonly AnchorCandidate[],
  ): ExpansionBundle {
    switch (intent) {
      case 'entity_exact':
        return this.buildEntityExactExpansion(anchors);
      case 'entity_fuzzy':
        return this.buildEntityFuzzyExpansion(normalizedQuery, anchors);
      case 'facet_search':
      case 'budget_search':
        return this.buildConstraintExpansion(normalizedQuery);
      case 'semantic_discovery':
      case 'pairing_search':
        return this.buildSemanticExpansion(normalizedQuery);
      case 'comparison_search':
        return this.buildComparisonExpansion(anchors);
      case 'mixed_query':
        return this.buildMixedExpansion(normalizedQuery, anchors);
    }
  }

  /** Entity-exact queries need only the anchor's normalized form. */
  private buildEntityExactExpansion(
    anchors: readonly AnchorCandidate[],
  ): ExpansionBundle {
    return {
      lexical: anchors.map((a) => a.normalizedForm),
      semantic: [],
    };
  }

  /** Entity-fuzzy queries add the full query as a semantic phrase. */
  private buildEntityFuzzyExpansion(
    normalizedQuery: string,
    anchors: readonly AnchorCandidate[],
  ): ExpansionBundle {
    return {
      lexical: anchors.map((a) => a.normalizedForm),
      semantic: [normalizedQuery],
    };
  }

  /** Constraint-based queries use the query tokens as lexical expansions. */
  private buildConstraintExpansion(normalizedQuery: string): ExpansionBundle {
    const tokens = normalizedQuery
      .split(/\s+/)
      .filter((t) => t.length > 1);
    return {
      lexical: tokens,
      semantic: [],
    };
  }

  /** Semantic queries use the full query for dense retrieval. */
  private buildSemanticExpansion(normalizedQuery: string): ExpansionBundle {
    return {
      lexical: [],
      semantic: [normalizedQuery],
    };
  }

  /** Comparison queries expand each anchor independently. */
  private buildComparisonExpansion(
    anchors: readonly AnchorCandidate[],
  ): ExpansionBundle {
    return {
      lexical: anchors.map((a) => a.normalizedForm),
      semantic: anchors.map((a) => a.surfaceForm),
    };
  }

  /** Mixed queries combine anchor lexical terms with the full query for semantic. */
  private buildMixedExpansion(
    normalizedQuery: string,
    anchors: readonly AnchorCandidate[],
  ): ExpansionBundle {
    return {
      lexical: anchors.map((a) => a.normalizedForm),
      semantic: [normalizedQuery],
    };
  }
}
