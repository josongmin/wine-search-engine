/**
 * Entity Lookup V2 — candidate feature extraction (T-ELV2-05).
 *
 * Derives the deterministic {@link LookupCandidateFeatures} vector consumed by
 * the learned reranker from a candidate's multi-channel provenance + its
 * resolver-calibrated score. Pure domain logic (no I/O).
 */

import type { LookupCandidateFeatures, LookupChannelHit, LookupRetrievalChannel } from './lookup-v2-types.js';

/**
 * Map a candidate's membership in a persisted ambiguity cluster to a bounded
 * [0,1) feature. Parameter-free + monotonic: a member of a size-N cluster scores
 * `1 - 1/N` (size 2 → 0.5, size 5 → 0.8, → asymptote 1 as the cluster grows),
 * a non-member (or a cluster of size < 2) scores 0. No magic threshold — the
 * larger the contested cluster, the stronger the ambiguity signal. (T-ELV2-06.)
 */
export function ambiguityClusterMembershipScore(isMember: boolean, clusterSize: number): number {
  if (!isMember || !Number.isFinite(clusterSize) || clusterSize < 2) return 0;
  return 1 - 1 / clusterSize;
}

function bestChannelScore(hits: readonly LookupChannelHit[], channel: LookupRetrievalChannel): number {
  let best = 0;
  for (const hit of hits) {
    if (hit.channel === channel && hit.channelScore > best) {
      best = hit.channelScore;
    }
  }
  return best;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value > 1 ? 1 : value;
}

/**
 * Build the reranker feature vector from a candidate's channel hits + its
 * calibrated resolver score. Each channel contributes its strongest hit as the
 * evidence signal for the corresponding feature.
 */
export function extractLookupFeatures(
  channelHits: readonly LookupChannelHit[],
  calibratedScore: number,
  /**
   * Persisted ambiguity-cluster membership signal in [0,1) — computed by the
   * caller via {@link ambiguityClusterMembershipScore} from the registry-backed
   * cluster (T-ELV2-06 Half A). 0 when the candidate is not in a known cluster
   * or the substrate is unavailable.
   */
  ambiguityClusterMembership = 0,
): LookupCandidateFeatures {
  const distinctChannels = new Set(channelHits.map((h) => h.channel));
  return {
    exactAliasEvidence: bestChannelScore(channelHits, 'exact_alias'),
    normalizedAliasEvidence: bestChannelScore(channelHits, 'compact_exact'),
    transliterationConsistency: bestChannelScore(channelHits, 'transliteration_exact'),
    editDistanceScore: bestChannelScore(channelHits, 'fuzzy_alias'),
    phoneticConsistency: bestChannelScore(channelHits, 'jamo_phonetic'),
    familyGraphProximity: bestChannelScore(channelHits, 'family_graph'),
    // No popularity/script substrate at this layer yet — carry the calibrated
    // resolver score as the popularity-prior proxy (deterministic, bounded).
    popularityPrior: clamp01(calibratedScore),
    // An exact/compact/transliteration hit implies script/language consistency.
    scriptLanguageConsistency:
      bestChannelScore(channelHits, 'exact_alias') > 0 ||
      bestChannelScore(channelHits, 'compact_exact') > 0 ||
      bestChannelScore(channelHits, 'transliteration_exact') > 0
        ? 1
        : 0,
    // T-ELV2-06 persisted ambiguity graph: cluster-membership signal supplied by
    // the caller (reranker-gated path) from the registry-backed cluster.
    ambiguityClusterMembership: clamp01(ambiguityClusterMembership),
    channelAgreement: distinctChannels.size,
  };
}
