import type { QueryIntent } from '../model/query-intent.js';
import type { AnchorCandidate } from '../model/anchor-candidate.js';
import type { ExpansionBundle } from '../model/constraint-bundle.js';

/**
 * Maximum number of expansion terms (lexical + semantic combined) emitted
 * by a single build() call.
 *
 * Domain rationale: downstream sparse retrieval (BM25-style) degrades when
 * the query becomes too broad — recall improvements taper off past ~8 terms
 * while latency and precision-cost grow linearly. 8 is also the empirical
 * mode observed in our anchor-extraction telemetry for high-confidence
 * query buckets (Korean + ASCII + transliteration variants).
 */
export const MAX_EXPANSION_TERMS = 8;

/**
 * Source-priority ranks used to order expansion terms when multiple lookup
 * strategies surface the same canonical form. Lower rank = higher priority.
 *
 * Ordering rationale:
 * - exact: lossless canonical match, always preferred.
 * - alias: curated mapping (e.g. nicknames), high precision.
 * - transliterated: Korean/script conversion view, lower than alias because
 *   it may collapse distinct entities into a single romanization.
 * - fuzzy: edit-distance / n-gram match, lowest because it can hallucinate.
 * - other / unknown: pushed below all named sources to keep telemetry-only
 *   strategies from leaking into the head of the bundle.
 */
const SOURCE_PRIORITY: Record<string, number> = {
  exact: 0,
  compact_exact: 0,
  alias: 1,
  transliterated: 2,
  fuzzy_char_ngram: 3,
  fuzzy: 3,
};
const SOURCE_PRIORITY_FALLBACK = 99;

function strategyRank(anchor: AnchorCandidate): number {
  const strategies = anchor.lookupStrategies ?? [];
  let best = SOURCE_PRIORITY_FALLBACK;
  for (const s of strategies) {
    const rank = SOURCE_PRIORITY[s];
    if (rank != null && rank < best) {
      best = rank;
    }
  }
  // Source-of-anchor fallback: an anchor with no explicit lookupStrategies
  // but `source === 'alias'` still counts as alias-rank.
  if (best === SOURCE_PRIORITY_FALLBACK && anchor.source === 'alias') {
    best = SOURCE_PRIORITY['alias']!;
  }
  return best;
}

/**
 * Stable ordering for anchors: by (rank ascending, confidence descending,
 * normalizedForm ascending) so that equal-rank ties break deterministically.
 */
function compareAnchors(a: AnchorCandidate, b: AnchorCandidate): number {
  const rankDelta = strategyRank(a) - strategyRank(b);
  if (rankDelta !== 0) return rankDelta;
  const confDelta = b.confidence - a.confidence;
  if (confDelta !== 0) return confDelta;
  if (a.normalizedForm < b.normalizedForm) return -1;
  if (a.normalizedForm > b.normalizedForm) return 1;
  return 0;
}

/**
 * Empty / whitespace-only expansion terms have zero retrieval value and would
 * cause sparse retrieval to OR against the universal set. The builder MUST
 * NOT leak such terms into the bundle even when upstream feeds an empty query
 * or an anchor with a blank `normalizedForm` (degenerate input).
 *
 * `isNonBlankTerm` is the single canonical predicate used by both
 * `dedupAndCap` and `dedupAgainst` to enforce this invariant uniformly.
 */
function isNonBlankTerm(t: string): boolean {
  return t.trim().length > 0;
}

/**
 * Dedup `terms` by case-folded canonical form while preserving the input
 * order. Returns at most `cap` terms. Blank/whitespace-only terms are
 * filtered (see {@link isNonBlankTerm}).
 */
