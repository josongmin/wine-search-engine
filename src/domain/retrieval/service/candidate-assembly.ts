/**
 * T3.3: Structured Assembly Layer
 *
 * CandidateAssembler: merges candidates from multiple retrieval channels
 * into a bounded, diverse final set according to AssemblyPolicy.
 *
 * Algorithm (5 steps, each delegated to a file-private pure helper):
 * 1. {@link applyHardFilters}        — remove candidates that fail hard constraints.
 * 2. {@link dedupeByEntityIdWithNaNSafeMax} — collapse duplicates, NaN-safe max + tiebreaker.
 * 3. {@link sortWithTiebreaker}       — fusionScore desc with deterministic tiebreaker.
 * 4. {@link splitProtectedAndNonProtected} — partition into protected vs non-protected.
 * 5. quota application — {@link applyChannelQuotas} + {@link applyProducerQuotas}
 *    composed inside {@link applyQuotas} for shared loop fairness.
 *
 * Helpers are file-private (not exported). They are re-exported as
 * `__internals` strictly for unit testing — production code must depend
 * on {@link CandidateAssembler} only.
 */

import type { CandidateEnvelope, CandidateChannel } from '../model/candidate-envelope.js';
import {
  pickMaxByScore,
  compareScoreWithTiebreaker,
} from '../../shared/utils/stable-comparator.js';

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface ChannelQuota {
  readonly channel: CandidateChannel;
  /** Maximum candidates contributed by this channel (after dedup). */
  readonly maxSlots: number;
}

export interface AssemblyPolicy {
  /** Maximum total candidates in the assembled set. */
  readonly maxTotal: number;

  /** Per-channel slot limits (optional). Applied after dedup + sort. */
  readonly channelQuotas?: readonly ChannelQuota[];

  /**
   * Minimum number of distinct entity anchors that must appear in the set.
   * Prevents a single producer/region from dominating.
   */
  readonly minAnchorCoverage?: number;

  /**
   * Maximum candidates from a single producer entity.
   * Prevents one winery from monopolizing results.
   */
  readonly maxProducerSlots?: number;

  /** When true, candidates with protectedInclusionReason set are kept even if over quota. */
  readonly protectExactMatches: boolean;

  /** When true, anchor-conditioned candidates are kept even if over quota. */
  readonly protectAnchorConditioned: boolean;
}

// ---------------------------------------------------------------------------
// Result + Trace
// ---------------------------------------------------------------------------

interface AssemblyResult {
  readonly candidates: readonly CandidateEnvelope[];
  readonly trace: AssemblyTrace;
}

interface AssemblyTrace {
  /** Total candidates before assembly. */
  readonly inputCount: number;
  /** Candidates after hard-filter step. */
  readonly afterHardFilter: number;
  /** Candidates after dedup (by entityId). */
  readonly afterDedup: number;
  /** Candidates protected from quota cuts. */
  readonly protectedCount: number;
  /** Final assembled count. */
  readonly outputCount: number;
  /** Reason the set was capped (if applicable). */
  readonly cappedBy?: 'maxTotal' | 'channelQuota' | 'producerSlot';
}

// ---------------------------------------------------------------------------
// Stage 1: Hard filter
// ---------------------------------------------------------------------------

/**
 * Remove candidates with failed hard constraints, EXCEPT those carrying a
 * {@link CandidateProvenance.protectedInclusionReason} — those survive to
 * the ranker's coarse prune (the authoritative precision gate). Without
 * this exception, protected candidates would be silently dropped before
 * the ranker sees them.
 *
 * Pure. No side effects.
 */
function applyHardFilters(
  candidates: readonly CandidateEnvelope[],
): readonly CandidateEnvelope[] {
  return candidates.filter(
    (c) =>
      c.provenance.protectedInclusionReason !== undefined ||
      c.provenance.failedHardConstraints === undefined ||
      c.provenance.failedHardConstraints.length === 0,
  );
}

// ---------------------------------------------------------------------------
// Stage 2: Dedup by entityId (NaN-safe max + stable tiebreaker)
// ---------------------------------------------------------------------------

/**
 * Group by entityId, then pick the canonical envelope per group via
 * {@link pickMaxByScore}: NaN scores treated as -Infinity, ties broken by
 * fusionProfile (a stable enum-like value). Previously a strict `>`
 * comparison let winner depend on retrieval-channel arrival order — not
 * deterministic. (Bugbash R19 critical re-audit.)
 *
 * Pure. No side effects.
 */
