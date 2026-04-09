/**
 * RFC-013 S3 -- Calibrated entropy abstain.
 * Computes normalized Shannon entropy over top-K retrieval scores.
 * If entropy exceeds threshold, the engine abstains and requests clarification.
 */

export type AbstainDecision =
  | { readonly abstain: false; readonly entropy?: number }
  | { readonly abstain: true; readonly entropy: number };

export class AbstainPolicy {
  constructor(
    /** Normalized Shannon entropy threshold above which retrieval scores are
     *  considered indistinguishable (engine should abstain and request
     *  clarification). 0.82 = "top-K scores are ~82% as uniform as a perfectly
     *  flat distribution". Calibrated on 200-query gold set (RFC-013 §3):
     *  precision@3 drops below 0.5 above this cutoff. */
    private readonly entropyThreshold: number = 0.82,
    /** Minimum candidates required before entropy is meaningful. With <3
     *  candidates entropy is dominated by sampling noise, not true ambiguity. */
    private readonly minCandidates: number = 3,
  ) {}

  shouldAbstain(scores: readonly number[]): AbstainDecision {
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
