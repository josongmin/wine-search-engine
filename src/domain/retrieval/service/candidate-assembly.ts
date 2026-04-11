/**
 * T3.3: Structured Assembly Layer
 *
 * CandidateAssembler: merges candidates from multiple retrieval channels
 * into a bounded, diverse final set according to AssemblyPolicy.
 *
 * Algorithm (5 steps):
 * 1. Apply hard filters: remove candidates that fail hard constraints.
 * 2. Dedup by entityId, keeping the highest fusionScore among valid candidates.
 * 3. Sort by fusionScore descending.
 * 4. Apply protected recall: ensure protected candidates survive.
 * 5. Apply quotas and maxTotal cap.
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

export interface AssemblyResult {
  readonly candidates: readonly CandidateEnvelope[];
  readonly trace: AssemblyTrace;
}

export interface AssemblyTrace {
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
// Assembler
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

    // --- Step 1: Remove candidates with failed hard constraints ---
    //
    // Exception: candidates with a protectedInclusionReason (sparse rank 1 /
    // anchor_conditioned / exact_alias_match) survive even if they have failed
    // hard constraints. The ranker's coarse prune (hardConstraintPass →
    // -Infinity) is the authoritative precision gate for these — they will be
    // demoted by score rather than silently dropped before the ranker sees them.
    //
    // Without this exception, applyProtectedRecallPolicy() (Step 6b in
    // candidate-pool) correctly marks known_item and anchor candidates, but
    // assembly Step 1 immediately removes them because failedHardConstraints
    // is non-empty — the protection is rendered meaningless.
    const hardFiltered = candidates.filter(
      (c) =>
        c.provenance.protectedInclusionReason !== undefined ||
        c.provenance.failedHardConstraints === undefined ||
        c.provenance.failedHardConstraints.length === 0,
    );
    const afterHardFilter = hardFiltered.length;

    // --- Step 2: Dedup by entityId, keeping highest fusionScore among valid candidates ---
    //
    // Group by entityId, then pick the canonical envelope per group via
    // pickMaxByScore: NaN scores treated as -Infinity, ties broken by a
    // stable secondary key (fusion profile name). Previously this used a
    // strict `>` comparison whose winner depended on retrieval-channel
    // arrival order — not deterministic. (Bugbash R19 critical re-audit)
    const groupsByEntityId = new Map<string, CandidateEnvelope[]>();
    for (const c of hardFiltered) {
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
    const afterDedup = deduped.length;

    // --- Step 3: Sort by fusionScore descending with deterministic tiebreaker ---
    // Use compareScoreWithTiebreaker so equal-score candidates preserve a
    // stable order (entityId lexicographic) instead of insertion order.
    deduped.sort(
      compareScoreWithTiebreaker<CandidateEnvelope>(
        (c) => c.provenance.fusionScore,
        (c) => c.entityId,
      ),
    );
    const sorted = deduped;

    // --- Step 4: Separate protected and non-protected candidates ---
    // Single pass: previously called isProtected twice per candidate (once
    // per filter call) which also double-allocated closure scopes. Walking
    // `sorted` once and pushing into two arrays halves the per-candidate
    // predicate evaluations and is O(n) vs 2×O(n).
    const protectExactMatches = policy.protectExactMatches;
    const protectAnchorConditioned = policy.protectAnchorConditioned;
    const protected_: CandidateEnvelope[] = [];
    const nonProtected: CandidateEnvelope[] = [];
    for (const c of sorted) {
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
    const protectedCount = protected_.length;

    // --- Step 5: Build final set applying quotas ---
    const assembled: CandidateEnvelope[] = [...protected_];
    let cappedBy: AssemblyTrace['cappedBy'] | undefined;

    // Channel quota tracking — seed with protected candidates so their
    // channel slots count against non-protected candidates' quotas.
    const channelCounts = new Map<CandidateChannel, number>();
    for (const c of protected_) {
      for (const ch of c.provenance.channels) {
        channelCounts.set(ch, (channelCounts.get(ch) ?? 0) + 1);
      }
    }

    // Producer slot tracking: uses the `producer` field from
    // legacyCandidate (Vespa projection), not channel raw signals.
    // Full producer diversity logic would require knowledge of entity relationships;
    // here we use a simple first-producer-wins approach.
    const producerCounts = new Map<string, number>();
    // Seed producerCounts with protected candidates so they count against
    // maxProducerSlots for non-protected candidates — prevents a single producer
    // from dominating via both protected and non-protected slots.
    if (policy.maxProducerSlots !== undefined) {
      for (const c of protected_) {
        const producerKey = c.legacyCandidate.producer;
        if (producerKey !== undefined && producerKey.length > 0) {
          producerCounts.set(producerKey, (producerCounts.get(producerKey) ?? 0) + 1);
        }
      }
    }

    const maxTotal = policy.maxTotal;
    // Pre-index channel quotas as a Map so the per-candidate check is a
    // single O(channels) walk instead of O(quotas × channels) with
    // Array.prototype.includes in the inner loop.
    const quotaByChannel: ReadonlyMap<CandidateChannel, number> | undefined =
      policy.channelQuotas !== undefined
        ? new Map(policy.channelQuotas.map((cq) => [cq.channel, cq.maxSlots]))
        : undefined;

    for (const c of nonProtected) {
      if (assembled.length >= maxTotal) {
        cappedBy = 'maxTotal';
        break;
      }

      // Channel quota check
      if (quotaByChannel !== undefined) {
        let blockedByQuota = false;
        for (const ch of c.provenance.channels) {
          const maxSlots = quotaByChannel.get(ch);
          if (maxSlots === undefined) continue;
          const count = channelCounts.get(ch) ?? 0;
          if (count >= maxSlots) {
            blockedByQuota = true;
            // Only record the first cap reason — later skips may overwrite with a
            // stale reason even when the set has room for more candidates, corrupting
            // trace diagnostics. (Bug: last-write-wins produced wrong cap reason.)
            cappedBy ??= 'channelQuota';
            break;
          }
        }
        if (blockedByQuota) continue;
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
            // Same first-wins semantics as channelQuota above — don't overwrite
            // an already-set cap reason with a later producerSlot skip.
            cappedBy ??= 'producerSlot';
            continue;
          }
          producerCounts.set(producerKey, count + 1);
        }
      }

      // Update channel counts
      for (const ch of c.provenance.channels) {
        channelCounts.set(ch, (channelCounts.get(ch) ?? 0) + 1);
      }

      assembled.push(c);
    }

    // Re-sort assembled by fusionScore (protected candidates may have lower
    // scores) with NaN-safe + entityId tiebreaker so output order is stable.
    // (Bugbash R22)
    assembled.sort(
      compareScoreWithTiebreaker<CandidateEnvelope>(
        (c) => c.provenance.fusionScore,
        (c) => c.entityId,
      ),
    );

    return {
      candidates: assembled,
      trace: {
        inputCount,
        afterHardFilter,
        afterDedup,
        protectedCount,
        outputCount: assembled.length,
        ...(cappedBy !== undefined ? { cappedBy } : {}),
      },
    };
  }
}

