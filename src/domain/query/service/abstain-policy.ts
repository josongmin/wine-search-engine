/**
 * RFC-013 S3 -- Calibrated entropy abstain.
 * Computes normalized Shannon entropy over top-K retrieval scores.
 * If entropy exceeds threshold, the engine abstains and requests clarification.
 */

export type AbstainDecision =
  | { readonly abstain: false; readonly entropy?: number; readonly reason?: string }
  | { readonly abstain: true; readonly entropy: number };

/** Context passed to shouldAbstain to influence gate behaviour. */
export interface AbstainContext {
  /**
   * Whether an LTR model is currently active for scoring.
   *
   * RCA-01: The entropy gate is designed for LTR logit scores which have
   * wide spread (~5-10 range). Heuristic linear scores are clamped to [0,1]
   * and cluster tightly in [0.2, 0.6], producing entropy ≈ 0.999 regardless
   * of threshold. Setting ltrAvailable=false bypasses the gate entirely,
   * reducing ambiguous rate from 83% → <20% in heuristic-only environments.
   */
  readonly ltrAvailable: boolean;
}

export class AbstainPolicy {
  constructor(
    /** Normalized Shannon entropy threshold above which retrieval scores are
     *  considered indistinguishable (engine should abstain and request
     *  clarification). 0.95 = "top-K scores are ~95% as uniform as a perfectly
     *  flat distribution". Raised from 0.82 (RCA5-01: the 0.82 threshold was
     *  mathematically impossible to clear without LTR/reranker — default score
     *  spread of 0.15-0.25 across top-10 produces entropy ~0.87, so 83% of
     *  queries abstained. 0.95 requires near-completely-flat score distribution
     *  before abstaining). Calibrated on 200-query gold set (RFC-013 §3):
     *  precision@3 drops below 0.5 above this cutoff. */
    private readonly entropyThreshold: number = 0.95,
    /** Minimum candidates required before entropy is meaningful. With <3
     *  candidates entropy is dominated by sampling noise, not true ambiguity. */
    private readonly minCandidates: number = 3,
  ) {}

  shouldAbstain(scores: readonly number[], context?: AbstainContext): AbstainDecision {
    // RCA-01: heuristic scores always produce entropy > 0.95 regardless of
    // threshold. Bypass the gate entirely when LTR is not available so the
    // engine can return results instead of abstaining 83% of the time.
    if (context?.ltrAvailable === false) {
      return { abstain: false, reason: 'ltr_unavailable_entropy_bypass' };
    }

    if (scores.length < this.minCandidates) {
      return { abstain: false };
    }
    const entropy = this.normalizedEntropy(scores);
    if (entropy >= this.entropyThreshold) {
      return { abstain: true, entropy };
    }
    return { abstain: false, entropy };
  }

  private normalizedEntropy(scores: readonly number[]): number {
    // Early guard: empty or single-element distributions have entropy 0 by
    // definition. Without this, intermediate steps below produce NaN
    // (e/sumExp where sumExp=0) that propagates silently. (Bugbash R17)
    if (scores.length < 2) return 0;
    let maxScore = -Infinity;
    for (const s of scores) { if (s > maxScore) maxScore = s; }
    const expScores = scores.map((s) => Math.exp(s - maxScore));
    const sumExp = expScores.reduce((a, b) => a + b, 0);
    if (sumExp === 0) return 0;
    const probs = expScores.map((e) => e / sumExp);
    const rawEntropy = probs.reduce((h, p) => (p <= 0 ? h : h - p * Math.log2(p)), 0);
    const maxEntropy = Math.log2(scores.length);
    return maxEntropy > 0 ? rawEntropy / maxEntropy : 0;
  }
}
