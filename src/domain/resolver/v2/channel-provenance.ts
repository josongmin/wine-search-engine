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

export const LOOKUP_IDENTITY_GRADE_CHANNELS: ReadonlySet<LookupRetrievalChannel> = new Set([
  'exact_alias',
  'compact_exact',
  'transliteration_exact',
]);

const LOOKUP_SUPPORTIVE_ONLY_CHANNELS: ReadonlySet<LookupRetrievalChannel> = new Set([
  'jamo_phonetic',
]);

export type LookupResolveEvidenceGrade =
  | 'identity_grade'
  | 'supportive_only'
  | 'recall_only'
  | 'none';

/**
 * Map a free-form anchor lookup-strategy string to a declared V2 channel.
 * Order matters: more specific prefixes (compact/translit/fuzzy) are tested
 * before the generic `exact`/`alias` fallback, because e.g. `compact_exact`
 * contains the substring `exact`.
 */
export function mapLookupStrategyToChannel(strategy: string): LookupRetrievalChannel | undefined {
  const s = strategy.toLowerCase();
  if (s.includes('compact')) return 'compact_exact';
  // Only WHOLE-string transliterated_exact is identity-grade. Recall/expansion
  // translit variants emitted LIVE by the wired matchers — transliterated_fuzzy
  // AND transliterated_prefix (search-index-alias-matcher.ts / search-snapshot-
  // alias-matcher.ts) — must NOT be forged as exact; they fall through to
  // fuzzy_alias. The exclusion mirrors the recall vocabulary of the fuzzy branch
  // below (fuzzy/inexact/prefix/lexical). (T-04 audit + self-review C1.)
  if (s.includes('translit') && !/fuzzy|inexact|prefix|lexical/u.test(s)) return 'transliteration_exact';
  // NOTE: jamo_phonetic is a NEAR-exact (not identity-grade) channel, so a
  // phonetic_fuzzy hit stays here rather than routing to fuzzy_alias — unlike
  // transliteration_exact, which IS identity-grade and must exclude fuzzy.
  if (s.includes('jamo') || s.includes('phonetic')) return 'jamo_phonetic';
  // Recall / expansion strategies — fuzzy, n-gram, edit-distance, AND the
  // partial-token expansions (lexical_exact, prefix_exact, inexact_*). These
  // names CONTAIN "exact"/"alias" but are NOT exact identity; route them to the
  // fuzzy channel so the display label is honest (audit R2). Checked before the
  // generic exact/alias fallback.
  if (
    s.includes('fuzzy') || s.includes('ngram') || s.includes('trigram') || s.includes('edit') ||
    s.includes('inexact') || s.includes('lexical') || s.includes('prefix')
  ) return 'fuzzy_alias';
  if (s.includes('vintage')) return 'vintage_graph';
  if (s.includes('line')) return 'line_graph';
  if (s.includes('family')) return 'family_graph';
  if (s.includes('semantic') || s.includes('dense')) return 'dense';
  if (s.includes('exact') || s.includes('canonical') || s.includes('alias')) return 'exact_alias';
  return undefined;
}

/** Channel attributed to blocker-seeded candidates (high-recall, non-alias). */
export const BLOCKER_SEED_CHANNEL: LookupRetrievalChannel = 'dense';

/**
 * STRICT exact-identity lookup strategies — matched as WHOLE normalized strings
 * (never as substrings), so recall/expansion strategies whose NAMES merely
 * contain "exact"/"alias" (`lexical_exact`, `prefix_exact`, `inexact_alias`,
 * `*_fuzzy`) can never count as identity evidence (audit R2 bypass). These are
 * the strategies that prove the query IS the entity, not merely recalls it.
 */
const STRICT_EXACT_IDENTITY_STRATEGIES: ReadonlySet<string> = new Set([
  'exact',
  'exact_alias',
  'exact_entity',
  'canonical_exact',
  'compact_exact',
  'transliterated_exact',
  'transliteration_exact',
]);

/**
 * Minimum anchor confidence for a strict-exact strategy to count as identity
 * evidence. Set BELOW the canonical-exact confidence so the legitimately weaker
 * exact strategies still qualify (compact_exact ≈0.90, transliterated_exact
 * ≈0.88) while clearly-degraded hits are excluded — the prior 0.95 floor was an
 * inverted gate that rejected the very strategies it meant to admit (audit R2).
 * The STRATEGY allowlist — not this number — is the primary gate.
 */
