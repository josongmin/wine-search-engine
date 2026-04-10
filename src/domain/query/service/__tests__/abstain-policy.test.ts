import { describe, it, expect } from 'vitest';
import { AbstainPolicy, type AbstainContext } from '../abstain-policy.js';

describe('AbstainPolicy', () => {
  const policy = new AbstainPolicy(0.82, 3);

  it('default threshold (0.95) does not abstain when one candidate clearly dominates', () => {
    // RCA5-01 regression: the old default threshold of 0.82 was too aggressive.
    // The new default 0.95 still abstains on near-uniform distributions (correct),
    // but should pass when there is a genuinely dominant candidate.
    const defaultPolicy = new AbstainPolicy(); // uses default threshold=0.95
    // One dominant score (10) vs the rest (0.1) produces entropy ≈ 0.002 — clearly passes.
    const clearWinnerScores = [10.0, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1];
    const result = defaultPolicy.shouldAbstain(clearWinnerScores);
    expect(result.abstain).toBe(false);
  });

  it('default threshold (0.95) still abstains on near-uniform distributions', () => {
    // Verify that the gate still fires for genuinely ambiguous result sets.
    const defaultPolicy = new AbstainPolicy();
    const uniformScores = [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0];
    const result = defaultPolicy.shouldAbstain(uniformScores);
    expect(result.abstain).toBe(true);
  });

  it('uniform scores → high entropy → abstain', () => {
    // All identical scores produce maximum entropy (= 1.0).
    const scores = [1.0, 1.0, 1.0, 1.0, 1.0];
    const result = policy.shouldAbstain(scores);
    expect(result.abstain).toBe(true);
    expect(result.entropy).toBeGreaterThanOrEqual(0.82);
  });

  it('one dominant score → low entropy → no abstain', () => {
    // One very high score, rest near zero → entropy well below threshold.
    const scores = [10.0, 0.01, 0.01, 0.01, 0.01];
    const result = policy.shouldAbstain(scores);
    expect(result.abstain).toBe(false);
  });

  it('fewer than minCandidates → no abstain', () => {
    // Only 2 candidates, below the minimum of 3.
    const scores = [1.0, 1.0];
    const result = policy.shouldAbstain(scores);
    expect(result.abstain).toBe(false);
  });
});

// RCA-01: heuristic scores produce entropy ≈ 0.9993 — gate mathematically always fires.
// Fix: bypass entropy gate entirely when ltrAvailable === false.
// Without bypass: 83% of queries abstain even with threshold=0.95.
describe('AbstainPolicy — ltrAvailable bypass (RCA-01)', () => {
  // Heuristic score cluster that always produces entropy > 0.95
  // (tight range [0.2, 0.6] → softmax flattens → entropy ≈ 0.999)
  const HEURISTIC_SCORES = [0.55, 0.50, 0.48, 0.45, 0.43, 0.41, 0.39, 0.37, 0.35, 0.30];

  it('bypasses gate and does NOT abstain when ltrAvailable=false', () => {
    const p = new AbstainPolicy();
    const ctx: AbstainContext = { ltrAvailable: false };
    const result = p.shouldAbstain(HEURISTIC_SCORES, ctx);
    expect(result.abstain).toBe(false);
    expect((result as { reason?: string }).reason).toBe('ltr_unavailable_entropy_bypass');
  });

  it('returns reason="ltr_unavailable_entropy_bypass" when bypassed', () => {
    const p = new AbstainPolicy();
    const result = p.shouldAbstain(HEURISTIC_SCORES, { ltrAvailable: false });
    expect((result as { reason?: string }).reason).toBe('ltr_unavailable_entropy_bypass');
  });

  it('still applies entropy gate when ltrAvailable=true (heuristic scores abstain)', () => {
    const p = new AbstainPolicy();
    // With LTR available the gate is active — heuristic scores have entropy ≈ 0.999 > 0.95
    const result = p.shouldAbstain(HEURISTIC_SCORES, { ltrAvailable: true });
    expect(result.abstain).toBe(true);
  });

  it('backward-compatible: no context arg behaves as ltrAvailable=true (gate active)', () => {
    const p = new AbstainPolicy();
    const resultNoCtx = p.shouldAbstain(HEURISTIC_SCORES);
    const resultWithTrue = p.shouldAbstain(HEURISTIC_SCORES, { ltrAvailable: true });
    expect(resultNoCtx.abstain).toBe(resultWithTrue.abstain);
  });

  it('uniform scores with ltrAvailable=false still bypass (gate is fully off)', () => {
    const p = new AbstainPolicy();
    const uniform = [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0];
    const result = p.shouldAbstain(uniform, { ltrAvailable: false });
    expect(result.abstain).toBe(false);
  });
});
