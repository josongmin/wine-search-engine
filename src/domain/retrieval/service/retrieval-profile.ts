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
import { DomainError } from '../../shared/error/domain-error.js';
import {
  RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY,
  RETRIEVAL_CHANNEL_BROWSE_PRODUCER,
  RETRIEVAL_CHANNEL_BROWSE_REGION,
  RETRIEVAL_CHANNEL_COMPARE_ANCHOR,
  RETRIEVAL_CHANNEL_DENSE_SEMANTIC,
  RETRIEVAL_CHANNEL_LEARNED_SPARSE,
  RETRIEVAL_CHANNEL_RELATIVE_FILTER,
  RETRIEVAL_CHANNEL_SPARSE_BM25,
  type RetrievalChannel,
} from '../model/retrieval-channel.js';
import { resolveChannelMix, type QueryFamily } from './channel-mix-policy.js';
import { RRF_DEFAULT_K } from '../../shared/utils/rrf.js';

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

  /**
   * Optional weight assigned to learned-sparse (SPLADE) hits in the fusion.
   *
   * Profiles that activate the `learned_sparse` channel MUST set this so the
   * 4-way sum (sparse + dense + anchor + learnedSparse) equals 1.0 — that
   * invariant is what {@link validateRetrievalProfile} enforces at module
   * load time. Profiles that do not include the `learned_sparse` channel
   * omit this field entirely (treated as 0 in the invariant check).
   *
   * NOTE: The runtime fusion path in `fusion.ts` reads its learned-sparse
   * weight from `per-class-fusion-config.ts` (FusionConfig.learnedSparseWeight),
   * NOT from this field. This profile field exists for invariant declaration
   * and observability — keep both registries in sync intentionally.
   */
  readonly learnedSparseWeight?: number;

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
  channelMix: [RETRIEVAL_CHANNEL_SPARSE_BM25, RETRIEVAL_CHANNEL_DENSE_SEMANTIC],
  sparseWeight: 0.5,
  denseWeight: 0.5,
  anchorWeight: 0,
  sparseTopN: 100,
  denseTopN: 100,
  fusionK: RRF_DEFAULT_K,
  finalTopK: 200,
} as const;

/** Profile for anchor-based ("wines like X") queries. */
const MIXED_ANCHOR: RetrievalProfile = {
  name: 'mixed_anchor',
  channelMix: [RETRIEVAL_CHANNEL_SPARSE_BM25, RETRIEVAL_CHANNEL_DENSE_SEMANTIC, RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY],
  sparseWeight: 0.3,
  denseWeight: 0.3,
  anchorWeight: 0.4,
  sparseTopN: 80,
  denseTopN: 80,
  fusionK: RRF_DEFAULT_K,
  finalTopK: 200,
} as const;

/**
 * Recommendation-only profile.
 *
 * Keeps the same mixed anchor channel semantics as MIXED_ANCHOR, but narrows
 * per-channel fanout and final candidate volume for broad recommendation
 * queries where the agent usually surfaces only 2-3 wines. This reduces
 * retrieval wall without changing the route or channel family.
 */
const RECOMMENDATION_ANCHOR: RetrievalProfile = {
  name: 'recommendation_anchor',
  channelMix: [RETRIEVAL_CHANNEL_SPARSE_BM25, RETRIEVAL_CHANNEL_DENSE_SEMANTIC, RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY],
  sparseWeight: 0.3,
  denseWeight: 0.3,
  anchorWeight: 0.4,
  sparseTopN: 48,
  denseTopN: 48,
  fusionK: RRF_DEFAULT_K,
  finalTopK: 120,
} as const;

/** Conservative fallback for exact / short-entity queries. */
const EXACT_SAFE_FALLBACK: RetrievalProfile = {
  name: 'exact_safe_fallback',
  channelMix: [RETRIEVAL_CHANNEL_SPARSE_BM25, RETRIEVAL_CHANNEL_DENSE_SEMANTIC],
  sparseWeight: 0.7,
  denseWeight: 0.3,
  anchorWeight: 0,
  sparseTopN: 150,
  denseTopN: 50,
  fusionK: RRF_DEFAULT_K,
  finalTopK: 100,
} as const;

/**
 * TRACK-A A4: Entity-anchor-first profile for exact_entity / short_entity
 * queries WHERE a resolved anchor is present.
 *
 * Channel mix: anchor_similarity fires FIRST (highest RRF weight), BM25
 * provides a precision backstop, dense_semantic is kept but damped so the
 * anchor entity is never buried by semantic neighbours.
 *
 * Profile constants (no magic numbers — mirrors FUSION_ENTITY_EXACT rationale):
 *   anchorWeight dominant: the planner resolved the entity, anchor channel
 *     must win the fusion to surface the exact entity at rank 1.
 *   sparseTopN / denseTopN conservative: this is a precision-first path —
 *     we do not need wide recall; 50/30 caps avoid unnecessary Vespa cost.
 *   finalTopK 50: entity lookups expect a tight, ranked short-list.
 */

