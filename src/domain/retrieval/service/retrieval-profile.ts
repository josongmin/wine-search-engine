/**
 * T4.1: Retrieval profile — channel-aware.
 *
 * RetrievalProfile now includes a channelMix field that explicitly names
 * which RetrievalChannels are active for this profile, replacing the
 * implicit "if anchorWeight > 0 then use anchor" pattern.
 *
 * Existing sparseWeight/denseWeight/anchorWeight fields are preserved for
 * backward compat with fusion.ts until T4.3/T4.4 fully migrate weights.
 */

import type { QueryClass } from '../../shared/types/index.js';
import type { RetrievalChannel } from '../model/retrieval-channel.js';
import { resolveChannelMix, type QueryFamily } from './channel-mix-policy.js';
import { bootstrapLogger } from '../../../config/bootstrap-logger.js';

/**
 * Configuration profile that governs retrieval behaviour for a given
 * query family and route combination.
 */
export interface RetrievalProfile {
  /** Human-readable profile name — must be unique across profiles. */
  readonly name: string;

  /**
   * T4.1: Canonical channels active for this profile.
   * Drives channel dispatch in candidate-pool.ts.
   */
  readonly channelMix: readonly RetrievalChannel[];

  /** Weight assigned to sparse (BM25) hits in the fusion. */
  readonly sparseWeight: number;

  /** Weight assigned to dense (embedding) hits in the fusion. */
  readonly denseWeight: number;

  /** Weight assigned to anchor-neighbourhood hits in the fusion. */
  readonly anchorWeight: number;

  /** Maximum number of sparse hits to retrieve. */
  readonly sparseTopN: number;

  /** Maximum number of dense hits to retrieve. */
  readonly denseTopN: number;

  /** RRF smoothing constant k. */
  readonly fusionK: number;

  /** Final top-K candidates to emit after fusion and filtering. */
  readonly finalTopK: number;
}

// ---------------------------------------------------------------------------
// Profile definitions
// ---------------------------------------------------------------------------

/** Default profile for hybrid retrieval without an anchor. */
const HYBRID_DEFAULT: RetrievalProfile = {
  name: 'hybrid_default',
  channelMix: ['sparse_bm25', 'dense_semantic'],
  sparseWeight: 0.5,
  denseWeight: 0.5,
  anchorWeight: 0,
  sparseTopN: 100,
  denseTopN: 100,
  fusionK: 60,
  finalTopK: 200,
} as const;

/** Profile for anchor-based ("wines like X") queries. */
const MIXED_ANCHOR: RetrievalProfile = {
  name: 'mixed_anchor',
  channelMix: ['sparse_bm25', 'dense_semantic', 'anchor_similarity'],
  sparseWeight: 0.3,
  denseWeight: 0.3,
  anchorWeight: 0.4,
  sparseTopN: 80,
  denseTopN: 80,
  fusionK: 60,
  finalTopK: 200,
} as const;

/** Conservative fallback for exact / short-entity queries. */
const EXACT_SAFE_FALLBACK: RetrievalProfile = {
  name: 'exact_safe_fallback',
  channelMix: ['sparse_bm25', 'dense_semantic'],
  sparseWeight: 0.7,
  denseWeight: 0.3,
  anchorWeight: 0,
  sparseTopN: 150,
  denseTopN: 50,
  fusionK: 60,
  finalTopK: 100,
} as const;

/**
 * T4.1: Profile for producer browse queries.
 * Lean on sparse to match producer names; no anchor neighborhood.
 */
const BROWSE_DEFAULT: RetrievalProfile = {
  name: 'browse_default',
  channelMix: ['sparse_bm25', 'dense_semantic', 'browse_producer'],
  sparseWeight: 0.65,
  denseWeight: 0.35,
  anchorWeight: 0,
  sparseTopN: 120,
  denseTopN: 80,
  fusionK: 60,
  finalTopK: 150,
} as const;

/**
 * Profile for region browse queries.
 * Lean on sparse to match region names; includes browse_region channel.
 */
const REGION_BROWSE: RetrievalProfile = {
  name: 'region_browse',
  channelMix: ['sparse_bm25', 'dense_semantic', 'browse_region'],
  sparseWeight: 0.65,
  denseWeight: 0.35,
  anchorWeight: 0,
  sparseTopN: 120,
  denseTopN: 80,
  fusionK: 60,
  finalTopK: 150,
} as const;

/**
 * T4.1: Profile for comparison queries.
 * Dense-heavy to surface similar candidates around anchor.
 */