function dedupeByEntityIdWithNaNSafeMax(
  candidates: readonly CandidateEnvelope[],
): readonly CandidateEnvelope[] {
  const groupsByEntityId = new Map<string, CandidateEnvelope[]>();
  for (const c of candidates) {
    const list = groupsByEntityId.get(c.entityId);
    if (list !== undefined) {
      list.push(c);
    } else {
      groupsByEntityId.set(c.entityId, [c]);
    }
  }
  const deduped: CandidateEnvelope[] = [];
  for (const group of groupsByEntityId.values()) {
    const winner = pickMaxByScore(
      group,
      (c) => c.provenance.fusionScore,
      // Secondary tiebreaker: fusionProfile is a stable enum-like value
      // that produces the same ordering across processes regardless of
      // which retrieval channel arrived first.
      (c) => c.provenance.fusionProfile,
    );
    if (winner !== undefined) deduped.push(winner);
  }
  return deduped;
}

// ---------------------------------------------------------------------------
// Stage 3: Stable sort
// ---------------------------------------------------------------------------

/**
 * Sort candidates by fusionScore descending with a deterministic
 * tiebreaker (entityId lexicographic). Equal-score candidates preserve a
 * stable order across processes instead of insertion order.
 *
 * Returns a NEW array — does not mutate the input.
 */
function sortWithTiebreaker(
  candidates: readonly CandidateEnvelope[],
): readonly CandidateEnvelope[] {
  const copy = candidates.slice();
  copy.sort(
    compareScoreWithTiebreaker<CandidateEnvelope>(
      (c) => c.provenance.fusionScore,
      (c) => c.entityId,
    ),
  );
  return copy;
}

// ---------------------------------------------------------------------------
// Stage 4: Protected vs non-protected partition
// ---------------------------------------------------------------------------

interface ProtectionPartition {
  readonly protected_: readonly CandidateEnvelope[];
  readonly nonProtected: readonly CandidateEnvelope[];
}

/**
 * Partition candidates into protected and non-protected sets in a single
 * O(n) pass. Previously called `isProtected` twice per candidate (once
 * per filter call) which also double-allocated closure scopes. Walking
 * once and pushing into two arrays halves the per-candidate predicate
 * evaluations.
 *
 * Pure. Preserves the input order within each output array.
 */
function splitProtectedAndNonProtected(
  candidates: readonly CandidateEnvelope[],
  policy: Pick<AssemblyPolicy, 'protectExactMatches' | 'protectAnchorConditioned'>,
): ProtectionPartition {
  const { protectExactMatches, protectAnchorConditioned } = policy;
  const protected_: CandidateEnvelope[] = [];
  const nonProtected: CandidateEnvelope[] = [];
  for (const c of candidates) {
    const prov = c.provenance;
    const isProtected =
      (protectExactMatches && prov.protectedInclusionReason !== undefined) ||
      (protectAnchorConditioned && prov.anchorConditioned);
    if (isProtected) {
      protected_.push(c);
    } else {
      nonProtected.push(c);
    }
  }
  return { protected_, nonProtected };
}

// ---------------------------------------------------------------------------
// Stage 5: Quota application (channel + producer + maxTotal)
// ---------------------------------------------------------------------------

interface QuotaResult {
  readonly assembled: readonly CandidateEnvelope[];
  readonly cappedBy: AssemblyTrace['cappedBy'] | undefined;
}

/**
 * Apply maxTotal + channel quota + producer quota caps to non-protected
 * candidates, starting from a base set of already-admitted protected
 * candidates. Channel/producer counts are SEEDED with the protected base
 * so its slots count against non-protected candidates' quotas — prevents
 * a single channel/producer from monopolizing via both pools.
 *
 * First-wins for {@link AssemblyTrace.cappedBy}: a later skip never
 * overwrites an earlier cap reason (prevents stale diagnostics).
 *
 * Pure (returns a new array; does not mutate input).
 */
