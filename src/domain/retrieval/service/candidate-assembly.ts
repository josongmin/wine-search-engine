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
    const hardFiltered = candidates.filter(
      (c) =>
        c.provenance.failedHardConstraints === undefined ||
        c.provenance.failedHardConstraints.length === 0,
    );
    const afterHardFilter = hardFiltered.length;

    // --- Step 2: Dedup by entityId, keeping highest fusionScore among valid candidates ---
    const byEntityId = new Map<string, CandidateEnvelope>();
    for (const c of hardFiltered) {
      const existing = byEntityId.get(c.entityId);
      if (existing === undefined || c.provenance.fusionScore > existing.provenance.fusionScore) {
        byEntityId.set(c.entityId, c);
      }
    }
    const deduped = [...byEntityId.values()];
    const afterDedup = deduped.length;

    // --- Step 3: Sort by fusionScore descending ---
    const sorted = [...deduped].sort(
      (a, b) => b.provenance.fusionScore - a.provenance.fusionScore,
    );

    // --- Step 4: Separate protected and non-protected candidates ---
    const isProtected = (c: CandidateEnvelope): boolean => {
      if (policy.protectExactMatches && c.provenance.protectedInclusionReason !== undefined) {
        return true;
      }
      if (policy.protectAnchorConditioned && c.provenance.anchorConditioned) {
        return true;
      }
      return false;
    };

    const protected_ = sorted.filter(isProtected);
    const nonProtected = sorted.filter((c) => !isProtected(c));
    const protectedCount = protected_.length;

    // --- Step 5: Build final set applying quotas ---
    const assembled: CandidateEnvelope[] = [...protected_];
    let cappedBy: AssemblyTrace['cappedBy'] | undefined;

    // Channel quota tracking
    const channelCounts = new Map<CandidateChannel, number>();

    // Producer slot tracking (by first channel's raw match — use entityId prefix heuristic)
    // Full producer diversity logic would require knowledge of entity relationships;
    // here we use a simple first-producer-wins approach.
    const producerCounts = new Map<string, number>();

    const remainingBudget = () => policy.maxTotal - assembled.length;

    for (const c of nonProtected) {
      if (remainingBudget() <= 0) {
        cappedBy = 'maxTotal';
        break;
      }

      // Channel quota check
      if (policy.channelQuotas !== undefined) {
        let blockedByQuota = false;
        for (const cq of policy.channelQuotas) {
          if (c.provenance.channels.includes(cq.channel)) {
            const count = channelCounts.get(cq.channel) ?? 0;
            if (count >= cq.maxSlots) {
              blockedByQuota = true;
              cappedBy = 'channelQuota';
              break;
            }
          }
        }
        if (blockedByQuota) continue;
      }

      // Producer slot check
      if (policy.maxProducerSlots !== undefined) {
        // Derive a "producer key" from entityId prefix (e.g. "prod:123:" prefix pattern)
        // In the real system this would use entity metadata; here we use a heuristic.
        const producerKey = extractProducerKey(c.entityId);
        const count = producerCounts.get(producerKey) ?? 0;
        if (count >= policy.maxProducerSlots) {
          cappedBy = 'producerSlot';
          continue;
        }
        producerCounts.set(producerKey, count + 1);
      }

      // Update channel counts
      for (const ch of c.provenance.channels) {
        channelCounts.set(ch, (channelCounts.get(ch) ?? 0) + 1);
      }

      assembled.push(c);
    }

    // Re-sort assembled by fusionScore (protected candidates may have lower scores)
    assembled.sort((a, b) => b.provenance.fusionScore - a.provenance.fusionScore);

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

/**
 * Extract a producer key from an entityId for diversity slot counting.
 * Format: "prod:{id}:*" → "prod:{id}" if producer-prefixed; else return entityId directly.
 */
function extractProducerKey(entityId: string): string {
  const match = /^(prod:\d+):/.exec(entityId);
  return match?.[1] ?? entityId;
}
