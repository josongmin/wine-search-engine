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
    private readonly entropyThreshold: number = 0.82,
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
    const maxScore = Math.max(...scores);
    const expScores = scores.map((s) => Math.exp(s - maxScore));
    const sumExp = expScores.reduce((a, b) => a + b, 0);
    const probs = expScores.map((e) => e / sumExp);
    const rawEntropy = probs.reduce((h, p) => (p <= 0 ? h : h - p * Math.log2(p)), 0);
    const maxEntropy = Math.log2(scores.length);
    return maxEntropy > 0 ? rawEntropy / maxEntropy : 0;
  }
}
