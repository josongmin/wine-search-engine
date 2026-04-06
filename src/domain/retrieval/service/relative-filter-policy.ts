/**
 * T4.5: Relative filter policy — anchor-conditioned post-fusion filter.
 *
 * This is a pure domain service that operates on an already-fused candidate
 * pool.  It does NOT issue a new Vespa query; instead it narrows the pool to
 * candidates that share key wine attributes (region, grape, style) with a
 * named anchor entity, then re-labels each surviving candidate's trace to
 * record the relative_filter channel contribution.
 */

import type { EntityId } from '../../shared/types/index.js';
import type { HybridCandidate } from '../model/hybrid-candidate.js';
import type { RetrievalDocument } from '../model/retrieval-document.js';

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

/**
 * Driving input for the relative filter pass.
 *
 * @property anchorEntityId  - The entity whose attributes define the "relative"
 *                             neighbourhood.  Typically resolved earlier in the
 *                             pipeline from the user's anchor phrase.
 * @property constraints     - Opaque constraint strings (e.g. "price_band:under_50",
 *                             "style:bold") that are carried through for
 *                             observability but evaluated upstream; the filter
 *                             itself uses the anchor's attribute fields on each
 *                             HybridCandidate.
 */
export interface RelativeFilterInput {
  readonly anchorEntityId: EntityId;
  readonly constraints: readonly string[];
  readonly anchorDocument?: RetrievalDocument | undefined;
}

// ---------------------------------------------------------------------------
// Attribute extraction helpers
// ---------------------------------------------------------------------------

/** Normalise a nullable string attribute to lower-case for comparison. */
function norm(value: string | undefined): string {
  return value !== undefined ? value.trim().toLowerCase() : '';
}

/**
 * Derive the set of matchable attributes from a candidate.
 * Only fields that are populated on the anchor are considered.
 */
interface CandidateAttributes {
  readonly region: string;
  readonly grapePrimary: string;
  readonly style: string;
  readonly country: string;
  readonly appellation: string;
}

function extractAttributes(candidate: {
  readonly region?: string | undefined;
  readonly grapePrimary?: string | undefined;
  readonly style?: string | undefined;
  readonly country?: string | undefined;
  readonly appellation?: string | undefined;
}): CandidateAttributes {
  return {
    region: norm(candidate.region),
    grapePrimary: norm(candidate.grapePrimary),
    style: norm(candidate.style),
    country: norm(candidate.country),
    appellation: norm(candidate.appellation),
  };
}

/**
 * Returns true when at least one key attribute (region, grape, or style) of the
 * candidate matches the corresponding anchor attribute.
 *
 * The matching is intentionally permissive — a single shared attribute is
 * enough — because the anchor neighbourhood for relative queries ("similar reds
 * under $50 to this wine") should be broad enough for ranking to further shape.
 *
 * An attribute is only compared when the anchor has a non-empty value for it;
 * empty anchor attributes are treated as wildcards (always match).
 */
function matchesAnchorAttributes(
  anchor: CandidateAttributes,
  candidate: CandidateAttributes,
): boolean {
  // If at least one anchor attribute is populated, require at least one match.
  const anchorHasAny =
    anchor.region !== '' || anchor.grapePrimary !== '' || anchor.style !== '';

  if (!anchorHasAny) {
    // No anchor attributes to compare — pass everything through.
    return true;
  }

  if (anchor.region !== '' && anchor.region === candidate.region) return true;
  if (anchor.grapePrimary !== '' && anchor.grapePrimary === candidate.grapePrimary) return true;
  if (anchor.style !== '' && anchor.style === candidate.style) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Policy service
// ---------------------------------------------------------------------------

/**
 * Applies the relative filter to a fused candidate pool.
 *
 * Algorithm:
 * 1. Find the anchor candidate in the pool by entityId.
 * 2. Extract the anchor's key attributes (region, grape, style).
 * 3. Filter the pool to candidates sharing at least one attribute with the anchor,
 *    excluding the anchor itself.
 * 4. Re-label each surviving candidate's `retrievalTrace.candidateSources` to
 *    include `'relative_filter'` if not already present.
 *
 * When the anchor entity is absent from the pool (not yet resolved or not
 * retrieved), the function returns an empty array so that the caller sees a
 * clear signal that filtering intent could not be satisfied.
 *
 * @param candidates - The fused candidate pool from the retrieval pipeline.
 * @param input      - Anchor entity and constraint context for the filter pass.
 * @returns A narrowed, re-labelled readonly array of {@link HybridCandidate}.
 */
export function applyRelativeFilter(
  candidates: readonly HybridCandidate[],
  input: RelativeFilterInput,
): readonly HybridCandidate[] {
  const anchorSource = input.anchorDocument
    ?? candidates.find((c) => c.entityId === input.anchorEntityId);

  if (anchorSource === undefined) {
    return [];
  }

  const anchorAttrs = extractAttributes(anchorSource);

  return candidates
    .filter((c) => {
      if (c.entityId === input.anchorEntityId) return false;
      return matchesAnchorAttributes(anchorAttrs, extractAttributes(c));
    })
    .map((c) => {
      const alreadyLabelled = c.retrievalTrace.candidateSources.includes('relative_filter');
      if (alreadyLabelled) return c;

      return {
        ...c,
        retrievalTrace: {
          ...c.retrievalTrace,
          candidateSources: [...c.retrievalTrace.candidateSources, 'relative_filter'] as const,
        },
      };
    });
}
