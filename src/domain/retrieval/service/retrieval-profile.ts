import type { QueryClass } from '../../shared/types/index.js';

/**
 * Configuration profile that governs retrieval behaviour for a given
 * query class and route combination.
 */
export interface RetrievalProfile {
  /** Human-readable profile name. */
  readonly name: string;

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

/** Default profile for hybrid retrieval without an anchor. */
const HYBRID_DEFAULT: RetrievalProfile = {
  name: 'hybrid_default',
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
  sparseWeight: 0.7,
  denseWeight: 0.3,
  anchorWeight: 0,
  sparseTopN: 150,
  denseTopN: 50,
  fusionK: 60,
  finalTopK: 100,
} as const;

/**
 * Selects the appropriate {@link RetrievalProfile} based on query class
 * and execution route.
 */
export class RetrievalProfileService {
  /**
   * Resolve a retrieval profile for the given query class and route.
   *
   * @param queryClass - The classification of the user query.
   * @param route - The execution route (e.g. "hybrid", "mixed").
   * @returns The matching retrieval profile.
   */
  getProfile(queryClass: QueryClass, route: string): RetrievalProfile {
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
}