const COMPARE_DEFAULT: RetrievalProfile = {
  name: 'compare_default',
  channelMix: ['sparse_bm25', 'dense_semantic', 'compare_anchor'],
  sparseWeight: 0.3,
  denseWeight: 0.5,
  anchorWeight: 0.2,
  sparseTopN: 60,
  denseTopN: 100,
  fusionK: 60,
  finalTopK: 80,
} as const;

/**
 * T4.3: Profile for learned-sparse hybrid retrieval (SPLADE + BM25 + dense).
 *
 * Activates the `learned_sparse` channel alongside BM25 and dense ANN.
 * Used when `retrievalMode === 'learned_sparse'` or when the query class
 * signals deep semantic intent (e.g. `semantic_preference`).
 */
const LEARNED_SPARSE_HYBRID: RetrievalProfile = {
  name: 'learned_sparse_hybrid',
  channelMix: ['sparse_bm25', 'learned_sparse', 'dense_semantic'],
  sparseWeight: 0.35,
  denseWeight: 0.45,
  anchorWeight: 0,
  sparseTopN: 100,
  denseTopN: 100,
  fusionK: 60,
  finalTopK: 200,
} as const;

/**
 * T4.5: Profile for anchor-conditioned relative queries.
 * Sparse BM25 surfaces the initial candidate pool; relative_filter then
 * post-filters to candidates sharing key attributes with the anchor
 * (region, grape, style).  No dense ANN or anchor-ANN pass is needed
 * because the post-filter provides the attribute-match signal.
 */
const RELATIVE_FILTER: RetrievalProfile = {
  name: 'relative_filter',
  channelMix: ['sparse_bm25', 'relative_filter'],
  sparseWeight: 1.0,
  denseWeight: 0,
  anchorWeight: 0,
  sparseTopN: 150,
  denseTopN: 0,
  fusionK: 60,
  finalTopK: 80,
} as const;

function isLegacyHeuristicRetrievalMode(retrievalMode: string): boolean {
  return retrievalMode === 'semantic_hybrid' || retrievalMode === 'hybrid_search';
}

// ---------------------------------------------------------------------------
// Profile service
// ---------------------------------------------------------------------------

/**
 * E2-U1 Lane Capability Inventory
 *
 * RetrievalProfileService.getProfile() decision inputs (highest → lowest priority):
 *
 *  1. retrievalMode   — explicit execution-contract signal (from EngineExecutionContract)
 *                       covers: learned_sparse, producer_browse, region_browse,
 *                       compare_candidates, relative, recommendation
 *  2. queryFamily     — semantic classification from QueryObservabilityVocab
 *                       covers: comparison, recommendation, pairing, entity_exact,
 *                       producer_browse, region_browse, entity_resolution, …
 *  3. route+queryClass — legacy heuristic fallback
 *                       covers: mixed → MIXED_ANCHOR, short_entity/ambiguous → EXACT_SAFE_FALLBACK
 *
 * Decision outputs (per lane):
 *  - channelMix       — ordered list of active retrieval channels
 *  - sparseWeight / denseWeight / anchorWeight  — fusion blend weights
 *  - sparseTopN / denseTopN  — per-channel candidate budget
 *  - finalTopK        — post-fusion candidate ceiling
 *
 * Specialised retrieval modes (producer_browse / region_browse /
 * compare_candidates) are dispatched upstream in
 * search-usecase-hybrid-candidates.ts via
 * compiled.execution.effectiveRetrievalMode — they do NOT flow through this
 * profile service.
 */

/**
 * Selects the appropriate {@link RetrievalProfile} based on query class,
 * execution route, and T4.1 retrieval mode awareness.
 */