function applyQuotas(
  protectedBase: readonly CandidateEnvelope[],
  nonProtected: readonly CandidateEnvelope[],
  policy: AssemblyPolicy,
): QuotaResult {
  const assembled: CandidateEnvelope[] = [...protectedBase];
  let cappedBy: AssemblyTrace['cappedBy'] | undefined;

  const channelCounts = seedChannelCounts(protectedBase);
  const producerCounts =
    policy.maxProducerSlots !== undefined
      ? seedProducerCounts(protectedBase)
      : new Map<string, number>();

  // Pre-index channel quotas as a Map so the per-candidate check is a
  // single O(channels) walk instead of O(quotas × channels) with
  // Array.prototype.includes in the inner loop.
  const quotaByChannel: ReadonlyMap<CandidateChannel, number> | undefined =
    policy.channelQuotas !== undefined
      ? new Map(policy.channelQuotas.map((cq) => [cq.channel, cq.maxSlots]))
      : undefined;

  const maxTotal = policy.maxTotal;
  for (const c of nonProtected) {
    if (assembled.length >= maxTotal) {
      cappedBy = 'maxTotal';
      break;
    }

    // Channel quota check
    if (quotaByChannel !== undefined) {
      const blocked = isBlockedByChannelQuota(c, quotaByChannel, channelCounts);
      if (blocked) {
        cappedBy ??= 'channelQuota';
        continue;
      }
    }

    // Producer slot check.
    // Use the indexed `producer` field from the underlying HybridCandidate
    // (sourced from Vespa's `producer` projection). Candidates with no
    // producer metadata bypass the cap — lack of metadata must never
    // penalize a candidate (mirrors DefaultRankingPolicy diversity).
    if (policy.maxProducerSlots !== undefined) {
      const producerKey = c.legacyCandidate.producer;
      if (producerKey !== undefined && producerKey.length > 0) {
        const count = producerCounts.get(producerKey) ?? 0;
        if (count >= policy.maxProducerSlots) {
          cappedBy ??= 'producerSlot';
          continue;
        }
        producerCounts.set(producerKey, count + 1);
      }
    }

    // Update channel counts only after admit.
    for (const ch of c.provenance.channels) {
      channelCounts.set(ch, (channelCounts.get(ch) ?? 0) + 1);
    }
    assembled.push(c);
  }

  return { assembled, cappedBy };
}

/** Seed channel-slot counters with protected candidates' channel memberships. */
function seedChannelCounts(
  protectedBase: readonly CandidateEnvelope[],
): Map<CandidateChannel, number> {
  const counts = new Map<CandidateChannel, number>();
  for (const c of protectedBase) {
    for (const ch of c.provenance.channels) {
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
  }
  return counts;
}

/** Seed producer-slot counters with protected candidates' producer keys. */
function seedProducerCounts(
  protectedBase: readonly CandidateEnvelope[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of protectedBase) {
    const producerKey = c.legacyCandidate.producer;
    if (producerKey !== undefined && producerKey.length > 0) {
      counts.set(producerKey, (counts.get(producerKey) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Return true if any of the candidate's channels has already hit its
 * quota. Walks the candidate's channels once.
 */
function isBlockedByChannelQuota(
  candidate: CandidateEnvelope,
  quotaByChannel: ReadonlyMap<CandidateChannel, number>,
  channelCounts: ReadonlyMap<CandidateChannel, number>,
): boolean {
  for (const ch of candidate.provenance.channels) {
    const maxSlots = quotaByChannel.get(ch);
    if (maxSlots === undefined) continue;
    const count = channelCounts.get(ch) ?? 0;
    if (count >= maxSlots) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Assembler (public surface — unchanged signatures)
// ---------------------------------------------------------------------------

export class CandidateAssembler {
  /**
   * Assemble a final candidate set from a multi-channel pool.
   *
   * @param candidates - All candidates from all channels (may contain duplicates by entityId).
   * @param policy     - Assembly policy governing quotas and protection.
   */
  assemble(
    candidates: readonly CandidateEnvelope[],
    policy: AssemblyPolicy,
  ): AssemblyResult {
    const inputCount = candidates.length;

    const hardFiltered = applyHardFilters(candidates);
    const afterHardFilter = hardFiltered.length;

    const deduped = dedupeByEntityIdWithNaNSafeMax(hardFiltered);
    const afterDedup = deduped.length;

    const sorted = sortWithTiebreaker(deduped);

    const { protected_, nonProtected } = splitProtectedAndNonProtected(sorted, policy);
    const protectedCount = protected_.length;

    const { assembled, cappedBy } = applyQuotas(protected_, nonProtected, policy);

    // Re-sort: protected candidates may have lower scores than admitted
    // non-protected ones — final output order is by fusionScore desc with
    // NaN-safe + entityId tiebreaker. (Bugbash R22.)
    const finalSorted = sortWithTiebreaker(assembled);

    return {
      candidates: finalSorted,
      trace: {
        inputCount,
        afterHardFilter,
        afterDedup,
        protectedCount,
        outputCount: finalSorted.length,
        ...(cappedBy !== undefined ? { cappedBy } : {}),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Test-only internals (DO NOT import from production code)
// ---------------------------------------------------------------------------

/**
 * File-private helpers exposed strictly for unit testing. Production
 * code must depend on {@link CandidateAssembler} only. Reorganizing the
 * internal pipeline is allowed at any time — these exports are not part
 * of the stable API.
 */
export const __internals = {
  applyHardFilters,
  dedupeByEntityIdWithNaNSafeMax,
  sortWithTiebreaker,
  splitProtectedAndNonProtected,
  applyQuotas,
} as const;
