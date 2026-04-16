/**
 * T3.5: Protected Recall Policy
 *
 * Classifies candidates that must survive assembly even if their RRF score
 * is low — ensuring the final set never silently drops high-value candidates.
 *
 * Priority order (highest → lowest):
 * 1. known_item_lookup — candidate came from a direct entity lookup (sparseRank === 1)
 * 2. anchor_conditioned — query had an anchor and this candidate was conditioned on it
 * 3. exact_alias_match — candidate matched via an exact alias (not fuzzy)
 */

import type { CandidateEnvelope, ProtectedInclusionReason } from '../model/candidate-envelope.js';

// ---------------------------------------------------------------------------
// Classification result
// ---------------------------------------------------------------------------

type ProtectionReason =
  | 'known_item_lookup'
  | 'anchor_conditioned'
  | 'exact_alias_match';

interface ProtectionClassification {
  /** Whether this candidate should be protected. */
  readonly protect: boolean;
  /** Primary reason (highest-priority match), if protect === true. */
  readonly reason?: ProtectionReason;
}

// ---------------------------------------------------------------------------
// Policy interface
// ---------------------------------------------------------------------------

interface ProtectedRecallPolicy {
  classify(candidate: CandidateEnvelope): ProtectionClassification;
}

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

export class DefaultProtectedRecallPolicy implements ProtectedRecallPolicy {
  classify(candidate: CandidateEnvelope): ProtectionClassification {
    const prov = candidate.provenance;

    // 1. known_item_lookup: sparse channel with rank 1
    //    This implies the entity was directly fetched by BM25 top-1 (near-exact match).
    const hasSparseRank1 = prov.channelScores.some(
      (ev) => ev.channel === 'sparse_bm25' && ev.rank === 1,
    );
    if (hasSparseRank1) {
      return { protect: true, reason: 'known_item_lookup' };
    }

    // 2. anchor_conditioned: candidate was retrieved because of a query anchor
    if (prov.anchorConditioned) {
      return { protect: true, reason: 'anchor_conditioned' };
    }

    // 3. exact_alias_match: the candidate is already flagged as a protected inclusion
    //    due to alias matching (set upstream by retrieval)
    if (
      prov.protectedInclusionReason === 'exact_alias_match' ||
      prov.protectedInclusionReason === 'known_item_lookup'
    ) {
      return { protect: true, reason: 'exact_alias_match' };
    }

    return { protect: false };
  }
}

/**
 * Apply the protected recall policy to a list of candidates.
 * Returns the same candidates with protectedInclusionReason set where applicable.
 *
 * Note: This does not mutate the original candidates.
 * Returns new CandidateEnvelope objects with updated provenance where classified.
 */
export function applyProtectedRecallPolicy(
  candidates: readonly CandidateEnvelope[],
  policy: ProtectedRecallPolicy = new DefaultProtectedRecallPolicy(),
): readonly CandidateEnvelope[] {
  return candidates.map((c) => {
    const classification = policy.classify(c);
    if (!classification.protect || c.provenance.protectedInclusionReason !== undefined) {
      return c;
    }
    // Map ProtectionReason → ProtectedInclusionReason (same values, narrower type on envelope)
    const mappedReason = classification.reason as ProtectedInclusionReason;
    return {
      ...c,
      provenance: {
        ...c.provenance,
        protectedInclusionReason: mappedReason,
      },
    };
  });
}