export class RetrievalProfileService {
  /**
   * Resolve a retrieval profile for the given query class and route.
   *
   * T4.1: Added retrievalMode parameter for mode-aware profile selection.
   * T4.6: Added queryFamily parameter for family-level channel mix policy.
   *
   * Priority order (highest → lowest):
   *  1. retrievalMode override (explicit execution-contract signal)
   *  2. queryFamily policy (semantic classification from observability vocab)
   *  3. route / queryClass heuristics (legacy fallback)
   *
   * Existing callers passing only queryClass+route get the same profile as before.
   *
   * @param queryClass - The classification of the user query.
   * @param route - The execution route ('hybrid', 'mixed').
   * @param retrievalMode - Optional mode for fine-grained profile selection.
   * @param queryFamily - Optional family label for T4.6 policy-driven selection.
   */
  getProfile(
    queryClass: QueryClass,
    route: string,
    retrievalMode?: string,
    queryFamily?: QueryFamily,
  ): RetrievalProfile {
    // T4.6: Query family policy — defers to family mapping when no explicit
    // retrievalMode is set, so that mode overrides always take precedence.
    if (queryFamily !== undefined && retrievalMode === undefined) {
      const decision = resolveChannelMix(queryFamily, route);
      switch (decision.profileName) {
        case 'compare_default':    return COMPARE_DEFAULT;
        case 'mixed_anchor':       return MIXED_ANCHOR;
        case 'browse_default':     return BROWSE_DEFAULT;
        case 'region_browse':      return REGION_BROWSE;
        case 'exact_safe_fallback': return EXACT_SAFE_FALLBACK;
        case 'relative_filter':    return RELATIVE_FILTER;
        case 'hybrid_default':     return HYBRID_DEFAULT;
        // No default: fall through to legacy heuristics for unrecognised profiles
      }
    }

    // Mode-aware selection (T4.1 / T4.3 / T4.5)
    // retrievalMode can be an ExecutionRetrievalMode string OR the internal runtime
    // value 'relative', which CandidatePoolService.resolveRuntimeRetrievalMode() emits
    // when compare_candidates + an anchor entity are both present.
    // NOTE: 'learned_sparse' is a RetrievalChannel string, NOT a valid ExecutionRetrievalMode
    // or runtime mode value — LEARNED_SPARSE_HYBRID is reached only via the
    // queryClass === 'semantic_preference' branch below, or via queryFamily policy.
    if (retrievalMode !== undefined) {
      const useLegacyHeuristics = isLegacyHeuristicRetrievalMode(retrievalMode);
      const normalizedRetrievalMode =
        useLegacyHeuristics ? undefined : retrievalMode;
      if (normalizedRetrievalMode === undefined) {
        // Legacy V1 aliases like semantic_hybrid/hybrid_search intentionally
        // fall through to the queryClass/route heuristics below.
      } else
      if (normalizedRetrievalMode === 'entity_lookup' || normalizedRetrievalMode === 'entity_resolution') {
        return EXACT_SAFE_FALLBACK;
      } else if (normalizedRetrievalMode === 'attribute_search' || normalizedRetrievalMode === 'constraint_filter') {
        return HYBRID_DEFAULT;
      } else if (normalizedRetrievalMode === 'producer_browse') {
        return BROWSE_DEFAULT;
      } else if (normalizedRetrievalMode === 'region_browse') {
        return REGION_BROWSE;
      } else if (normalizedRetrievalMode === 'compare_candidates') {
        return COMPARE_DEFAULT;
      // 'relative' is an internal runtime mode emitted by CandidatePoolService when
      // compare_candidates has an anchor entity; routes to the sparse-only post-filter path.
      } else if (normalizedRetrievalMode === 'relative') {
        return RELATIVE_FILTER;
      // recommendation mode uses anchor_similarity channel (aligns with FAMILY_POLICY mapping)
      } else if (normalizedRetrievalMode === 'recommendation') {
        return MIXED_ANCHOR;
      } else if (normalizedRetrievalMode === 'similar_items') {
        return MIXED_ANCHOR;
      } else if (normalizedRetrievalMode === 'no_match_detection') {
        return HYBRID_DEFAULT;
      }

      // If none of the above matched, log to catch unrecognized modes
      if (!useLegacyHeuristics) {
        bootstrapLogger.warn(
          { retrievalMode },
          '[RetrievalProfileService] Unrecognized retrievalMode; falling through to queryClass heuristics',
        );
      }
    }

    // T4.3: Deep semantic queries benefit from learned sparse channel
    if (queryClass === 'semantic_preference') {
      return LEARNED_SPARSE_HYBRID;
    }

    // Anchor-bearing routes get the mixed anchor profile
    if (route === 'mixed') {
      return MIXED_ANCHOR;
    }

    // Exact entity lookups use the conservative fallback
    if (queryClass === 'short_entity' || queryClass === 'ambiguous_short_form') {
      return EXACT_SAFE_FALLBACK;
    }

    return HYBRID_DEFAULT;
  }

  /**
   * T4.1: Get the channel mix for a given profile directly.
   * T4.6: Accepts optional queryFamily for policy-driven channel selection.
   * Convenience method for dispatch logic that only needs channel names.
   */
  getChannelMix(
    queryClass: QueryClass,
    route: string,
    retrievalMode?: string,
    queryFamily?: QueryFamily,
  ): readonly RetrievalChannel[] {
    return this.getProfile(queryClass, route, retrievalMode, queryFamily).channelMix;
  }

}
