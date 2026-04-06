/**
 * T3.4: Evidence Accumulator
 *
 * Merges multiple CandidateEnvelopes for the same entityId across channels.
 * Produces AccumulatedEvidence: best fusionScore, union of constraints,
 * best per-channel ranks, merged channel set.
 */

import type { CandidateEnvelope, CandidateChannel } from '../model/candidate-envelope.js';

const PROTECTION_PRIORITY: Readonly<Record<string, number>> = {
  known_item_lookup: 0,
  anchor_conditioned: 1,
  exact_alias_match: 2,
  hard_constraint_compatible: 3,
  diversity_slot: 4,
};

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

export interface AccumulatedEvidence {
  /** Entity ID this evidence belongs to. */
  readonly entityId: string;

  /** All channels that contributed candidates for this entity. */
  readonly channels: readonly CandidateChannel[];

  /** Highest fusionScore across all contributions. */
  readonly bestFusionScore: number;

  /** Best (lowest) rank seen from each channel. */
  readonly bestRankPerChannel: Readonly<Partial<Record<CandidateChannel, number>>>;

  /** Union of matched filter constraints across contributions. */
  readonly matchedFilterConstraints: readonly string[];

  /** Whether any contribution was anchor-conditioned. */
  readonly anchorConditioned: boolean;

  /** Source envelope with the best fusionScore (canonical representation). */
  readonly canonicalEnvelope: CandidateEnvelope;

  /** Envelope with merged provenance propagated into the legacy candidate shape. */
  readonly mergedEnvelope: CandidateEnvelope;
}

function compareChannelEvidence(
  left: { readonly rrfContribution: number; readonly rank: number; readonly rawScore: number },
  right: { readonly rrfContribution: number; readonly rank: number; readonly rawScore: number },
): number {
  if (left.rrfContribution !== right.rrfContribution) {
    return right.rrfContribution - left.rrfContribution;
  }
  if (left.rank !== right.rank) {
    return left.rank - right.rank;
  }
  return right.rawScore - left.rawScore;
}

function pickProtectedReason(group: readonly CandidateEnvelope[]) {
  let bestReason: CandidateEnvelope['provenance']['protectedInclusionReason'] | undefined;
  for (const candidate of group) {
    const reason = candidate.provenance.protectedInclusionReason;
    if (reason === undefined) continue;
    if (
      bestReason === undefined
      || (PROTECTION_PRIORITY[reason] ?? Number.MAX_SAFE_INTEGER)
        < (PROTECTION_PRIORITY[bestReason] ?? Number.MAX_SAFE_INTEGER)
    ) {
      bestReason = reason;
    }
  }
  return bestReason;
}

// ---------------------------------------------------------------------------
// Accumulator function
// ---------------------------------------------------------------------------

/**
 * Accumulate evidence across multiple candidates for the same entity.
 *
 * Groups by entityId, then for each group:
 * - picks the best fusionScore as canonical
 * - unions channels and matchedFilterConstraints
 * - tracks best (lowest) rank per channel
 * - sets anchorConditioned if any contribution was conditioned
 * - emits a merged envelope that carries accumulated provenance downstream
 *
 * @param candidates - Flat list of CandidateEnvelopes (may contain duplicates by entityId).
 * @returns One AccumulatedEvidence per unique entityId, sorted by bestFusionScore desc.
 */