/** Top-N sparse hits for anchor-first entity paths: precision-first, not recall. */
const ENTITY_ANCHOR_FIRST_SPARSE_TOP_N = 50;
/** Top-N dense hits for anchor-first entity paths. */
const ENTITY_ANCHOR_FIRST_DENSE_TOP_N = 30;
/** Final candidate ceiling after fusion for anchor-first entity paths. */
const ENTITY_ANCHOR_FIRST_FINAL_TOP_K = 50;

const ENTITY_ANCHOR_FIRST: RetrievalProfile = {
  name: 'entity_anchor_first',
  channelMix: [RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY, RETRIEVAL_CHANNEL_SPARSE_BM25, RETRIEVAL_CHANNEL_DENSE_SEMANTIC],
  sparseWeight: 0.3,
  denseWeight: 0.1,
  anchorWeight: 0.6,
  sparseTopN: ENTITY_ANCHOR_FIRST_SPARSE_TOP_N,
  denseTopN: ENTITY_ANCHOR_FIRST_DENSE_TOP_N,
  fusionK: RRF_DEFAULT_K,
  finalTopK: ENTITY_ANCHOR_FIRST_FINAL_TOP_K,
} as const;

/**
 * T4.1: Profile for producer browse queries.
 * Lean on sparse to match producer names; no anchor neighborhood.
 */
const BROWSE_DEFAULT: RetrievalProfile = {
  name: 'browse_default',
  channelMix: [RETRIEVAL_CHANNEL_SPARSE_BM25, RETRIEVAL_CHANNEL_DENSE_SEMANTIC, RETRIEVAL_CHANNEL_BROWSE_PRODUCER],
  sparseWeight: 0.65,
  denseWeight: 0.35,
  anchorWeight: 0,
  sparseTopN: 120,
  denseTopN: 80,
  fusionK: RRF_DEFAULT_K,
  finalTopK: 150,
} as const;

/**
 * Profile for region browse queries.
 * Lean on sparse to match region names; includes browse_region channel.
 */
const REGION_BROWSE: RetrievalProfile = {
  name: 'region_browse',
  channelMix: [RETRIEVAL_CHANNEL_SPARSE_BM25, RETRIEVAL_CHANNEL_DENSE_SEMANTIC, RETRIEVAL_CHANNEL_BROWSE_REGION],
  sparseWeight: 0.65,
  denseWeight: 0.35,
  anchorWeight: 0,
  sparseTopN: 120,
  denseTopN: 80,
  fusionK: RRF_DEFAULT_K,
  finalTopK: 150,
} as const;

/**
 * T4.1: Profile for comparison queries.
 * Dense-heavy to surface similar candidates around anchor.
 */
const COMPARE_DEFAULT: RetrievalProfile = {
  name: 'compare_default',
  channelMix: [RETRIEVAL_CHANNEL_SPARSE_BM25, RETRIEVAL_CHANNEL_DENSE_SEMANTIC, RETRIEVAL_CHANNEL_COMPARE_ANCHOR],
  sparseWeight: 0.3,
  denseWeight: 0.5,
  anchorWeight: 0.2,
  sparseTopN: 60,
  denseTopN: 100,
  fusionK: RRF_DEFAULT_K,
  finalTopK: 80,
} as const;

/**
 * T4.3: Profile for learned-sparse hybrid retrieval (SPLADE + BM25 + dense).
 *
 * Activates the `learned_sparse` channel alongside BM25 and dense ANN.
 * Used when `retrievalMode === RETRIEVAL_CHANNEL_LEARNED_SPARSE` or when the query class
 * signals deep semantic intent (e.g. `semantic_preference`).
 */
const LEARNED_SPARSE_HYBRID: RetrievalProfile = {
  name: 'learned_sparse_hybrid',
  channelMix: [RETRIEVAL_CHANNEL_SPARSE_BM25, RETRIEVAL_CHANNEL_LEARNED_SPARSE, RETRIEVAL_CHANNEL_DENSE_SEMANTIC],
  sparseWeight: 0.35,
  denseWeight: 0.45,
  anchorWeight: 0,
  // 4-way sum: 0.35 + 0.45 + 0 + 0.20 = 1.0 (validated by validateRetrievalProfile).
  // learned_sparse channel claims the remaining 0.20 budget so the SPLADE lane
  // is explicitly weighted instead of silently absorbed by the lexical-family
  // collapse in fusion.ts.
  learnedSparseWeight: 0.20,
  sparseTopN: 100,
  denseTopN: 100,
  fusionK: RRF_DEFAULT_K,
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
  name: RETRIEVAL_CHANNEL_RELATIVE_FILTER,
  channelMix: [RETRIEVAL_CHANNEL_SPARSE_BM25, RETRIEVAL_CHANNEL_RELATIVE_FILTER],
  sparseWeight: 1.0,
  denseWeight: 0,
  anchorWeight: 0,
  sparseTopN: 150,
  denseTopN: 0,
  fusionK: RRF_DEFAULT_K,
  finalTopK: 80,
} as const;