export const EXACT_IDENTITY_MIN_CONFIDENCE = 0.85;

/**
 * Markers that make an anchor FUZZY/recall by construction. Critically, the
 * planner's fuzzy-fallback path runs the edit-distance-CORRECTED term through
 * the exact alias matcher and copies the resulting bare `exact` strategy onto
 * the fuzzy anchor (so it carries BOTH `exact` and `fuzzy_match_fallback`). A
 * typo like `opu one`→`opus one` would then forge exact-identity evidence
 * (audit R3). Any anchor carrying one of these markers is fuzzy and can NEVER
 * count as exact identity, regardless of a co-present `exact` label.
 */
const FUZZY_RECALL_STRATEGY_MARKER = /fuzzy|ngram|trigram|edit|prefix|inexact|lexical|phonetic|fallback/u;

/**
 * Whether the entity has EXACT-identity evidence among the anchors that
 * recalled it: an anchor that includes the entity, carries a strict-exact
 * lookup strategy, is NOT fuzzy-by-construction, and meets the confidence
 * floor. Used by the calibrated decider to certify a resolve under UNtrusted
 * calibration (substitute trust = exact evidence; memory calibration-trust
 * gate) WITHOUT reading a raw score.
 */
export function anchorsHaveExactIdentityEvidence(
  entityId: CanonicalEntityId,
  anchors: readonly AnchorCandidate[],
): boolean {
  const idStr = String(entityId);
  return anchors.some((anchor) => {
    if (clamp01(anchor.confidence) < EXACT_IDENTITY_MIN_CONFIDENCE) {
      return false;
    }
    if (!anchor.candidateEntityIds.some((id) => String(id) === idStr)) {
      return false;
    }
    const strategies = (anchor.lookupStrategies ?? []).map((s) => s.toLowerCase());
    // A fuzzy-by-construction anchor's exact label was earned by a CORRECTED
    // term, not the user's query — reject it as identity evidence.
    if (strategies.some((s) => FUZZY_RECALL_STRATEGY_MARKER.test(s))) {
      return false;
    }
    return strategies.some((s) => STRICT_EXACT_IDENTITY_STRATEGIES.has(s));
  });
}

/**
 * Classify the strongest resolve-certifying evidence a candidate carries from
 * its per-channel provenance.
 *
 * Resolve certificate hierarchy:
 * - identity_grade: exact/compact/transliteration exact channels
 * - supportive_only: phonetic/jamo-only evidence
 * - recall_only: fuzzy/family/dense recall lanes
 * - none: no provenance at all
 */
export function classifyResolveEvidenceGrade(
  channelHits: readonly Pick<LookupChannelHit, 'channel'>[],
): LookupResolveEvidenceGrade {
  let hasSupportiveOnly = false;
  let hasRecallOnly = false;

  for (const hit of channelHits) {
    if (LOOKUP_IDENTITY_GRADE_CHANNELS.has(hit.channel)) {
      return 'identity_grade';
    }
    if (LOOKUP_SUPPORTIVE_ONLY_CHANNELS.has(hit.channel)) {
      hasSupportiveOnly = true;
      continue;
    }
    hasRecallOnly = true;
  }

  if (hasSupportiveOnly) {
    return 'supportive_only';
  }
  if (hasRecallOnly) {
    return 'recall_only';
  }
  return 'none';
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
    // `matched_view` is `.min(1)` at the wire boundary; an empty normalized
    // form (unenforced AnchorCandidate invariant) would 500 a valid resolve.
    // Skip such a malformed anchor rather than emit a schema-invalid hit.
    const matchedView = anchor.normalizedForm;
    if (matchedView.length === 0) {
      continue;
    }
    const matchedAlias = anchor.surfaceForm;
    const strategies = anchor.lookupStrategies ?? [];
    for (const strategy of strategies) {
      const channel = mapLookupStrategyToChannel(strategy);
      if (channel === undefined) continue;
      const channelScore = clamp01(anchor.confidence);
      const existing = byChannel.get(channel);
      if (existing === undefined || channelScore > existing.channelScore) {
        byChannel.set(channel, {
          channel,
          matchedView,
          // matched_alias is `.min(1).optional()` — omit when empty.
          ...(matchedAlias.length > 0 ? { matchedAlias } : {}),
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