export function accumulateEvidence(
  candidates: readonly CandidateEnvelope[],
): readonly AccumulatedEvidence[] {
  // Group by entityId
  const groups = new Map<string, CandidateEnvelope[]>();
  for (const c of candidates) {
    const group = groups.get(c.entityId);
    if (group === undefined) {
      groups.set(c.entityId, [c]);
    } else {
      group.push(c);
    }
  }

  const results: AccumulatedEvidence[] = [];

  for (const [entityId, group] of groups) {
    // Find canonical envelope (best fusionScore)
    let canonical = group[0]!;
    for (const c of group) {
      if (c.provenance.fusionScore > canonical.provenance.fusionScore) {
        canonical = c;
      }
    }

    // Union channels
    const channelSet = new Set<CandidateChannel>();
    for (const c of group) {
      for (const ch of c.provenance.channels) {
        channelSet.add(ch);
      }
    }

    // Best rank per channel (lowest rank = best)
    const bestRankPerChannel: Partial<Record<CandidateChannel, number>> = {};
    const bestScorePerChannel = new Map<CandidateChannel, (typeof group)[number]['provenance']['channelScores'][number]>();
    for (const c of group) {
      for (const ev of c.provenance.channelScores) {
        const current = bestRankPerChannel[ev.channel];
        if (current === undefined || ev.rank < current) {
          bestRankPerChannel[ev.channel] = ev.rank;
        }
        const bestEvidence = bestScorePerChannel.get(ev.channel);
        if (
          bestEvidence === undefined
          || compareChannelEvidence(ev, bestEvidence) < 0
        ) {
          bestScorePerChannel.set(ev.channel, ev);
        }
      }
    }

    // Union matched filter constraints
    const constraintSet = new Set<string>();
    const failedHardConstraintSet = new Set<string>();
    const queryViewKeySet = new Set<string>();
    const queryViewMatches: Array<CandidateEnvelope['provenance']['queryViewMatches'][number]> = [];
    for (const c of group) {
      for (const constraint of c.provenance.matchedFilterConstraints) {
        constraintSet.add(constraint);
      }
      for (const failedConstraint of c.provenance.failedHardConstraints ?? []) {
        failedHardConstraintSet.add(failedConstraint);
      }
      for (const match of c.provenance.queryViewMatches) {
        const key = `${match.viewName}\u0000${match.matchedText}\u0000${match.channel}`;
        if (!queryViewKeySet.has(key)) {
          queryViewKeySet.add(key);
          queryViewMatches.push(match);
        }
      }
    }

    // anchorConditioned: true if any
    const anchorConditioned = group.some((c) => c.provenance.anchorConditioned);
    const channels = [...channelSet];
    const matchedFilterConstraints = [...constraintSet];
    const failedHardConstraints = [...failedHardConstraintSet];
    const protectedInclusionReason = pickProtectedReason(group);
    const channelScores = channels
      .map((channel) => bestScorePerChannel.get(channel))
      .filter((score): score is NonNullable<typeof score> => score !== undefined);
    const mergedProvenance: CandidateEnvelope['provenance'] = {
      channels,
      channelScores,
      queryViewMatches,
      anchorConditioned,
      matchedFilterConstraints,
      ...(failedHardConstraints.length > 0 ? { failedHardConstraints } : {}),
      ...(protectedInclusionReason !== undefined ? { protectedInclusionReason } : {}),
      fusionProfile: canonical.provenance.fusionProfile,
      fusionScore: canonical.provenance.fusionScore,
    };
    const mergedEnvelope: CandidateEnvelope = {
      entityId,
      provenance: mergedProvenance,
      legacyCandidate: {
        ...canonical.legacyCandidate,
        matchedConstraints: matchedFilterConstraints,
        ...(failedHardConstraints.length > 0 ? { unmetHardConstraints: failedHardConstraints } : {}),
        retrievalTrace: {
          ...canonical.legacyCandidate.retrievalTrace,
          candidateSources: channels,
        },
        retrievalProvenance: mergedProvenance,
      },
    };

    results.push({
      entityId,
      channels,
      bestFusionScore: canonical.provenance.fusionScore,
      bestRankPerChannel,
      matchedFilterConstraints,
      anchorConditioned,
      canonicalEnvelope: canonical,
      mergedEnvelope,
    });
  }

  // Sort by bestFusionScore descending
  results.sort((a, b) => b.bestFusionScore - a.bestFusionScore);

  return results;
}