// ---------------------------------------------------------------------------
// Profile weight invariant
// ---------------------------------------------------------------------------

/**
 * Tolerance for the 4-way weight sum invariant.
 *
 * Profile weights are authored as decimal literals (0.35, 0.45, …), and IEEE-754
 * addition of those literals routinely produces sums that differ from 1.0 by a
 * few ULPs (e.g. 0.1 + 0.2 = 0.30000000000000004). 1e-6 is loose enough to
 * absorb that floating-point noise without admitting a real miscalibration.
 */
export const RETRIEVAL_PROFILE_WEIGHT_SUM_EPSILON = 1e-6;

/**
 * Validate that a {@link RetrievalProfile}'s lane weights are well-formed.
 *
 * Invariants:
 *   1. Each of sparseWeight / denseWeight / anchorWeight / learnedSparseWeight
 *      (treating omitted learnedSparseWeight as 0) is a finite non-negative
 *      number.
 *   2. The 4-way sum equals 1.0 within {@link RETRIEVAL_PROFILE_WEIGHT_SUM_EPSILON}.
 *
 * Throws {@link DomainError} with code `INTERNAL_INCONSISTENCY` on violation
 * so misconfigured profiles surface at module load (via the IIFE below) rather
 * than corrupting fusion silently.
 */
export function validateRetrievalProfile(
  profile: RetrievalProfile,
  profileName?: string,
): void {
  const label = profileName ?? profile.name;
  const learnedSparseWeight = profile.learnedSparseWeight ?? 0;
  const lanes: ReadonlyArray<readonly [string, number]> = [
    ['sparseWeight', profile.sparseWeight],
    ['denseWeight', profile.denseWeight],
    ['anchorWeight', profile.anchorWeight],
    ['learnedSparseWeight', learnedSparseWeight],
  ];
  for (const [name, w] of lanes) {
    if (!Number.isFinite(w) || w < 0) {
      throw new DomainError(
        'INTERNAL_INCONSISTENCY',
        `RetrievalProfile "${label}": ${name} must be a finite non-negative number, got ${w}`,
      );
    }
  }
  const sum =
    profile.sparseWeight +
    profile.denseWeight +
    profile.anchorWeight +
    learnedSparseWeight;
  if (Math.abs(sum - 1.0) > RETRIEVAL_PROFILE_WEIGHT_SUM_EPSILON) {
    throw new DomainError(
      'INTERNAL_INCONSISTENCY',
      `RetrievalProfile "${label}": lane weights must sum to 1.0 ± ${RETRIEVAL_PROFILE_WEIGHT_SUM_EPSILON}, got ${sum} ` +
        `(sparse=${profile.sparseWeight}, dense=${profile.denseWeight}, anchor=${profile.anchorWeight}, learnedSparse=${learnedSparseWeight})`,
    );
  }
}

/**
 * Every profile defined above is validated at module-load time. A miscalibrated
 * profile (e.g. weights summing to 0.8) will throw immediately on first import,
 * preventing the rest of the retrieval pipeline from booting with invalid
 * weight invariants.
 */
const ALL_DEFINED_PROFILES: readonly RetrievalProfile[] = [
  HYBRID_DEFAULT,
  MIXED_ANCHOR,
  RECOMMENDATION_ANCHOR,
  EXACT_SAFE_FALLBACK,
  ENTITY_ANCHOR_FIRST,
  BROWSE_DEFAULT,
  REGION_BROWSE,
  COMPARE_DEFAULT,
  LEARNED_SPARSE_HYBRID,
  RELATIVE_FILTER,
];

(() => {
  for (const profile of ALL_DEFINED_PROFILES) {
    validateRetrievalProfile(profile);
  }
})();

function isLegacyHeuristicRetrievalMode(retrievalMode: string): boolean {
  return retrievalMode === 'semantic_hybrid' || retrievalMode === 'hybrid_search';
}

