/**
 * T3.4: Evidence Accumulator
 *
 * Merges multiple CandidateEnvelopes for the same entityId across channels.
 * Produces AccumulatedEvidence: best fusionScore, union of constraints,
 * best per-channel ranks, merged channel set.
 */

import type { CandidateEnvelope, CandidateChannel } from '../model/candidate-envelope.js';
import {
  preferCanonicalRetrievalChannelLabels,
  toCanonicalCandidateChannel,
} from '../model/retrieval-channel.js';
import {
  pickMaxByScore,
  compareScoreWithTiebreaker,
} from '../../shared/utils/stable-comparator.js';

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
  // NaN guard: treat non-finite contributions as -Infinity so the comparator always
  // returns a well-defined numeric value and the sort remains deterministic.
  const lRrf = Number.isFinite(left.rrfContribution) ? left.rrfContribution : -Infinity;
  const rRrf = Number.isFinite(right.rrfContribution) ? right.rrfContribution : -Infinity;
  if (lRrf !== rRrf) {
    return rRrf - lRrf;
  }
  if (left.rank !== right.rank) {
    return left.rank - right.rank;
  }
  const lRaw = Number.isFinite(left.rawScore) ? left.rawScore : -Infinity;
  const rRaw = Number.isFinite(right.rawScore) ? right.rawScore : -Infinity;
  return rRaw - lRaw;
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

