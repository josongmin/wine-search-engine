/**
 * T4.6: Channel mix policy — query family → retrieval profile mapping.
 *
 * Maps a QueryFamilyLabel (from observability vocab) to a recommended
 * channel mix. This is a POLICY layer — retrieval-profile.ts owns the
 * actual profile objects; this file owns the mapping from semantic query
 * classification → profile selection.
 *
 * Design notes:
 *  - `QUERY_FAMILY_LABELS` is the single source of truth for family names.
 *  - The mapping is exhaustive: every label is handled explicitly.
 *  - `resolveChannelMix()` is pure (no I/O, no side effects).
 */

import type { RetrievalChannel } from '../model/retrieval-channel.js';
import { QUERY_FAMILY_LABELS } from '../../query/model/query-observability-vocab.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single query family label from the observability vocabulary. */
export type QueryFamily = (typeof QUERY_FAMILY_LABELS)[number];

/**
 * The result of a channel mix policy decision.
 * Consumers should use `channelMix` for dispatch and `reason` for tracing.
 */
export interface ChannelMixDecision {
  /** The human-readable profile name that was selected. */
  readonly profileName: string;

  /** The ordered list of channels to activate for this query. */
  readonly channelMix: readonly RetrievalChannel[];

  /** Brief rationale — for trace/debug only, not used in dispatch. */
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Internal profile descriptors
// (Mirror of the profile shapes in retrieval-profile.ts.  We reference only
//  name + channelMix here to avoid a circular dependency on the profile
//  service.)
// ---------------------------------------------------------------------------

const PROFILE_CHANNEL_MIXES = {
  hybrid_default: ['sparse_bm25', 'dense_semantic'] as const,
  mixed_anchor: ['sparse_bm25', 'dense_semantic', 'anchor_similarity'] as const,
  compare_default: ['sparse_bm25', 'dense_semantic', 'compare_anchor'] as const,
  // browse_default activates browse_producer so producer-browse dispatch is visible
  // in ChannelMixDecision.channelMix (mirrors the BROWSE_DEFAULT profile object).
  browse_default: ['sparse_bm25', 'dense_semantic', 'browse_producer'] as const,
  // region_browse activates browse_region — distinct from producer browse.
  region_browse: ['sparse_bm25', 'dense_semantic', 'browse_region'] as const,
  exact_safe_fallback: ['sparse_bm25', 'dense_semantic'] as const,
  relative_filter: ['sparse_bm25', 'relative_filter'] as const,
} as const satisfies Record<string, readonly RetrievalChannel[]>;

type ProfileName = keyof typeof PROFILE_CHANNEL_MIXES;

// ---------------------------------------------------------------------------
// Policy mapping
// ---------------------------------------------------------------------------

/**
 * Maps every QueryFamily label to a profile name and brief reason.
 *
 * Ordering follows semantic similarity:
 *  1. Anchor/comparison families — specialised anchor channels
 *  2. Exact / entity families — conservative sparse-heavy fallback
 *  3. Browse families — sparse-heavy browse profile
 *  4. Residual / unknown — generic hybrid
 */
const FAMILY_POLICY: Record<QueryFamily, { profile: ProfileName; reason: string }> = {
  // Comparison queries need a dedicated compare-anchor channel to surface
  // candidates that are similar to (but distinct from) the anchor wine.
  comparison: {
    profile: 'compare_default',
    reason: 'comparison family → compare_anchor channel for side-by-side candidates',
  },

  // Recommendation queries share the anchor-similarity approach: find wines
  // near the implicit anchor (user history / stated reference wine).
  recommendation: {
    profile: 'mixed_anchor',
    reason: 'recommendation family → anchor_similarity channel for neighbourhood retrieval',
  },

  // Pairing queries are anchor-conditioned: the food item is the anchor and
  // we retrieve wines similar to known good pairings.
  pairing: {
    profile: 'mixed_anchor',
    reason: 'pairing family → anchor_similarity channel anchored on food entity',
  },

  // Multi-intent queries cannot be pre-committed to a single anchor channel;
  // full hybrid gives the broadest coverage.
  multi_intent: {
    profile: 'hybrid_default',
    reason: 'multi_intent family → full hybrid for broadest intent coverage',
  },

  // Attribute-constrained queries benefit from hybrid; BM25 matches field
  // terms precisely while dense catches paraphrases.
  attribute_constrained: {
    profile: 'hybrid_default',
    reason: 'attribute_constrained family → hybrid for term + semantic coverage',
  },

  // Entity resolution (fuzzy / semantic discovery) needs both channels to
  // handle spelling variation and conceptual drift.
  entity_resolution: {
    profile: 'hybrid_default',
    reason: 'entity_resolution family → hybrid to handle fuzzy entity matching',
  },

  // Entity fuzzy: sparse gives exact-ish term matches; dense handles minor
  // spelling variation.  Hybrid, not anchor.
  entity_fuzzy: {
    profile: 'hybrid_default',
    reason: 'entity_fuzzy family → hybrid for spelling-variation tolerance',
  },

  // Exact lookups and known items: BM25-heavy, conservative recall ceiling.
  entity_exact: {
    profile: 'exact_safe_fallback',
    reason: 'entity_exact family → exact_safe_fallback for precision-first retrieval',
  },

  // Browse families: BM25-heavy to match producer/region name tokens.
  producer_browse: {
    profile: 'browse_default',
    reason: 'producer_browse family → browse_default (sparse-heavy) for producer names',
  },

  region_browse: {
    profile: 'region_browse',
    reason: 'region_browse family → region_browse profile (browse_region channel) for region names',
  },

  // No-match / ambiguous / unknown: fall back to generic hybrid.
  no_match: {
    profile: 'hybrid_default',
    reason: 'no_match family → hybrid default (safe fallback)',
  },

  ambiguous: {
    profile: 'hybrid_default',
    reason: 'ambiguous family → hybrid default for maximum recall',
  },

  unknown: {
    profile: 'hybrid_default',
    reason: 'unknown family → hybrid default (catch-all)',
  },
} as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a channel mix policy decision for a given query family.
 *
 * The `route` and `retrievalMode` parameters are accepted for future
 * override hooks (e.g., force a specific profile for a given route)
 * but do not yet alter the mapping — the family label is the primary
 * driver.
 *
 * @param queryFamily    - Bucketed family label from observability vocab.
 * @param route          - Execution route (e.g. 'hybrid', 'mixed').
 * @param retrievalMode  - Optional execution retrieval mode for future overrides.
 * @returns              A {@link ChannelMixDecision} with profile name, channels, and reason.
 */
export function resolveChannelMix(
  queryFamily: QueryFamily,
  route: string,
  retrievalMode?: string,
): ChannelMixDecision {
  // Future: route/mode-specific overrides can be inserted here before
  // falling through to the family policy map.
  void route;
  void retrievalMode;

  const policy = FAMILY_POLICY[queryFamily];
  return {
    profileName: policy.profile,
    channelMix: PROFILE_CHANNEL_MIXES[policy.profile],
    reason: policy.reason,
  };
}