function throwUnknownRetrievalMode(retrievalMode: string): never {
  throw new DomainError(
    'INTERNAL_INCONSISTENCY',
    `Unknown retrievalMode: ${retrievalMode}`,
  );
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
  private resolveExecutionProfile(
    queryClass: QueryClass,
    route: string,
    retrievalMode?: string,
  ): RetrievalProfile {
    // Mode-aware selection (T4.1 / T4.3 / T4.5)
    // retrievalMode can be an ExecutionRetrievalMode string OR the internal runtime
    // value 'relative', which CandidatePoolService.resolveRuntimeRetrievalMode() emits
    // when compare_candidates + an anchor entity are both present.
    // NOTE: RETRIEVAL_CHANNEL_LEARNED_SPARSE is a RetrievalChannel string, NOT a valid ExecutionRetrievalMode
    // or runtime mode value — LEARNED_SPARSE_HYBRID is reached only via the
    // queryClass === 'semantic_preference' branch below, or via queryFamily policy.
    if (retrievalMode !== undefined) {
      if (isLegacyHeuristicRetrievalMode(retrievalMode)) {
        // Legacy V1 aliases like semantic_hybrid/hybrid_search intentionally
        // fall through to the queryClass/route heuristics below.
      } else if (retrievalMode === 'entity_anchor_first') {
        // TRACK-A A4: exact_entity / short_entity with resolved anchor — anchor leads.
        return ENTITY_ANCHOR_FIRST;
      } else if (retrievalMode === 'entity_lookup' || retrievalMode === 'entity_resolution') {
        return EXACT_SAFE_FALLBACK;
      } else if (retrievalMode === 'attribute_search' || retrievalMode === 'constraint_filter') {
        return HYBRID_DEFAULT;
      } else if (retrievalMode === 'producer_browse') {
        return BROWSE_DEFAULT;
      } else if (retrievalMode === 'region_browse') {
        return REGION_BROWSE;
      } else if (retrievalMode === 'compare_candidates') {
        return COMPARE_DEFAULT;
      // 'relative' is an internal runtime mode emitted by CandidatePoolService when
      // compare_candidates has an anchor entity; routes to the sparse-only post-filter path.
      } else if (retrievalMode === 'relative') {
        return RELATIVE_FILTER;
      // recommendation mode uses anchor_similarity channel (aligns with FAMILY_POLICY mapping)
      } else if (retrievalMode === 'recommendation') {
        return RECOMMENDATION_ANCHOR;
      } else if (retrievalMode === 'similar_items') {
        return MIXED_ANCHOR;
      } else if (retrievalMode === 'no_match_detection') {
        return HYBRID_DEFAULT;
      } else {
        // Unknown retrieval modes are not coerced to a heuristic fallback.
        throwUnknownRetrievalMode(retrievalMode);
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
    if (queryClass === 'exact_entity' || queryClass === 'short_entity' || queryClass === 'ambiguous_short_form') {
      return EXACT_SAFE_FALLBACK;
    }

    return HYBRID_DEFAULT;
  }

  /**
   * Resolve a retrieval profile for the given query class and route.
   *
   * T4.1: Added retrievalMode parameter for mode-aware profile selection.
   * T4.6: Added queryFamily parameter for family-level channel mix policy.
   *
   * Priority order (highest → lowest):
   *  1. retrievalMode override (explicit execution-contract signal)
   *  2. queryFamily policy (semantic classification from observability vocab)
   *  3. route / queryClass heuristics (only when retrievalMode is absent or legacy)
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
      const decision = resolveChannelMix(queryFamily);
      switch (decision.profileName) {
        case 'compare_default':       return COMPARE_DEFAULT;
        case 'mixed_anchor':          return MIXED_ANCHOR;
        case 'recommendation_anchor': return RECOMMENDATION_ANCHOR;
        case 'browse_default':        return BROWSE_DEFAULT;
        case 'region_browse':         return REGION_BROWSE;
        case 'exact_safe_fallback':   return EXACT_SAFE_FALLBACK;
        case 'entity_anchor_first':   return ENTITY_ANCHOR_FIRST;
        case RETRIEVAL_CHANNEL_RELATIVE_FILTER:       return RELATIVE_FILTER;
        case 'hybrid_default':        return HYBRID_DEFAULT;
        // No default: fall through to legacy heuristics for unrecognised profiles
      }
    }

    return this.resolveExecutionProfile(queryClass, route, retrievalMode);
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

  /**
   * Resolve the runtime execution profile from compiled route/mode facts only.
   *
   * Unlike {@link getProfile}, this path intentionally ignores query-family
   * policy overlays so consumers can mirror the concrete execution profile
   * chosen by the compiled/runtime contract.
   */
  getExecutionProfile(
    queryClass: QueryClass,
    route: string,
    retrievalMode?: string,
  ): RetrievalProfile {
    return this.resolveExecutionProfile(queryClass, route, retrievalMode);
  }

  /**
   * Convenience accessor for runtime execution channel mix.
   */
  getExecutionChannelMix(
    queryClass: QueryClass,
    route: string,
    retrievalMode?: string,
  ): readonly RetrievalChannel[] {
    return this.getExecutionProfile(queryClass, route, retrievalMode).channelMix;
  }

}
