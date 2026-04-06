import { describe, it, expect } from 'vitest';
import { AbstainPolicy } from '../abstain-policy.js';

describe('AbstainPolicy', () => {
  const policy = new AbstainPolicy(0.82, 3);

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
