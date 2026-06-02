/**
 * Entity Lookup V2 — candidate feature extraction (T-ELV2-05).
 *
 * Derives the deterministic {@link LookupCandidateFeatures} vector consumed by
 * the learned reranker from a candidate's multi-channel provenance + its
 * resolver-calibrated score. Pure domain logic (no I/O).
 */

import type { LookupCandidateFeatures, LookupChannelHit, LookupRetrievalChannel } from './lookup-v2-types.js';

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
    // Filled by T-ELV2-06 persisted ambiguity graph; 0 until wired.
    ambiguityClusterMembership: 0,
    channelAgreement: distinctChannels.size,
  };
}
