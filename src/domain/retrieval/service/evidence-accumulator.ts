/**
 * T3.4: Evidence Accumulator
 *
 * Merges multiple CandidateEnvelopes for the same entityId across channels.
 * Produces AccumulatedEvidence: best fusionScore, union of constraints,
 * best per-channel ranks, merged channel set.
 */

import type { CandidateEnvelope, CandidateChannel } from '../model/candidate-envelope.js';

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
    for (const c of group) {
      for (const ev of c.provenance.channelScores) {
        const current = bestRankPerChannel[ev.channel];
        if (current === undefined || ev.rank < current) {
          bestRankPerChannel[ev.channel] = ev.rank;
        }
      }
    }

    // Union matched filter constraints
    const constraintSet = new Set<string>();
    for (const c of group) {
      for (const constraint of c.provenance.matchedFilterConstraints) {
        constraintSet.add(constraint);
      }
    }

    // anchorConditioned: true if any
    const anchorConditioned = group.some((c) => c.provenance.anchorConditioned);

    results.push({
      entityId,
      channels: [...channelSet],
      bestFusionScore: canonical.provenance.fusionScore,
      bestRankPerChannel,
      matchedFilterConstraints: [...constraintSet],
      anchorConditioned,
      canonicalEnvelope: canonical,
    });
  }

  // Sort by bestFusionScore descending
  results.sort((a, b) => b.bestFusionScore - a.bestFusionScore);

  return results;
}