// toCanonicalCandidateChannel: imported from retrieval-channel.ts (SSoT)

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
    // Find canonical envelope by best fusionScore. Use pickMaxByScore to get
    // NaN-safe comparison + deterministic entityId tiebreaker on ties.
    // (Bugbash R19 critical re-audit: previous `>`-only loop was order-sensitive.)
    const canonical = pickMaxByScore(
      group,
      (c) => c.provenance.fusionScore,
      // fusionProfile varies per candidate (dense, lexical, anchor) — provides deterministic
      // ordering when two candidates for the same entity have equal fusionScore.
      // (entityId is identical across the group and cannot break ties.)
      (c) => c.provenance.fusionProfile,
    )!;

    // Union channels
    const channelSet = new Set<CandidateChannel>();
    for (const c of group) {
      for (const ch of c.provenance.channels) {
        const canonical = toCanonicalCandidateChannel(ch);
        if (canonical !== null) {
          channelSet.add(canonical);
        }
      }
    }

    // Best rank per channel (lowest rank = best)
    const bestRankPerChannel: Partial<Record<CandidateChannel, number>> = {};
    const bestScorePerChannel = new Map<CandidateChannel, (typeof group)[number]['provenance']['channelScores'][number]>();
    for (const c of group) {
      for (const ev of c.provenance.channelScores) {
        const canonical = toCanonicalCandidateChannel(ev.channel);
        if (canonical === null) {
          continue;
        }
        const current = bestRankPerChannel[canonical];
        if (current === undefined || ev.rank < current) {
          bestRankPerChannel[canonical] = ev.rank;
        }
        const normalizedEvidence = { ...ev, channel: canonical };
        const bestEvidence = bestScorePerChannel.get(canonical);
        if (
          bestEvidence === undefined
          || compareChannelEvidence(normalizedEvidence, bestEvidence) < 0
        ) {
          bestScorePerChannel.set(canonical, normalizedEvidence);
        }
      }
    }

    // Union matched filter constraints; intersection for failed hard constraints.
    //
    // matchedFilterConstraints: UNION — a constraint matched by any channel is
    // considered satisfied (best-case semantics; one channel suffices).
    //
    // failedHardConstraints: INTERSECTION — a constraint only belongs in the
    // "failed" set if ALL contributions failed it. If channel A satisfied
    // "country=France" but channel B did not (e.g. different Vespa projection),
    // the entity should NOT be marked as failing the constraint. Union semantics
    // here would produce false failures and incorrectly evict candidates that at
    // least one retrieval path confirmed.
    const constraintSet = new Set<string>();
    // Collect per-contribution failed sets; intersect after the loop.
    const failedSetsPerContribution: Array<Set<string>> = [];
    const queryViewKeySet = new Set<string>();
    const queryViewMatches: Array<CandidateEnvelope['provenance']['queryViewMatches'][number]> = [];
    for (const c of group) {
      for (const constraint of c.provenance.matchedFilterConstraints) {
        constraintSet.add(constraint);
      }
      failedSetsPerContribution.push(new Set(c.provenance.failedHardConstraints ?? []));
      for (const match of c.provenance.queryViewMatches) {
        const canonical = toCanonicalCandidateChannel(match.channel);
        if (canonical === null) {
          continue;
        }
        const normalizedMatch = { ...match, channel: canonical };
        const key = `${normalizedMatch.viewName}\u0000${normalizedMatch.matchedText}\u0000${normalizedMatch.channel}`;
        if (!queryViewKeySet.has(key)) {
          queryViewKeySet.add(key);
          queryViewMatches.push(normalizedMatch);
        }
      }
    }

    // anchorConditioned: true if any
    const anchorConditioned = group.some((c) => c.provenance.anchorConditioned);
    const channels = [...channelSet];
    const matchedFilterConstraints = [...constraintSet];

    // Intersect failed hard constraints: only keep attributes that failed in
    // EVERY contribution. An attribute that passed in at least one channel is
    // not a hard failure for the entity.
    let failedHardConstraints: string[];
    if (failedSetsPerContribution.length === 0) {
      failedHardConstraints = [];
    } else {
      // Start from the first set, then intersect with each subsequent set.
      // IMPORTANT: do NOT delete from a Set while iterating it with for...of —
      // although V8 handles this gracefully in practice, the ECMAScript spec
      // only guarantees that already-visited entries are not re-visited and
      // not-yet-visited deleted entries are skipped. Build a fresh Set each
      // iteration to make the intersection semantics explicit and safe.
      const [firstSet, ...restSets] = failedSetsPerContribution;
      let intersection = new Set<string>(firstSet);
      for (const nextSet of restSets) {
        const nextIntersection = new Set<string>();
        for (const attr of intersection) {
          if (nextSet.has(attr)) {
            nextIntersection.add(attr);
          }
        }
        intersection = nextIntersection;
      }
      failedHardConstraints = [...intersection];
    }
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
    // Best-value merge for sparse fields not projected by every retrieval channel.
    // If the canonical envelope lacks grapeFamily / flavorProfiles / regionHierarchy /
    // priceBandNumeric, fill them from the first group contribution that has them.
    // We never overwrite a value already present on the canonical — it is authoritative.
    let mergedGrapeFamily = canonical.legacyCandidate.grapeFamily;
    let mergedFlavorProfiles = canonical.legacyCandidate.flavorProfiles;
    let mergedRegionHierarchy = canonical.legacyCandidate.regionHierarchy;
    let mergedPriceBandNumeric = canonical.legacyCandidate.priceBandNumeric;
    for (const c of group) {
      if (
        mergedGrapeFamily === undefined
        || mergedFlavorProfiles === undefined
        || mergedRegionHierarchy === undefined
        || mergedPriceBandNumeric === undefined
      ) {
        const lc = c.legacyCandidate;
        if (mergedGrapeFamily === undefined && lc.grapeFamily !== undefined) {
          mergedGrapeFamily = lc.grapeFamily;
        }
        if (mergedFlavorProfiles === undefined && lc.flavorProfiles != null && lc.flavorProfiles.length > 0) {
          mergedFlavorProfiles = lc.flavorProfiles;
        }
        if (mergedRegionHierarchy === undefined && lc.regionHierarchy != null && lc.regionHierarchy.length > 0) {
          mergedRegionHierarchy = lc.regionHierarchy;
        }
        if (mergedPriceBandNumeric === undefined && lc.priceBandNumeric !== undefined) {
          mergedPriceBandNumeric = lc.priceBandNumeric;
        }
      } else {
        break;
      }
    }

    const mergedEnvelope: CandidateEnvelope = {
      entityId,
      provenance: mergedProvenance,
      legacyCandidate: {
        ...canonical.legacyCandidate,
        matchedConstraints: matchedFilterConstraints,
        ...(failedHardConstraints.length > 0 ? { unmetHardConstraints: failedHardConstraints } : {}),
        ...(mergedGrapeFamily !== undefined ? { grapeFamily: mergedGrapeFamily } : {}),
        ...(mergedFlavorProfiles !== undefined ? { flavorProfiles: mergedFlavorProfiles } : {}),
        ...(mergedRegionHierarchy !== undefined ? { regionHierarchy: mergedRegionHierarchy } : {}),
        ...(mergedPriceBandNumeric !== undefined ? { priceBandNumeric: mergedPriceBandNumeric } : {}),
        retrievalTrace: {
          ...canonical.legacyCandidate.retrievalTrace,
          candidateSources: preferCanonicalRetrievalChannelLabels(channels),
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

  // Sort by bestFusionScore descending with NaN-safe + entityId tiebreaker.
  // (Bugbash R22)
  results.sort(
    compareScoreWithTiebreaker<AccumulatedEvidence>(
      (r) => r.bestFusionScore,
      (r) => r.entityId,
    ),
  );

  return results;
}