function dedupAndCap(terms: readonly string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of terms) {
    if (out.length >= cap) break;
    if (!isNonBlankTerm(t)) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * Drop terms whose case-folded form already appears in `taken`. Mutates
 * `taken` with the surviving terms' keys. Blank/whitespace-only terms are
 * filtered (see {@link isNonBlankTerm}).
 */
function dedupAgainst(
  terms: readonly string[],
  taken: Set<string>,
  remaining: number,
): string[] {
  const out: string[] = [];
  for (const t of terms) {
    if (out.length >= remaining) break;
    if (!isNonBlankTerm(t)) continue;
    const key = t.toLowerCase();
    if (taken.has(key)) continue;
    taken.add(key);
    out.push(t);
  }
  return out;
}

/**
 * Builds lexical and semantic expansion terms for a query.
 *
 * Expansion terms broaden retrieval coverage beyond the literal query text.
 * The builder selects expansion strategies based on the detected intent and
 * available anchors.
 *
 * Maturity-3 invariants enforced here:
 * - Combined |lexical ∪ semantic| ≤ MAX_EXPANSION_TERMS.
 * - Same canonical form (case-folded) appears at most once across the bundle.
 * - Anchors are emitted in source-priority order
 *   (exact → alias → transliterated → fuzzy → other), with
 *   confidence and normalizedForm as deterministic tie-breakers.
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
    const sortedAnchors = this.sortAnchors(anchors);
    switch (intent) {
      case 'entity_exact':
        return this.buildEntityExactExpansion(sortedAnchors);
      case 'entity_fuzzy':
        return this.buildEntityFuzzyExpansion(normalizedQuery, sortedAnchors);
      case 'facet_search':
      case 'budget_search':
        return this.buildConstraintExpansion(normalizedQuery);
      case 'semantic_discovery':
      case 'pairing_search':
        return this.buildSemanticExpansion(normalizedQuery);
      case 'comparison_search':
        return this.buildComparisonExpansion(sortedAnchors);
      case 'mixed_query':
        return this.buildMixedExpansion(normalizedQuery, sortedAnchors);
    }
  }

  /** Sort anchors by source priority for deterministic emission. */
  private sortAnchors(anchors: readonly AnchorCandidate[]): AnchorCandidate[] {
    return [...anchors].sort(compareAnchors);
  }

  /** Entity-exact queries need only the anchor's normalized form. */
  private buildEntityExactExpansion(
    anchors: readonly AnchorCandidate[],
  ): ExpansionBundle {
    const lexical = dedupAndCap(
      anchors.map((a) => a.normalizedForm),
      MAX_EXPANSION_TERMS,
    );
    return {
      lexical,
      semantic: [],
    };
  }

  /** Entity-fuzzy queries add the full query as a semantic phrase. */
  private buildEntityFuzzyExpansion(
    normalizedQuery: string,
    anchors: readonly AnchorCandidate[],
  ): ExpansionBundle {
    const lexical = dedupAndCap(
      anchors.map((a) => a.normalizedForm),
      MAX_EXPANSION_TERMS,
    );
    const taken = new Set(lexical.map((t) => t.toLowerCase()));
    const remaining = MAX_EXPANSION_TERMS - lexical.length;
    const semantic = dedupAgainst([normalizedQuery], taken, remaining);
    return {
      lexical,
      semantic,
    };
  }

  /** Constraint-based queries use the query tokens as lexical expansions. */
  private buildConstraintExpansion(normalizedQuery: string): ExpansionBundle {
    const tokens = normalizedQuery
      .split(/\s+/)
      .filter((t) => t.length > 1);
    const lexical = dedupAndCap(tokens, MAX_EXPANSION_TERMS);
    return {
      lexical,
      semantic: [],
    };
  }

  /** Semantic queries use the full query for dense retrieval. */
  private buildSemanticExpansion(normalizedQuery: string): ExpansionBundle {
    const semantic = dedupAndCap([normalizedQuery], MAX_EXPANSION_TERMS);
    return {
      lexical: [],
      semantic,
    };
  }

  /** Comparison queries expand each anchor independently. */
  private buildComparisonExpansion(
    anchors: readonly AnchorCandidate[],
  ): ExpansionBundle {
    const lexical = dedupAndCap(
      anchors.map((a) => a.normalizedForm),
      MAX_EXPANSION_TERMS,
    );
    const taken = new Set(lexical.map((t) => t.toLowerCase()));
    const remaining = MAX_EXPANSION_TERMS - lexical.length;
    const semantic = dedupAgainst(
      anchors.map((a) => a.surfaceForm),
      taken,
      remaining,
    );
    return {
      lexical,
      semantic,
    };
  }

  /** Mixed queries combine anchor lexical terms with the full query for semantic. */
  private buildMixedExpansion(
    normalizedQuery: string,
    anchors: readonly AnchorCandidate[],
  ): ExpansionBundle {
    const lexical = dedupAndCap(
      anchors.map((a) => a.normalizedForm),
      MAX_EXPANSION_TERMS,
    );
    const taken = new Set(lexical.map((t) => t.toLowerCase()));
    const remaining = MAX_EXPANSION_TERMS - lexical.length;
    const semantic = dedupAgainst([normalizedQuery], taken, remaining);
    return {
      lexical,
      semantic,
    };
  }
}
