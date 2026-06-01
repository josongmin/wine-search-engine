/**
 * Entity Lookup V2 — multi-channel provenance projection (T-ELV2-04).
 *
 * The existing recall substrate already performs multi-view alias matching:
 * each {@link AnchorCandidate} records the `lookupStrategies` (exact, compact,
 * transliterated, jamo/phonetic, fuzzy, …) that recalled it. T-ELV2-04 makes
 * that recall an EXPLICIT, per-channel artifact (RFC §5.4 — "candidate recall
 * 이 다채널 artifact로 분리된다") by decomposing the anchor strategies into the
 * declared V2 channels and unioning them per candidate.
 *
 * This reuses the existing recall (no new retrieval engine here); the deeper
 * independent-channel runtime with per-channel native scores is the next step
 * behind the {@link LookupCandidateRetrievalPort} seam.
 */

import type { CanonicalEntityId } from '../../shared/types/index.js';
import type { AnchorCandidate } from '../../query/model/anchor-candidate.js';
import { clamp01 } from '../../shared/utils/clamp.js';
import type { LookupChannelHit, LookupRetrievalChannel } from './lookup-v2-types.js';

/**
 * Map a free-form anchor lookup-strategy string to a declared V2 channel.
 * Order matters: more specific prefixes (compact/translit/fuzzy) are tested
 * before the generic `exact`/`alias` fallback, because e.g. `compact_exact`
 * contains the substring `exact`.
 */
export function mapLookupStrategyToChannel(strategy: string): LookupRetrievalChannel | undefined {
  const s = strategy.toLowerCase();
  if (s.includes('compact')) return 'compact_exact';
  if (s.includes('translit')) return 'transliteration_exact';
  if (s.includes('jamo') || s.includes('phonetic')) return 'jamo_phonetic';
  if (s.includes('fuzzy') || s.includes('ngram') || s.includes('trigram') || s.includes('edit')) return 'fuzzy_alias';
  if (s.includes('family')) return 'family_graph';
  if (s.includes('semantic') || s.includes('dense')) return 'dense';
  if (s.includes('exact') || s.includes('canonical') || s.includes('alias')) return 'exact_alias';
  return undefined;
}

/** Channel attributed to blocker-seeded candidates (high-recall, non-alias). */
export const BLOCKER_SEED_CHANNEL: LookupRetrievalChannel = 'dense';

/**
 * Channels that constitute EXACT identity evidence: a normalized/compact/
 * transliterated exact alias hit. Fuzzy / family / dense are recall-only and
 * do NOT prove identity.
 */
const EXACT_IDENTITY_CHANNELS: ReadonlySet<LookupRetrievalChannel> = new Set([
  'exact_alias',
  'compact_exact',
  'transliteration_exact',
]);

/**
 * Minimum anchor confidence for a channel hit to count as exact-identity
 * evidence. High by design — exact-channel hits below this are treated as
 * recall, not identity proof. Used by the calibrated-abstain decider to certify
 * a resolve when calibration is UNtrusted (substitute trust = exact evidence;
 * memory: calibration-trust gate), instead of trusting a raw score.
 */
export const EXACT_IDENTITY_ANCHOR_CONFIDENCE = 0.95;

/**
 * Whether a candidate's channel union carries exact-identity evidence — i.e. an
 * exact/compact/transliteration alias hit at or above the confidence floor.
 */
export function hasExactIdentityEvidence(hits: readonly LookupChannelHit[]): boolean {
  return hits.some(
    (h) => EXACT_IDENTITY_CHANNELS.has(h.channel) && h.channelScore >= EXACT_IDENTITY_ANCHOR_CONFIDENCE,
  );
}

/**
 * Build the per-channel hit union for one candidate from the anchors that
 * recalled it. De-duplicates by channel, keeping the highest-confidence hit.
 */
export function buildChannelHitsForEntity(
  entityId: CanonicalEntityId,
  candidateRank: number,
  anchors: readonly AnchorCandidate[],
  blockerSeed: boolean,
): readonly LookupChannelHit[] {
  const byChannel = new Map<LookupRetrievalChannel, LookupChannelHit>();
  const idStr = String(entityId);

  for (const anchor of anchors) {
    if (!anchor.candidateEntityIds.some((id) => String(id) === idStr)) {
      continue;
    }
    const strategies = anchor.lookupStrategies ?? [];
    for (const strategy of strategies) {
      const channel = mapLookupStrategyToChannel(strategy);
      if (channel === undefined) continue;
      const channelScore = clamp01(anchor.confidence);
      const existing = byChannel.get(channel);
      if (existing === undefined || channelScore > existing.channelScore) {
        byChannel.set(channel, {
          channel,
          matchedView: anchor.normalizedForm,
          matchedAlias: anchor.surfaceForm,
          channelScore,
          channelRank: candidateRank,
        });
      }
    }
  }

  if (blockerSeed && !byChannel.has(BLOCKER_SEED_CHANNEL)) {
    byChannel.set(BLOCKER_SEED_CHANNEL, {
      channel: BLOCKER_SEED_CHANNEL,
      matchedView: 'blocker_seed',
      channelScore: 0,
      channelRank: candidateRank,
    });
  }

  return [...byChannel.values()];
}
